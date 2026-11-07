/**
 * 真实 cordis 运行时冒烟：用 @deepseek-ai/cordis 的 Context 引导插件（非假 ctx）。
 * 关键顺序：先完成所有模块导入，再把 HOME 重定向到夹具目录（os.homedir() 在调用时读取）。
 * 覆盖：Config 默认值、启动、wedged 检测、cordis 卸载清理。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
const aaPaths = (h) => ({ home: h, aaDir: h + '/.agents-anywhere', logsDir: h + '/.agents-anywhere/logs', runtimeRecord: h + '/.agents-anywhere/connector-runtime.json', connectorConfig: h + '/.agents-anywhere/dsh-bridge-next/connector/connector.json', accountJson: h + '/.agents-anywhere/dsh-bridge-next/account.json', connectorSourceDir: h + '/.agents-anywhere/dsh-bridge-next/connector-source', connectorOutputLog: h + '/.agents-anywhere/dsh-bridge-next/logs/connector-output.json', doctorDir: h + '/.agents-anywhere/bridge-doctor', doctorLog: h + '/.agents-anywhere/bridge-doctor/bridge-doctor.log', doctorState: h + '/.agents-anywhere/bridge-doctor/state.json' })
import { pathToFileURL } from 'node:url'

// ① 导入（此时 HOME 仍是真实 home）
const { Context } = await import('@deepseek-ai/cordis')
const mod = await import(pathToFileURL('lib/index.js').href)

// ② 夹具 home + HOME 重定向
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-cordis-home-'))
process.env.HOME = home
const aa = path.join(home, '.agents-anywhere')
fs.mkdirSync(path.join(aa, 'logs'), { recursive: true })

const sleeper = spawn('sleep', ['300'], { stdio: 'ignore' })
fs.writeFileSync(
  path.join(aa, 'connector-runtime.json'),
  JSON.stringify({ runtime: { pid: sleeper.pid, kind: 'dsh-plugin', connectorId: 'conn_fixture' } }),
)
const lines = []
for (let i = 0; i < 8; i++) {
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
fs.writeFileSync(path.join(aa, 'logs', 'runtime-1.jsonl'), lines.join('\n') + '\n')

// ③ 真实 cordis 引导（config 走 apply 内部的默认值兜底）
const ctx = new Context()
const config = {
  enabled: true,
  uvPath: '',
  autoRestartExited: false,
  autoRestartWedged: false, // 仅提醒
  failureThreshold: 5,
  windowMinutes: 5,
  cooldownMinutes: 60,
  maxRestartsPerDay: 6,
  pollSeconds: 10,
  checkDeviceApi: false,
}
console.log('[cordis-smoke] ctx.plugin(apply, config)…')
const fiber = ctx.plugin(mod.apply, config)
console.log('[cordis-smoke] 已引导（fiber:', fiber?.constructor?.name + '），等 12s…')
await new Promise((r) => setTimeout(r, 12_000))

const logFile = path.join(aa, 'bridge-doctor', 'bridge-doctor.log')
const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(无)'

const started = log.includes('Bridge Doctor 启动')
const detected = log.includes('检测到 wedged') && log.includes('跳过（模式未开启）')
const noHeal = !log.includes('恢复结果')

// ④ 卸载语义验证：cordis 的 fiber.dispose 不调用返回的 disposer（fork 行为，见探针注释）。
// 替代保证 = newest-wins 自退役：产生一个更新的实例标记 → 旧实例应在下一个检查轮自行退出。
const newer = mod.startDoctor(config, { ...aaPaths(home) })
console.log('[cordis-smoke] 已启动更新的实例（模拟配置更新/重载）…')
await new Promise((r) => setTimeout(r, 13_000))
newer()
const logAfter = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
const stopped = logAfter.includes('Bridge Doctor 停止') && logAfter.includes('自行退出')

sleeper.kill('SIGKILL')

console.log('\n===== 真实 cordis 冒烟结果 =====')
const rows = [
  ['Config 默认值解析 + 插件启动', started],
  ['wedged 检测 + 仅提醒（无恢复动作）', detected && noHeal],
  ['卸载安全：更新实例出现后旧实例自行退出（newest-wins）', stopped],
]
let pass = true
for (const [name, ok] of rows) {
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok) pass = false
}
console.log('\n[doctor 日志]\n' + log.split('\n').map((l) => '  | ' + l).join('\n'))
console.log(pass ? '\n✅ 真实 cordis 冒烟通过' : '\n❌ 真实 cordis 冒烟失败')
fs.rmSync(home, { recursive: true, force: true })
process.exit(pass ? 0 : 1)
