import type { AaPaths } from './paths.js';
/**
 * AA 云端只读查询（可选能力，checkDeviceApi 开启时才使用）：
 * - 设备在线状态（与日志信号交叉验证）
 * - DSH Runtime 卡「正在同步」检测（#501 形态）
 * 凭据只从本机 account.json 读取，仅用于查询，永不写入日志。
 */
export interface AccountInfo {
    apiBaseUrl: string;
    accessToken: string;
}
export declare function readAccount(paths: AaPaths): AccountInfo | null;
export declare function readConnectorId(paths: AaPaths): string | null;
export interface DeviceStatus {
    online: boolean | null;
    lastSeenAt: string | null;
}
export declare function fetchDeviceStatus(base: string, token: string, cid: string): Promise<DeviceStatus | null>;
export interface DshRuntimeSnapshot {
    runtimeId: string;
    status: string;
    reason?: string;
}
export declare function fetchDshRuntime(base: string, token: string, cid: string): Promise<DshRuntimeSnapshot | null>;
/** 纯函数：判定 DSH Runtime 是否卡在 starting（#501 形态）。seen 由调用方持久于会话内存。 */
export declare function findStuckDshRuntime(snap: DshRuntimeSnapshot | null, seen: Map<string, number>, now: number, stuckMinutes: number): {
    runtimeId: string;
    stuckMinutes: number;
} | null;
//# sourceMappingURL=device.d.ts.map