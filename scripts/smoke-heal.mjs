/**
 * 核心恢复机制密闭冒烟：真实地"杀掉一个存活进程 → 重新拉起"。
 * 夹具：假 uv（记录参数后 exec sleep 300 模拟长驻 Connector）+ 假 connector-source/config。
 * 覆盖：② wedged（SIGTERM→重启，旧死新生）③ exited（无人拉起→重新拉起）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL('lib/index.js').href)
const { Healer } = await import(pathToFileURL('lib/healer.js').href)
const { aaPaths } = await import(pathToFileURL('lib/paths.js').href)

const results = []
const cleanupProcs = []
const cleanupDirs = []

function makeFixture(tag, wedgeFailures) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `doctor-heal-${tag}-`))
  const aa = path.join(home, '.agents-anywhere')
  // 假 connector-source：connector/cli.py + connector.json
  const source = path.join(aa, 'dsh-bridge-next', 'connector-source', 'f4kest0ry')
  fs.mkdirSync(path.join(source, 'connector'), { recursive: true })
  fs.mkdirSync(path.join(aa, 'dsh-bridge-next', 'connector'), { recursive: true })
  fs.writeFileSync(path.join(source, 'connector', 'cli.py'), '# fixture\n')
  fs.writeFileSync(
    path.join(aa, 'dsh-bridge-next', 'connector', 'connector.json'),
    JSON.stringify({ serverUrl: 'http://127.0.0.1:1', connectorId: 'conn_fixture', statePath: '' }),
  )
  // 假 uv：记录参数 → exec sleep 300（模拟长驻 Connector 进程）
  const uvBin = path.join(aa, 'fake-uv')
  fs.writeFileSync(
    uvBin,
    [
      '#!/bin/bash',
      `echo "$@" >> ${JSON.stringify(path.join(aa, 'fake-uv-invocations.log'))}`,
      'exec sleep 300',
    ].join('\n'),
  )
  fs.chmodSync(uvBin, 0o755)
  // wedged 日志签名
  if (wedgeFailures > 0) {
    fs.mkdirSync(path.join(aa, 'logs'), { recursive: true })
    const lines = []
    for (let i = 0; i < wedgeFailures; i++) {
      lines.push(
        JSON.stringify([
          {
            source: 'connector',
            record: {
              time: new Date(Date.now() - i * 63_000).toISOString(),
              level: 'WARNING',
              name: 'connector.server.client',
              message: 'connector backend network unavailable error=backend authentication request failed: ; reconnecting in 3.0s',
            },
          },
        ]),
      )
    }
    fs.writeFileSync(path.join(aa, 'logs', 'runtime-00000000000000000001.jsonl'), lines.join('\n') + '\n')
  }
  cleanupDirs.push(home)
  const paths = { ...aaPaths(home) }
  return {
    home,
    paths,
    uvBin,
    sourceDir: source,
    configPath: path.join(aa, 'dsh-bridge-next', 'connector', 'connector.json'),
    marker: path.join(aa, 'fake-uv-invocations.log'),
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitDead(pid, ms = 8000) {
  const deadline = Date.now() + ms
  return new Promise((resolve) => {
    const poll = () => {
      if (!alive(pid)) return resolve(true)
      if (Date.now() > deadline) return resolve(false)
      setTimeout(poll, 300)
    }
    poll()
  })
}

async function waitMarker(marker, ms = 8000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fs.existsSync(marker)) return fs.readFileSync(marker, 'utf8')
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}

try {
  // ② wedged：真实杀掉 → 假 uv 重新拉起
  // wedged 进程以 Connector 形态运行（假 uv + anywhere-cli 参数），使 PID 防线判定其为 Connector
  {
    const fx = makeFixture('wedged', 8)
    const healer = new Healer(fx.paths, (l) => console.log(`    [log] ${l}`), fx.uvBin)
    const oldProc = spawn(fx.uvBin, ['run', '--directory', fx.sourceDir, 'anywhere-cli', 'rpc', '--config', fx.configPath], { stdio: 'ignore' })
    cleanupProcs.push(oldProc)
    await new Promise((r) => setTimeout(r, 500))
    const outcome = await healer.restartWedged(oldProc.pid, 'dsh-plugin')
    const oldDead = await waitDead(oldProc.pid)
    await new Promise((r) => setTimeout(r, 800))
    const marker = fs.existsSync(fx.marker) ? fs.readFileSync(fx.marker, 'utf8') : null
    const markerLines = marker ? marker.trim().split('\n').length : 0
    const newAlive = outcome.pid ? alive(outcome.pid) : false
    const ok =
      outcome.ok && oldDead && markerLines >= 2 && newAlive && outcome.pid !== undefined
    results.push([
      '② wedged: PID 防线放行 + SIGTERM 生效 + 假 uv 二次调用 + 新进程拉起',
      ok,
      `outcome=${JSON.stringify(outcome)} oldDead=${oldDead} markerLines=${markerLines} newAlive=${newAlive}`,
    ])
    if (outcome.pid) cleanupProcs.push({ kill: () => process.kill(outcome.pid, 'SIGKILL') })
  }

  // ③ exited：进程早已死亡 → 假 uv 重新拉起
  {
    const fx = makeFixture('exited', 0)
    const healer = new Healer(fx.paths, (l) => console.log(`    [log] ${l}`), fx.uvBin)
    const outcome = await healer.relaunchExited('dsh-plugin')
    const marker = await waitMarker(fx.marker)
    const newAlive = outcome.pid ? alive(outcome.pid) : false
    const ok = outcome.ok && outcome.pid !== undefined && marker !== null && marker.includes('--config') && newAlive
    results.push([
      '③ exited: 返回新 pid + 假 uv 被调用（--config 正确）+ 新进程存活',
      ok,
      `outcome=${JSON.stringify(outcome)} marker=${marker ? '有' : '无'} newAlive=${newAlive}`,
    ])
    if (outcome.pid) cleanupProcs.push({ kill: () => process.kill(outcome.pid, 'SIGKILL') })
  }
} finally {
  for (const p of cleanupProcs) {
    try {
      if (typeof p.kill === 'function') p.kill()
      else p.kill('SIGKILL')
    } catch {}
  }
  for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true })
}

console.log('\n===== 核心恢复机制冒烟结果 =====')
let pass = true
for (const [name, ok, detail] of results) {
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok) console.log(`    ${detail}`)
  else if (detail) console.log(`    ${detail}`)
  if (!ok) pass = false
}
console.log(pass ? '\n✅ 核心恢复机制全部验证通过' : '\n❌ 存在失败')
process.exit(pass ? 0 : 1)
