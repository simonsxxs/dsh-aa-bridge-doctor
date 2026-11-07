import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { isAlive, getCommandLine, getExecutablePath, safeArgsFromCommandLine, splitCommandLine, spawnDetached, terminate } from './process.js'
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

/** 新进程存活验证窗口：拉起后等待该时长再确认存活（覆盖 spawn 异步 error/立即退出的情形） */
const VERIFY_WINDOW_MS = 8_000

/** Connector 合法解释器 allowlist（comm 基名匹配，大小写不敏感）：
 *  uv 直接跑、uv run 最终 exec 到 venv python（macOS 上 comm 可能是 Python.app 路径）、
 *  anywhere-cli 直调、node 供未来形态。 */
const CONNECTOR_EXEC_ALLOWLIST = /^(uv|python(\d+(\.\d+)?)?|python|anywhere-cli|node)$/i

/**
 * PID 身份判定·第二因子（四轮强化）：真实可执行文件（ps comm=）必须锚定到**本机安装物**：
 *  - 等于本 Doctor 发现的 uv 二进制（DSH 内置 / ~/.local/bin / PATH 命中的那个），或
 *  - 位于用户 `~/.agents-anywhere/` 树内（Connector venv 的 python 就住在
 *    `connector-venv/bin/…`，含 macOS 的 Python.app 包装路径）。
 * 任意系统的 python3/uv（如 /usr/bin/python3 跑无关脚本、并伪造完整 argv 含真实
 * config 路径）不满足任一条件——评审四轮的"准确路径伪造"样例因此被拒。
 * comm 来自内核，不受 argv 伪装影响；无法获取 → null（Fail Closed）。
 */
export function isConnectorExecutable(execPath: string | null, discoveredUv?: string | null): boolean | null {
  if (execPath === null) return null
  if (discoveredUv && execPath === discoveredUv) return true
  if (execPath.includes('/.agents-anywhere/')) {
    const base = execPath.split('/').pop() ?? ''
    return CONNECTOR_EXEC_ALLOWLIST.test(base)
  }
  return false
}

/**
 * PID 身份判定·第一因子（评审三轮强化）：argv 是否与"本机这台 Connector"的启动形态绑定。
 * 关键词匹配（anywhere-cli/rpc/--config）天然可被伪造——评审三轮用
 * `python3 watch-log.py /tmp/report anywhere-cli rpc --config notes.log` 同时骗过
 * argv 与 comm 两因子。因此第一因子改为绑定**本机安装唯一的 config 路径**：
 * --config 的下一个 token 必须逐字符等于本机 connector.json 的真实路径
 * （含随机目录层级，无关进程的 argv 不可能巧合命中），且存在 rpc 与
 * anywhere-cli（裸名或以 /anywhere-cli 结尾的路径形态，兼容 venv 直调）。
 * 切分失败 → null → 调用方 Fail Closed。
 */
export function isConnectorCommandLine(commandLine: string | null, configPath: string, sourceDir?: string): boolean | null {
  if (commandLine === null) return null
  const tokens = splitCommandLine(commandLine)
  if (tokens === null) return null
  const cfgIdx = tokens.indexOf('--config')
  if (cfgIdx === -1 || cfgIdx + 1 >= tokens.length) return false
  if (tokens[cfgIdx + 1] !== configPath) return false
  const dirIdx = tokens.indexOf('--directory')
  if (dirIdx !== -1 && dirIdx + 1 < tokens.length) {
    if (!sourceDir || tokens[dirIdx + 1] !== sourceDir) return false
  }
  const hasCli = tokens.some((t) => t === 'anywhere-cli' || t.endsWith('/anywhere-cli'))
  if (!hasCli) return false
  return tokens.includes('rpc')
}

