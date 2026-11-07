import { execFile } from 'node:child_process'

/** macOS 系统通知（best-effort，失败静默） */
export function notify(title: string, body: string): void {
  try {
    const script = `display notification ${quote(body)} with title ${quote(title)} sound name "Glass"`
    execFile('osascript', ['-e', script], { timeout: 5_000 }, () => {})
  } catch {
    /* 通知失败不影响主流程 */
  }
}

function quote(text: string): string {
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}
