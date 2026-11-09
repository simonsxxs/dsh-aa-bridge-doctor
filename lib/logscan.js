import fs from 'node:fs';
import path from 'node:path';
const FAILURE_MARKER = 'backend authentication request failed';
/** 供测试注入的行解析器：逐条解析 JSON 数组中的 record */
export function parseLine(line, windowStartMs) {
    // 评审修复 #7：时间比较一律用 Date.parse 的毫秒值——ISO 字符串直比在混合时区
    // （+08:00 vs Z）下会把较早的 +08:00 时间判为更晚。
    const out = { failCount: 0, lastFailAt: null, lastFailAtMs: null, newestAt: null, newestAtMs: null };
    const trimmed = line.trim();
    let arr;
    try {
        arr = JSON.parse(trimmed);
    }
    catch {
        return out;
    }
    if (!Array.isArray(arr))
        return out;
    for (const item of arr) {
        const rec = item?.record;
        if (!rec || typeof rec !== 'object')
            continue;
        const t = rec.time;
        if (typeof t !== 'string')
            continue;
        const ts = Date.parse(t);
        if (Number.isNaN(ts))
            continue;
        if (out.newestAtMs === null || ts > out.newestAtMs) {
            out.newestAt = t;
            out.newestAtMs = ts;
        }
        const msg = rec.message;
        if (typeof msg === 'string' && msg.includes(FAILURE_MARKER) && ts >= windowStartMs) {
            out.failCount += 1;
            if (out.lastFailAtMs === null || ts > out.lastFailAtMs) {
                out.lastFailAt = t;
                out.lastFailAtMs = ts;
            }
        }
    }
    return out;
}
export function scanRecentFailures(logsDir, windowMinutes, now = Date.now()) {
    const windowStartMs = now - windowMinutes * 60_000;
    let files = [];
    try {
        files = fs
            .readdirSync(logsDir)
            .filter((f) => f.startsWith('runtime-') && f.endsWith('.jsonl'))
            .sort();
    }
    catch {
        return { failures: 0, lastFailureAt: null, newestLogTime: null };
    }
    if (files.length === 0)
        return { failures: 0, lastFailureAt: null, newestLogTime: null };
    // 扫描最近两个分段文件（窗口可能跨越轮转边界；旧文件整段超出窗口时自然计 0）
    const candidates = files.slice(-2);
    let failures = 0;
    let lastFailureAt = null;
    let lastFailAtMs = null;
    let newestLogTime = null;
    let newestLogMs = null;
    for (const name of candidates) {
        const full = path.join(logsDir, name);
        let stat;
        try {
            stat = fs.statSync(full);
        }
        catch {
            continue;
        }
        // 只读尾部最多 512KB（窗口内的失败按 63~120s 一条的节奏，512KB 足够覆盖 2 小时）
        const readFrom = Math.max(0, stat.size - 512 * 1024);
        let text;
        try {
            const fh = fs.openSync(full, 'r');
            const buf = Buffer.alloc(stat.size - readFrom);
            fs.readSync(fh, buf, 0, buf.length, readFrom);
            fs.closeSync(fh);
            text = buf.toString('utf8');
        }
        catch {
            continue;
        }
        const lines = text.split('\n');
        // 若从中间截断，丢弃第一行（可能不完整）
        if (readFrom > 0 && lines.length > 0)
            lines.shift();
        for (const line of lines) {
            const r = parseLine(line, windowStartMs);
            if (r.failCount > 0) {
                failures += r.failCount;
                if (r.lastFailAtMs !== null && (lastFailAtMs === null || r.lastFailAtMs > lastFailAtMs)) {
                    lastFailureAt = r.lastFailAt;
                    lastFailAtMs = r.lastFailAtMs;
                }
            }
            if (r.newestAtMs !== null && (newestLogMs === null || r.newestAtMs > newestLogMs)) {
                newestLogTime = r.newestAt;
                newestLogMs = r.newestAtMs;
            }
        }
    }
    return { failures, lastFailureAt, newestLogTime };
}
//# sourceMappingURL=logscan.js.map