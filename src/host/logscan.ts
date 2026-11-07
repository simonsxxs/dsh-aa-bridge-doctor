import fs from 'node:fs'
import path from 'node:path'

/**
 * AA 统一运行日志（JSONL，每行是一个 JSON 数组）：
 *   [{"source":"connector","record":{"time":"...","level":"WARNING","name":"connector.server.client","message":"..."}}, ...]
 *
 * 只做"最近窗口"的增量统计：读最新一个分段文件 + （必要时）前一个的尾部。
 * 参考签名：`backend authentication request failed` / `connector backend network unavailable`
 * （空消息即超时特征，见根因报告 2.3 节）
 */

export interface LogScanResult {
  failures: number
  lastFailureAt: string | null
  newestLogTime: string | null
}

const FAILURE_MARKER = 'backend authentication request failed'

/** 供测试注入的行解析器 */
export function parseLine(line: string, windowStartMs: number): { fail: boolean; at: string | null; atMs: number | null } {
  const trimmed = line.trim()
  if (!trimmed || !trimmed.includes(FAILURE_MARKER)) return { fail: false, at: null, atMs: null }
  const m = trimmed.match(/"time":\s*"([^"]+)"/)
  if (!m) return { fail: false, at: null, atMs: null }
  const ts = Date.parse(m[1])
  if (Number.isNaN(ts)) return { fail: false, at: null, atMs: null }
  return { fail: ts >= windowStartMs, at: m[1], atMs: ts }
}

export function scanRecentFailures(logsDir: string, windowMinutes: number, now = Date.now()): LogScanResult {
  const windowStartMs = now - windowMinutes * 60_000
  let files: string[] = []
  try {
    files = fs
      .readdirSync(logsDir)
      .filter((f) => f.startsWith('runtime-') && f.endsWith('.jsonl'))
      .sort()
  } catch {
    return { failures: 0, lastFailureAt: null, newestLogTime: null }
  }
  if (files.length === 0) return { failures: 0, lastFailureAt: null, newestLogTime: null }

  // 最新文件足够覆盖窗口；若窗口起点早于最新文件的首条时间，再把前一个文件的尾部也扫上。
  const candidates = files.slice(-1)
  let failures = 0
  let lastFailureAt: string | null = null
  let newestLogTime: string | null = null

  for (const name of candidates) {
    const full = path.join(logsDir, name)
    let stat: fs.Stats
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    // 只读尾部最多 512KB（窗口内的失败按 63~120s 一条的节奏，512KB 足够覆盖 2 小时）
    const readFrom = Math.max(0, stat.size - 512 * 1024)
    let text: string
    try {
      const fh = fs.openSync(full, 'r')
      const buf = Buffer.alloc(stat.size - readFrom)
      fs.readSync(fh, buf, 0, buf.length, readFrom)
      fs.closeSync(fh)
      text = buf.toString('utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    // 若从中间截断，丢弃第一行（可能不完整）
    if (readFrom > 0 && lines.length > 0) lines.shift()
    for (const line of lines) {
      // 先更新窗口内最新日志时间（任意有效行），再统计失败
      const t = line.match(/"time":\s*"([^"]+)"/)
      if (t) {
        const anyTs = Date.parse(t[1])
        if (!Number.isNaN(anyTs) && anyTs >= windowStartMs && (newestLogTime === null || t[1] > newestLogTime)) {
          newestLogTime = t[1]
        }
      }
      const r = parseLine(line, windowStartMs)
      if (r.fail) {
        failures += 1
        if (lastFailureAt === null || r.at! > lastFailureAt) lastFailureAt = r.at
      }
    }
  }

  return { failures, lastFailureAt, newestLogTime }
}
