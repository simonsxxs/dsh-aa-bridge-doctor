/**
 * 跨平台系统通知（best-effort，失败静默）：
 *  - macOS：osascript（一等支持）
 *  - Linux：notify-send（未安装时静默降级）
 *  - Windows：PowerShell 弹窗（未测）
 */
export declare function notify(title: string, body: string): void;
//# sourceMappingURL=notifier.d.ts.map