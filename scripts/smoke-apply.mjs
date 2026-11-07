/**
 * startDoctor 集成冒烟：在 /tmp 夹具 home 上驱动完整生命周期（不经真实 ~/.agents-anywhere）。
 * 覆盖三种判定 × 对应动作路径 + 卸载清理。
 *   ① healthy  → 检查正常日志，无恢复动作
 *   ② wedged   → 检测到 wedged + 仅提醒跳过（模式未开启）
 *   ③ exited   → 自动拉起开启，但夹具缺 connector-source → 预期"恢复失败"日志（证明路径走到恢复）
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL('lib/index.js').href)

function makeFixtureHome(tag, { pid, failures, now = Date.now() }) {
  const home = fs.mkdtempSync(path.join('/tmp', `doctor-smoke-${tag}-`))
  const aa = path.join(home, '.agents-anywhere')
  fs.mkdirSync(path.join(aa, 'logs'), { recursive: true })
  fs.mkdirSync(path.join(aa, 'dsh-bridge-next', 'logs'), { recursive: true })
  fs.writeFileSync(
    path.join(aa, 'connector-runtime.json'),
    JSON.stringify({ runtime: { pid, kind: 'dsh-plugin', connectorId: 'conn_fixture' } }),
  )
  const iso = (t) => new Date(t).toISOString()
  const lines = []
  for (let i = 0; i < failures; i++) {
    const t = now - i * 63_000
    lines.push(
      JSON.stringify([
        {
          source: 'connector',
          record: {
            time: iso(t),
            level: 'WARNING',
            name: 'connector.server.client',
            message: `connector backend network unavailable error=backend authentication request failed: ; reconnecting in 3.0s`,
          },
        },
      ]),
    )
  }
  lines.push(
    JSON.stringify([
      {
        source: 'connector',
        record: { time: iso(now), level: 'INFO', name: 'connector.server.rpc', message: 'connector websocket frame sent type=notification method=connector.heartbeat' },
      },
    ]),
  )
  fs.writeFileSync(path.join(aa, 'logs', 'runtime-00000000000000000001.jsonl'), lines.join('\n') + '\n')
  return home
}

function readLog(home, tag) {
  const f = path.join(home, '.agents-anywhere', 'bridge-doctor', 'bridge-doctor.log')
  const content = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '(日志文件未创建)'
  logsByTag[tag] = content
  return content
}

const baseConfig = {
  enabled: true,
  pollSeconds: 10,
  failureThreshold: 5,
  windowMinutes: 5,
  cooldownMinutes: 60,
  maxRestartsPerDay: 6,
  checkDeviceApi: false,
}

// 常驻的"存活进程"：睡 300 秒，够冒烟用
const sleeper = spawn('sleep', ['300'], { stdio: 'ignore' })
const results = []
const logsByTag = {}

try {
  // ① healthy
  {
    const home = makeFixtureHome('healthy', { pid: sleeper.pid, failures: 0 })
    const dispose = mod.startDoctor({ ...baseConfig, autoRestartExited: true, autoRestartWedged: false }, (await import('../src/host/paths.js')).aaPaths(home))
    await new Promise((r) => setTimeout(r, 11_000))
    dispose()
    const log = readLog(home, 'healthy')
    results.push([
      '① healthy: 启动+检查正常+无恢复动作',
      log.includes('Bridge Doctor 启动') && (log.includes('检查正常') || log.includes('恢复正常')) && !log.includes('恢复结果'),
      log.split('\n').filter((l) => l.includes('检查正常') || l.includes('恢复正常')).length >= 1,
    ])
    fs.rmSync(home, { recursive: true, force: true })
  }

  // ② wedged（仅提醒）
  {
    const home = makeFixtureHome('wedged', { pid: sleeper.pid, failures: 8 })
    const dispose = mod.startDoctor({ ...baseConfig, autoRestartExited: true, autoRestartWedged: false }, (await import('../src/host/paths.js')).aaPaths(home))
    await new Promise((r) => setTimeout(r, 11_000))
    dispose()
    const log = readLog(home, 'wedged')
    results.push([
      '② wedged: 检出 + 仅提醒跳过（模式未开启）',
      log.includes('检测到 wedged') && log.includes('跳过（模式未开启）') && !log.includes('处理：重启卡死'),
    ])
    fs.rmSync(home, { recursive: true, force: true })
  }

  // ③ exited（自动拉起开启，但夹具无源码 → 预期恢复失败日志 = 路径走到恢复）
  {
    const home = makeFixtureHome('exited', { pid: 999_999_999, failures: 0 })
    const dispose = mod.startDoctor({ ...baseConfig, autoRestartExited: true }, (await import('../src/host/paths.js')).aaPaths(home))
    await new Promise((r) => setTimeout(r, 11_000))
    dispose()
    const log = readLog(home, 'exited')
    results.push([
      '③ exited: 检出 + 走到恢复路径（夹具缺源码，预期失败）',
      log.includes('检测到 exited') && log.includes('恢复结果: 失败') && log.includes('connector-source'),
    ])
    fs.rmSync(home, { recursive: true, force: true })
  }
} finally {
  sleeper.kill('SIGKILL')
}

console.log('\n===== startDoctor 集成冒烟结果 =====')
let pass = true
const tags = ['healthy', 'wedged', 'exited']
for (let i = 0; i < results.length; i++) {
  const [name, ok] = results[i]
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok) {
    pass = false
    console.log(`    [夹具日志]\n${(logsByTag[tags[i]] || '(无)').split('\n').map(l => '    | ' + l).join('\n')}`)
  }
}
console.log(pass ? '\n✅ 集成冒烟全部通过' : '\n❌ 集成冒烟存在失败')
process.exit(pass ? 0 : 1)
