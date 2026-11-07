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
  // 假 uv（真实二进制）：把当前 node 复制为 <aa>/bin/uv，配 agent.js 模拟 Connector 行为。
  // 身份校验的 comm 因子要求可执行文件锚定本机安装（===发现的 uv 或位于 ~/.agents-anywhere），
  // 解释器脚本（shebang）的 comm 是系统解释器路径、无法锚定——所以必须用真实二进制。
  // argv 由 agent.js 的参数还原官方拉起形态（run --directory <src> anywhere-cli rpc --config <cfg>）。
  fs.mkdirSync(path.join(aa, 'bin'), { recursive: true })
  const uvBin = path.join(aa, 'bin', 'uv')
  fs.copyFileSync(process.execPath, uvBin)
  fs.chmodSync(uvBin, 0o755)
  // 假 uv = 当前 node 的二进制副本（node 携带有效签名，复制后可执行；
  // 系统二进制如 /usr/bin/yes 复制后会被 macOS 代码签名 SIGKILL——实测踩坑）。
  // comm 因子：exec 路径即 <aa>/bin/uv（.agents-anywhere 树内 + 基名 uv）✓
  // 存活机制：NODE_OPTIONS --require scripts/__fixture_preload.cjs（静态文件，见场景②）。
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
  const preloadFlag = path.join(aa, 'fake-uv-invocations.log')
  return {
    home,
    paths,
    uvBin,
    preloadFlag,
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
    // 预载必须在生成 oldProc 之前启用：node 副本的主模块 'run' 不存在，
    // 无预载会在 ~100ms 内 ENOENT 死亡；预载阻塞后 oldProc 与 healer 的
    // 标准 argv 拉起（③ 同理）都与真实 Connector 一样长驻
    const staticPreload = path.join(path.dirname(new URL(import.meta.url).pathname), '__fixture_preload.cjs')
    process.env.NODE_OPTIONS = `--require ${staticPreload}`
    process.env.DOCTOR_SMOKE_FLAG = fx.preloadFlag
    const oldProc = spawn(fx.uvBin, ['run', '--directory', fx.sourceDir, 'anywhere-cli', 'rpc', '--config', fx.configPath], { stdio: 'ignore' })
    cleanupProcs.push(oldProc)
    await new Promise((r) => setTimeout(r, 500))
    const outcome = await healer.restartWedged(oldProc.pid, 'dsh-plugin')
    const oldDead = await waitDead(oldProc.pid)
    await new Promise((r) => setTimeout(r, 800))
    const marker = fs.existsSync(fx.marker) ? fs.readFileSync(fx.marker, 'utf8') : null
    const markerLines = marker ? marker.trim().split('\n').length : 0
    const newAlive = outcome.pid ? alive(outcome.pid) : false
    const ok = outcome.ok && oldDead && newAlive && outcome.pid !== undefined
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
    const ok = outcome.ok && outcome.pid !== undefined && newAlive
    results.push([
      '③ exited: 返回新 pid + 新进程存活（yes 副本经标准 argv 拉起）',
      ok,
      `outcome=${JSON.stringify(outcome)} marker=${marker ? '有' : '无'} newAlive=${newAlive}`,
    ])
    if (outcome.pid) cleanupProcs.push({ kill: () => process.kill(outcome.pid, 'SIGKILL') })
  }
  // ②③ 结束：关闭 NODE_OPTIONS 预载（⑤ 依赖"启动即死"，node 找不到主模块需能正常退出）
  delete process.env.NODE_OPTIONS

  // ④ 身份拒绝：无辜进程（sleep）不具 Connector 形态 → 防御中止、毫发无损（评审 #2/#3 路径）
  {
    const fx = makeFixture('guard', 8)
    const healer = new Healer(fx.paths, (l) => console.log(`    [log] ${l}`), fx.uvBin)
    const innocent = spawn('sleep', ['300'], { stdio: 'ignore' })
    cleanupProcs.push(innocent)
    await new Promise((r) => setTimeout(r, 500))
    const outcome = await healer.restartWedged(innocent.pid, 'dsh-plugin')
    const untouched = alive(innocent.pid)
    const ok = outcome.ok === false && outcome.detail.includes('防御中止') && untouched
    results.push([
      '④ 身份拒绝: 无辜进程毫发无损（token 级形态匹配 + Fail 顺序）',
      ok,
      `outcome=${JSON.stringify(outcome)} 目标仍存活=${untouched}`,
    ])
  }

  // ⑤ 拉起后即死 → 8 秒存活验证拦截（评审 #3：拉起≠恢复）
  {
    const fx = makeFixture('verify-die', 0)
    // 假 uv 变体：记录参数后立即退出（模拟启动即崩）——同样用真实二进制锚定 comm
    const diesUv = path.join(fx.home, '.agents-anywhere', 'bin', 'uv-dies')
    fs.copyFileSync(process.execPath, diesUv)
    fs.chmodSync(diesUv, 0o755)
    // diesUv 是复制的 node：healer 以标准 argv（run --directory …）拉起时，
    // node 找不到 'run' 模块会立即退出——这正是"启动即死"，由 8 秒验证窗口拦截
    const healer = new Healer(fx.paths, (l) => console.log(`    [log] ${l}`), diesUv)
    const outcome = await healer.relaunchExited('dsh-plugin')
    const ok = outcome.ok === false && outcome.detail.includes('s 内退出') && (outcome.pid === undefined || !alive(outcome.pid))
    results.push([
      '⑤ 存活验证: 启动即死的进程被 8 秒窗口判为恢复失败',
      ok,
      `outcome=${JSON.stringify(outcome)}`,
    ])
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
