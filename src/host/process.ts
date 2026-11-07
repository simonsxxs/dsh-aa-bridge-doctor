import fs from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function isAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 捕获进程的真实可执行文件路径（macOS `ps -o comm=`）——不受 argv 伪装影响，
 *  是身份校验的第二因子（argv 可被带空格的文件名伪造，comm 不行）。 */
export async function getExecutablePath(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 5_000 })
    const line = stdout.trim()
    return line.length > 0 ? line : null
  } catch {
    return null
  }
}

/** 捕获进程的完整启动命令行（macOS `ps -ww -o command=`）。注意：仅用于日志诊断，
 *  输出不还原引号，路径含空格时不可安全切分 —— 重启请用 spawnDetached 构造 argv。 */
export async function getCommandLine(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-ww', '-o', 'command='], { timeout: 5_000 })
    const line = stdout.trim()
    return line.length > 0 ? line : null
  } catch {
    return null
  }
}

/** 极简 shell 词法切分（支持成对单/双引号）。仅作 ps 命令行的兜底解析，且必须校验 args[0] 存在 */
export function splitCommandLine(line: string): string[] | null {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
    } else if (ch === ' ' || ch === '\t') {
      if (hasToken || current.length > 0) args.push(current)
      current = ''
      hasToken = false
    } else {
      current += ch
      hasToken = true
    }
  }
  if (quote !== null) return null // 引号不闭合，拒绝
  if (hasToken || current.length > 0) args.push(current)
  return args.length > 0 ? args : null
}

export interface RelaunchResult {
  ok: boolean
  pid?: number
  error?: string
}

/**
 * 以分离进程方式直接 spawn（argv 数组，不经 shell —— 路径含空格也安全）。
 * 必须挂 error 监听：spawn 的失败（如 ENOENT）以异步 error 事件到达，
 * 不监听会导致未捕获异常崩溃宿主；进程死亡本身由调用方的存活验证兜底。
 */
export function spawnDetached(prog: string, args: string[], env: Record<string, string>): RelaunchResult {
  try {
    const child = spawn(prog, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...env },
    })
    // 评审修复 #1：吞掉异步 error（ENOENT/EPERM 等），防止未捕获异常；
    // 拉起失败表现为进程立即死亡，由 verifyLaunched 的存活窗口检出。
    child.once('error', () => {})
    child.unref()
    if (typeof child.pid !== 'number') {
      return { ok: false, error: 'spawn 未返回 pid' }
    }
    return { ok: true, pid: child.pid }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** ps 命令行兜底路径：切分后校验 args[0] 真实存在才返回（防空格切坏） */
export function safeArgsFromCommandLine(commandLine: string): string[] | null {
  const args = splitCommandLine(commandLine)
  if (!args || args.length < 2) return null
  try {
    if (!fs.existsSync(args[0])) return null
  } catch {
    return null
  }
  return args
}

/**
 * 优雅终止：先 SIGTERM，等待最多 10 秒，仍存活则 SIGKILL。
 * 评审修复 #3：传入 verify 时，SIGKILL 前复核进程身份——SIGTERM 后 PID 若被
 * 复用为无关进程，绝不升级到 SIGKILL（返回 'identity-lost'）。
 */
export async function terminate(
  pid: number,
  verify?: (pid: number) => Promise<boolean>,
): Promise<'exited' | 'killed' | 'not-running' | 'identity-lost'> {
  if (!(await isAlive(pid))) return 'not-running'
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return 'not-running'
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    if (!(await isAlive(pid))) return 'exited'
  }
  // SIGKILL 前复核身份：PID 复用防线（升级火力前最后一道闸）
  if (verify && !(await verify(pid))) return 'identity-lost'
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 500))
  return (await isAlive(pid)) ? 'killed' : 'exited'
}
