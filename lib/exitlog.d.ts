/**
 * 官方插件把 Connector 的进程生命周期写入 <stateRoot>/logs/connector-output.json：
 *   [{"id":..., "time":"2026-11-07T04:13:04.886Z", "text":"[process] exited (143)"}, ...]
 *
 * 用途：区分「用户刚在面板点了停止（或插件受控重启）」与「早就静默死亡无人处理」。
 * 刚退出（新鲜）→ 只提醒；退出已久（陈旧）→ 自动拉起（#1334 场景）。
 */
export interface ProcessExitInfo {
    at: Date;
    code: string | null;
}
export declare function readLastProcessExit(connectorOutputPath: string): ProcessExitInfo | null;
/**
 * 纯函数：exited 场景是否允许自动拉起。
 *
 * 退出码甄别（区分主动停止与异常退出）：
 *  - exit=0（正常自退）或 exit=143（SIGTERM——面板停止/受控重启）：任何年龄段都视为主动操作，不自动拉起。
 *    这修复了"用户停止后去吃午饭，回来发现被自动拉起"的对着干场景。
 *  - 其他退出码（1/信号名等）或无退出记录：视为异常死亡，经陈旧窗口（默认 10 分钟）后自动拉起。
 */
export declare function shouldAutoRelaunchExited(exitInfo: ProcessExitInfo | null, now: number, staleMinutes?: number): {
    auto: boolean;
    reason: string;
};
//# sourceMappingURL=exitlog.d.ts.map