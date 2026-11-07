import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { isAlive, getCommandLine, safeArgsFromCommandLine, spawnDetached, terminate } from './process.js'
import type { AaPaths } from './paths.js'

export interface HealerState {
  /** 各类型上次自动恢复的时间戳（ms） */
  lastHealAt: Record<string, number>
  /** 今天（本地日）已执行的自动恢复次数 */
  restartsToday: number
  restartsDay: string
}

export interface HealerOutcome {
  action: 'none' | 'relaunch' | 'restart'
  ok: boolean
  pid?: number
  detail: string
}

interface LaunchPlan {
  prog: string
  args: string[]
  source: string
}

/**
 * PID 复用防线判定：命令行是否确属 Connector。
 * 返回 true=确认是 / false=确认不是（拒绝杀）/ null=无法验证（ps 不可用或平台不支持，交由调用方权衡）。
 */
export function isConnectorCommandLine(commandLine: string | null): boolean | null {
  if (commandLine === null) return null
  return commandLine.includes('anywhere-cli') || commandLine.includes('connector.json')
}

function execPromise(cmd: string, args: string[], timeout = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

export class Healer {
  private state: HealerState = { lastHealAt: {}, restartsToday: 0, restartsDay: '' }

  constructor(
    private readonly paths: AaPaths,
    private readonly log: (line: string) => void,
    /** 自定义 uv 路径（对齐官方 AA 配置同名项）；留空自动发现 */
    private readonly uvPath = '',
  ) {}

  private loadState(): HealerState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.paths.doctorState, 'utf8')) as HealerState
      if (parsed && typeof parsed === 'object' && parsed.lastHealAt) return parsed
    } catch {
      /* 首次运行或文件损坏则重置 */
    }
    return { lastHealAt: {}, restartsToday: 0, restartsDay: '' }
  }

  private saveState(): void {
    try {
      fs.mkdirSync(this.paths.doctorDir, { recursive: true })
      fs.writeFileSync(this.paths.doctorState, JSON.stringify(this.state, null, 2))
    } catch (err) {
      this.log(`写入状态失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private todayKey(): string {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  /** 冷却与每日配额判定（wedged/exited 分开计时，共用每日配额） */
  canHeal(kind: string, cooldownMinutes: number, maxPerDay: number): { allowed: boolean; reason: string } {
    this.state = this.loadState()
    const today = this.todayKey()
    if (this.state.restartsDay !== today) {
      this.state.restartsDay = today
      this.state.restartsToday = 0
      this.saveState()
    }
    if (this.state.restartsToday >= maxPerDay) {
      return { allowed: false, reason: `已达今日自动恢复上限（${maxPerDay} 次）` }
    }
    const last = this.state.lastHealAt[kind]
    if (last && Date.now() - last < cooldownMinutes * 60_000) {
      const waitMin = Math.ceil((cooldownMinutes * 60_000 - (Date.now() - last)) / 60_000)
      return { allowed: false, reason: `冷却中，约 ${waitMin} 分钟后再试` }
    }
    return { allowed: true, reason: '' }
  }

  /**
   * 场景一：进程已退出且无人拉起（dsh-desktop#1334）。旧进程已死、租约自然空闲，重新拉起无冲突风险。
   */
  async relaunchExited(envKind = 'dsh-plugin'): Promise<HealerOutcome> {
    this.log('处理：Connector 进程退出，尝试重新拉起')
    const launched = await this.launch(envKind, null)
    if (launched.ok) {
      this.markHealed('exited')
      this.log(`重新拉起成功 pid=${launched.pid}（${launched.source}）`)
      return { action: 'relaunch', ok: true, pid: launched.pid, detail: `pid=${launched.pid}` }
    }
    this.log(`重新拉起失败: ${launched.error}`)
    return { action: 'relaunch', ok: false, detail: launched.error ?? '未知错误' }
  }

  /**
   * 场景二：进程活着但卡死（#381 形态）。SIGTERM → 最多等 10 秒 → 必要时 SIGKILL → 重新拉起。
   * ps 捕获的命令行仅作日志与兜底（其输出不还原引号，路径含空格时不可切分）。
   */
  async restartWedged(pid: number, envKind = 'dsh-plugin'): Promise<HealerOutcome> {
    this.log(`处理：重启卡死的 Connector pid=${pid}`)
    const commandLine = await getCommandLine(pid)
    if (commandLine) this.log(`原命令行（仅诊断）: ${commandLine}`)
    // PID 复用防线：pid 可能已被系统回收并分配给无关进程。杀之前校验命令行确属 Connector。
    const connectorConfirmed = isConnectorCommandLine(commandLine)
    if (connectorConfirmed === false) {
      this.log(`PID 复用防线生效：pid=${pid} 的命令行不是 Connector（${commandLine!.slice(0, 80)}…），中止杀进程`)
      return { action: 'restart', ok: false, detail: 'PID 已被无关进程占用（防御中止）' }
    }
    if (connectorConfirmed === null) {
      this.log('无法验证命令行（ps 不可用或平台不支持），按记录 pid 继续')
    }
    const stop = await terminate(pid)
    if (stop === 'killed') {
      this.log('旧进程在 SIGKILL 后仍存活，放弃本次恢复')
      return { action: 'restart', ok: false, detail: '无法终止旧进程' }
    }
    this.log(`旧进程终止结果: ${stop}`)
    const launched = await this.launch(envKind, commandLine)
    if (launched.ok) {
      this.markHealed('wedged')
      this.log(`重启成功 pid=${launched.pid}（${launched.source}）`)
      return { action: 'restart', ok: true, pid: launched.pid, detail: `pid=${launched.pid}（${launched.source}）` }
    }
    this.log(`重启失败: ${launched.error}`)
    return { action: 'restart', ok: false, detail: launched.error ?? '未知错误' }
  }

  /**
   * 拉起 Connector：主路径 = 直接构造 argv（uv + run + --directory …，空格安全）；
   * 兜底 = ps 捕获命令行切分（仅当首个 token 是真实存在的文件）。
   */
  private async launch(envKind: string, capturedCommandLine: string | null): Promise<{ ok: boolean; pid?: number; error?: string; source: string }> {
    const sourceDir = this.findConnectorSource()
    const configPath = this.paths.connectorConfig
    if (!sourceDir) return { ok: false, error: `未找到 connector-source 目录（${this.paths.connectorSourceDir}）`, source: 'standard' }
    if (!fs.existsSync(configPath)) return { ok: false, error: `未找到 connector.json（${configPath}）`, source: 'standard' }

    const uv = await this.findUvBinary()
    if (uv) {
      const result = spawnDetached(
        uv,
        ['run', '--directory', sourceDir, 'anywhere-cli', 'rpc', '--config', configPath],
        { AA_CONNECTOR_OWNER_KIND: envKind },
      )
      if (result.ok) return { ...result, source: 'standard-argv' }
      this.log(`标准 argv 拉起失败: ${result.error}`)
    } else {
      this.log('未找到 uv 可执行文件，尝试 ps 命令行兜底')
    }

    if (capturedCommandLine) {
      const args = safeArgsFromCommandLine(capturedCommandLine)
      if (args) {
        const result = spawnDetached(args[0], args.slice(1), { AA_CONNECTOR_OWNER_KIND: envKind })
        if (result.ok) return { ...result, source: 'ps-commandline' }
        this.log(`ps 命令行拉起失败: ${result.error}`)
      } else {
        this.log('ps 命令行切分不可信（路径含空格或文件不存在），放弃兜底')
      }
    }
    return { ok: false, error: uv ? '标准与兜底路径均失败' : '未找到 uv 且无可信的 ps 命令行', source: 'none' }
  }

  private findConnectorSource(): string | null {
    try {
      for (const entry of fs.readdirSync(this.paths.connectorSourceDir)) {
        const candidate = path.join(this.paths.connectorSourceDir, entry)
        if (fs.statSync(candidate).isDirectory() && fs.existsSync(path.join(candidate, 'connector', 'cli.py'))) {
          return candidate
        }
      }
    } catch {
      /* 目录不存在 */
    }
    return null
  }

  /** uv 候选：显式配置 → DSH NEXT 内置 @dataiku/uv → PATH 上的 uv → ~/.local/bin/uv */
  private async findUvBinary(): Promise<string | null> {
    if (this.uvPath) {
      if (fs.existsSync(this.uvPath)) return this.uvPath
      this.log(`配置的 uvPath 不存在: ${this.uvPath}，改为自动发现`)
    }
    const candidates = [
      '/Applications/DSH NEXT.app/Contents/Resources/app.asar.unpacked/node_modules/@dataiku/uv-darwin-arm64/bin/uv',
      path.join(this.paths.home, '.local', 'bin', 'uv'),
    ]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate
    }
    try {
      const p = (await execPromise('which', ['uv'])).trim()
      return p.length > 0 ? p : null
    } catch {
      return null
    }
  }

  private markHealed(kind: string): void {
    this.state.lastHealAt[kind] = Date.now()
    this.state.restartsToday += 1
    this.saveState()
  }
}
