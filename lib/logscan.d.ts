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
    failures: number;
    lastFailureAt: string | null;
    newestLogTime: string | null;
}
/** 单行解析结果：窗口内失败次数、最后失败时间（含毫秒便于数值比较）、该行最新记录时间 */
export interface ParsedLine {
    failCount: number;
    lastFailAt: string | null;
    lastFailAtMs: number | null;
    newestAt: string | null;
    newestAtMs: number | null;
}
/** 供测试注入的行解析器：逐条解析 JSON 数组中的 record */
export declare function parseLine(line: string, windowStartMs: number): ParsedLine;
export declare function scanRecentFailures(logsDir: string, windowMinutes: number, now?: number): LogScanResult;
//# sourceMappingURL=logscan.d.ts.map