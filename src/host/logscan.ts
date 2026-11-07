import fs from 'node:fs'
import path from 'node:path'

/**
 * AA 统一运行日志（JSONL，每行是一个 JSON 数组，数组内可含多条记录）：
 *   [{"source":"connector","record":{"time":"...","level":"WARNING","name":"connector.server.client","message":"..."}}, ...]
 *
 * 逐条解析数组记录（而非整行字符串匹配），确保一行多条记录时计数与时间戳关联正确。
 * 只做"最近窗口"的增量统计：读最新两个分段文件的尾部。
 * 参考签名：`backend authentication request failed`
 * （空消息即超时特征，见根因报告 2.3 节）
 */

export interface LogScanResult {
  failures: number
  lastFailureAt: string | null
  newestLogTime: string | null
}

const FAILURE_MARKER = 'backend authentication request failed'

/** 单行解析结果：窗口内失败次数、最后失败时间（含毫秒便于数值比较）、该行最新记录时间 */
export interface ParsedLine {
  failCount: number
  lastFailAt: string | null
  lastFailAtMs: number | null
  newestAt: string | null
  newestAtMs: number | null
}

/** 供测试注入的行解析器：逐条解析 JSON 数组中的 record */
export function parseLine(line: string, windowStartMs: number): ParsedLine {
  // 评审修复 #7：时间比较一律用 Date.parse 的毫秒值——ISO 字符串直比在混合时区
  // （+08:00 vs Z）下会把较早的 +08:00 时间判为更晚。
  const out: ParsedLine = { failCount: 0, lastFailAt: null, lastFailAtMs: null, newestAt: null, newestAtMs: null }
  const trimmed = line.trim()
  let arr: unknown
  try {
    arr = JSON.parse(trimmed)
  } catch {
    return out
  }
  if (!Array.isArray(arr)) return out
  for (const item of arr) {
    const rec = (item as { record?: { time?: unknown; message?: unknown } })?.record
    if (!rec || typeof rec !== 'object') continue
    const t = rec.time
    if (typeof t !== 'string') continue
    const ts = Date.parse(t)
    if (Number.isNaN(ts)) continue
    if (out.newestAtMs === null || ts > out.newestAtMs) {
      out.newestAt = t
      out.newestAtMs = ts
    }
    const msg = rec.message
    if (typeof msg === 'string' && msg.includes(FAILURE_MARKER) && ts >= windowStartMs) {
      out.failCount += 1
      if (out.lastFailAtMs === null || ts > out.lastFailAtMs) {
        out.lastFailAt = t
        out.lastFailAtMs = ts
      }
    }
  }
  return out
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

  // 扫描最近两个分段文件（窗口可能跨越轮转边界；旧文件整段超出窗口时自然计 0）
  const candidates = files.slice(-2)
  let failures = 0
  let lastFailureAt: string | null = null
  let lastFailAtMs: number | null = null
  let newestLogTime: string | null = null
  let newestLogMs: number | null = null

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
      const r = parseLine(line, windowStartMs)
      if (r.failCount > 0) {
        failures += r.failCount
        if (r.lastFailAtMs !== null && (lastFailAtMs === null || r.lastFailAtMs > lastFailAtMs)) {
          lastFailureAt = r.lastFailAt
          lastFailAtMs = r.lastFailAtMs
        }
      }
      if (r.newestAtMs !== null && (newestLogMs === null || r.newestAtMs > newestLogMs)) {
        newestLogTime = r.newestAt
        newestLogMs = r.newestAtMs
      }
    }
  }

  return { failures, lastFailureAt, newestLogTime }
}
