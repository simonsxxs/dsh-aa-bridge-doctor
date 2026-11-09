import { execFile } from 'node:child_process';
/**
 * 跨平台系统通知（best-effort，失败静默）：
 *  - macOS：osascript（一等支持）
 *  - Linux：notify-send（未安装时静默降级）
 *  - Windows：PowerShell 弹窗（未测）
 */
export function notify(title, body) {
    try {
        if (process.platform === 'darwin') {
            const script = `display notification ${quote(body)} with title ${quote(title)} sound name "Glass"`;
            execFile('osascript', ['-e', script], { timeout: 5_000 }, () => { });
            return;
        }
        if (process.platform === 'linux') {
            execFile('notify-send', [title, body], { timeout: 5_000 }, () => { });
            return;
        }
        if (process.platform === 'win32') {
            const safeTitle = title.replaceAll("'", "''");
            const safeBody = body.replaceAll("'", "''");
            const ps = `(New-Object -ComObject Wscript.Shell).Popup('${safeBody}', 0, '${safeTitle}', 64)`;
            execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 10_000 }, () => { });
            return;
        }
        /* 其他平台：无通知能力，静默 */
    }
    catch {
        /* 通知失败不影响主流程 */
    }
}
function quote(text) {
    return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
//# sourceMappingURL=notifier.js.map