function execPromise(cmd: string, args: string[], timeout = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

export class Healer {
  /** 评审二轮修复（新 P1）：状态只从磁盘加载一次，此后以内存为准、落盘 best-effort。
   *  此前 canHeal 每轮重读磁盘，状态文件写失败（EACCES 等）会让内存记账被清空，
   *  冷却与每日配额完全失效。内存化后，写失败仅影响跨会话持久化，会话内限流始终有效。 */
  private state: HealerState

  constructor(
    private readonly paths: AaPaths,
    private readonly log: (line: string) => void,
    /** 自定义 uv 路径（对齐官方 AA 配置同名项）；留空自动发现 */
    private readonly uvPath = '',
  ) {
    this.state = this.loadStateFromDisk()
  }

  private loadStateFromDisk(): HealerState {
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

  /** 冷却与每日配额判定（wedged/exited 分开计时，共用每日配额；内存态为准） */
  canHeal(kind: string, cooldownMinutes: number, maxPerDay: number): { allowed: boolean; reason: string } {
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
   * 拉起后做存活验证（等待 VERIFY_WINDOW_MS 再确认），避免"报告成功但进程立即死亡"。
   */
  async relaunchExited(envKind = 'dsh-plugin'): Promise<HealerOutcome> {
    this.log('处理：Connector 进程退出，尝试重新拉起')
    const pre = await this.preflight()
    if (!pre.ok) {
      this.log(`预检失败，不执行拉起: ${pre.error}`)
      return { action: 'relaunch', ok: false, detail: pre.error! }
    }
    this.recordAttempt('exited') // 动手即记账（失败也消耗配额与冷却）
    const launched = await this.launch(envKind, null)
    if (!launched.ok) {
      this.log(`重新拉起失败: ${launched.error}`)
      return { action: 'relaunch', ok: false, detail: launched.error ?? '未知错误' }
    }
    const verified = await this.verifyLaunched(launched.pid!)
    if (!verified.stable) {
      this.log(`拉起后验证失败: ${verified.detail}`)
      return { action: 'relaunch', ok: false, detail: `进程拉起后 ${VERIFY_WINDOW_MS / 1000}s 内退出（${verified.detail}）` }
    }
    this.log(`重新拉起成功并通过存活验证 pid=${launched.pid}（${launched.source}）`)
    return { action: 'relaunch', ok: true, pid: launched.pid, detail: `pid=${launched.pid}（已验证存活）` }
  }

  /**
   * 场景二：进程活着但卡死（#381 形态）。
   * 安全顺序：身份校验（Fail Closed）→ 预检启动条件 → SIGTERM → 必要时 SIGKILL → 拉起 → 存活验证。
   * 任何一步不满足即中止，绝不"先杀后发现拉不起来"。
   */
  async restartWedged(pid: number, envKind = 'dsh-plugin'): Promise<HealerOutcome> {
    this.log(`处理：重启卡死的 Connector pid=${pid}`)
    // 1) 身份校验（双因子，Fail Closed）：argv 形态（token 级）+ 真实可执行文件（comm allowlist）。
    //    单用 argv 可被带空格的恶意文件名伪造 token 序列（评审二轮 #2）；comm 来自内核不可伪造。
    const identity = await this.confirmConnectorIdentity(pid)
    if (identity.confirmed !== true) {
      if (identity.confirmed === false) {
        this.log(`PID 复用防线生效：pid=${pid} 不是 Connector（${identity.evidence}），中止`)
        return { action: 'restart', ok: false, detail: 'PID 已被无关进程占用（防御中止）' }
      }
      this.log('无法验证进程身份（ps 不可用或平台不支持）——按 Fail Closed 安全策略不自动终止，仅提醒手动重启')
      return {
        action: 'restart',
        ok: false,
        detail: '无法验证进程身份，已按安全策略跳过自动终止；请手动「重启 Connector」',
      }
    }
    const commandLine = identity.commandLine
    // 2) 预检：先确认能重新拉起，再终止旧进程
    const pre = await this.preflight()
    if (!pre.ok) {
      this.log(`预检失败，不终止旧进程: ${pre.error}`)
      return { action: 'restart', ok: false, detail: `启动条件不齐，未终止旧进程（${pre.error}）` }
    }
    // 评审修复 #3：预检耗时后、终止前，双因子复核进程身份未被 PID 复用偷换
    const recheck = await this.confirmConnectorIdentity(pid)
    if (recheck.confirmed !== true) {
      this.log(`终止前身份复核失败（${recheck.confirmed === null ? '无法验证' : '身份不符'}），中止`)
      return { action: 'restart', ok: false, detail: '终止前身份复核未通过，已防御中止' }
    }
    this.recordAttempt('wedged') // 动手即记账（失败也消耗配额与冷却）
    // 3) 终止（SIGKILL 前的 identity 复核由 terminate 内置的 verify 闸执行）
    const identityVerifier = async (p: number): Promise<boolean> =>
      (await this.confirmConnectorIdentity(p)).confirmed === true
    const stop = await terminate(pid, identityVerifier)
    if (stop === 'killed') {
      this.log('旧进程在 SIGKILL 后仍存活，放弃本次恢复')
      return { action: 'restart', ok: false, detail: '无法终止旧进程' }
    }
    if (stop === 'identity-lost') {
      this.log('SIGKILL 前身份复核失败（PID 疑似被复用），放弃升级火力、不拉新进程')
      return { action: 'restart', ok: false, detail: '终止过程中 PID 身份发生变化，已防御中止（未拉起新进程）' }
    }
    this.log(`旧进程终止结果: ${stop}`)
    // 4) 拉起 + 验证
    const launched = await this.launch(envKind, commandLine)
    if (!launched.ok) {
      this.log(`重启失败: ${launched.error}`)
      return { action: 'restart', ok: false, detail: launched.error ?? '未知错误' }
    }
    const verified = await this.verifyLaunched(launched.pid!)
    if (!verified.stable) {
      this.log(`拉起后验证失败: ${verified.detail}`)
      return { action: 'restart', ok: false, detail: `进程拉起后 ${VERIFY_WINDOW_MS / 1000}s 内退出（${verified.detail}）` }
    }
    this.log(`重启成功并通过存活验证 pid=${launched.pid}（${launched.source}）`)
    return { action: 'restart', ok: true, pid: launched.pid, detail: `pid=${launched.pid}（已验证存活，${launched.source}）` }
  }

  /** 双因子身份确认：argv 绑定本机安装（config 路径 + sourceDir）+ comm 锚定本机安装物。
   *  任一因子为 false → false（确认不是）；任一为 null（无法获取）→ null（Fail Closed）；
   *  双 true → true。 */
  private async confirmConnectorIdentity(pid: number): Promise<{ confirmed: boolean | null; commandLine: string | null; evidence: string }> {
    const commandLine = await getCommandLine(pid)
    const execPath = await getExecutablePath(pid)
    // 本机安装锚点：连我们自己的安装参数都无法确定时 → Fail Closed（null）
    const sourceDir = this.findConnectorSource()
    const uv = await this.findUvBinary()
    if (sourceDir === null || uv === null) {
      return { confirmed: null, commandLine, evidence: '本机安装参数不完整（source/uv 缺失）' }
    }
    const argvOk = isConnectorCommandLine(commandLine, this.paths.connectorConfig, sourceDir)
    const execOk = isConnectorExecutable(execPath, uv)
    if (argvOk === false || execOk === false) {
      return { confirmed: false, commandLine, evidence: `argv形态=${argvOk} comm=${execPath ?? '?'}` }
    }
    if (argvOk === null || execOk === null) return { confirmed: null, commandLine, evidence: 'ps 不可用' }
    return { confirmed: true, commandLine, evidence: `${execPath}` }
  }

  /**
   * 预检：终止旧进程前确认重新拉起的条件齐备（uv 可发现 + connector-source + connector.json）。
   * 返回 ok=false 时带具体缺失项。
   */
  private async preflight(): Promise<{ ok: boolean; error?: string }> {
    const sourceDir = this.findConnectorSource()
    if (!sourceDir) return { ok: false, error: `未找到 connector-source 目录（${this.paths.connectorSourceDir}）` }
    if (!fs.existsSync(this.paths.connectorConfig)) {
      return { ok: false, error: `未找到 connector.json（${this.paths.connectorConfig}）` }
    }
    const uv = await this.findUvBinary()
    if (!uv) return { ok: false, error: '未找到 uv 可执行文件（配置 uvPath、DSH 内置、PATH、~/.local/bin 均未命中）' }
    return { ok: true }
  }

  /**
   * 拉起后存活验证：等待 VERIFY_WINDOW_MS 再检查。
   * 覆盖两类"假成功"：spawn 的异步 error 事件（如 ENOENT）与进程启动即退出。
   */
  private async verifyLaunched(pid: number): Promise<{ stable: boolean; detail: string }> {
    await new Promise((r) => setTimeout(r, VERIFY_WINDOW_MS))
    if (await isAlive(pid)) return { stable: true, detail: 'alive' }
    return { stable: false, detail: `pid=${pid} 已退出` }
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
  /** 评审修复 #4（三轮补组）：按当前进程的完整身份判定执行位——owner 命中查 0o100；
   *  文件 gid 命中**有效组或任一补充组**（process.getgroups() 首元素即有效 gid）查 0o010；
   *  都不命中才查 other 0o001。二轮版只比 getgid()，文件 gid 在补充组里但不在有效组时
   *  会错误落入 other 分支（如 mode 0741、file gid∈supplementary → 应按 group 的 r-- 拒绝，
   *  却被 other 的 --x 放行），重新造成"先杀后拉不起"。 */
  private isExecutableFile(p: string): boolean {
    try {
      const st = fs.statSync(p)
      if (!st.isFile()) return false
      const uid = typeof process.getuid === 'function' ? process.getuid() : -1
      if (uid >= 0 && st.uid === uid) return (st.mode & 0o100) !== 0
      if (typeof process.getgroups === 'function') {
        const groups = process.getgroups()
        if (groups.includes(st.gid)) return (st.mode & 0o010) !== 0
      } else if (typeof process.getgid === 'function' && process.getgid() === st.gid) {
        return (st.mode & 0o010) !== 0
      }
      return (st.mode & 0o001) !== 0
    } catch {
      return false
    }
  }

  private async findUvBinary(): Promise<string | null> {
    if (this.uvPath) {
      if (this.isExecutableFile(this.uvPath)) return this.uvPath
      this.log(`配置的 uvPath 不可用（不存在/非文件/不可执行）: ${this.uvPath}，改为自动发现`)
    }
    const candidates = [
      '/Applications/DSH NEXT.app/Contents/Resources/app.asar.unpacked/node_modules/@dataiku/uv-darwin-arm64/bin/uv',
      path.join(this.paths.home, '.local', 'bin', 'uv'),
    ]
    for (const candidate of candidates) {
      if (this.isExecutableFile(candidate)) return candidate
    }
    try {
      const p = (await execPromise('which', ['uv'])).trim()
      return p.length > 0 ? p : null
    } catch {
      return null
    }
  }

  /** 记账一次恢复尝试（评审修复 #5）：在动手前调用——失败的尝试同样消耗冷却与每日配额，
   *  防止"验证失败→下一轮再试"无限循环绕过限流。 */
  recordAttempt(kind: string): void {
    this.state.lastHealAt[kind] = Date.now()
    this.state.restartsToday += 1
    this.saveState()
  }
}
