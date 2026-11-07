import fs from 'node:fs'

/**
 * 官方插件把 Connector 的进程生命周期写入 <stateRoot>/logs/connector-output.json：
 *   [{"id":..., "time":"2026-11-07T04:13:04.886Z", "text":"[process] exited (143)"}, ...]
 *
 * 用途：区分「用户刚在面板点了停止（或插件受控重启）」与「早就静默死亡无人处理」。
 * 刚退出（新鲜）→ 只提醒；退出已久（陈旧）→ 自动拉起（#1334 场景）。
 */

export interface ProcessExitInfo {
  at: Date
  code: string | null
}

export function readLastProcessExit(connectorOutputPath: string): ProcessExitInfo | null {
  let entries: Array<{ time?: string; text?: string }>
  try {
    entries = JSON.parse(fs.readFileSync(connectorOutputPath, 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(entries)) return null
  // 评审修复 #6：从尾部倒序扫描，若先遇到 running/starting（退出之后有新实例启动过），
  // 则最近一次退出已不相关（旧记录不应永久屏蔽后来实例的恢复）→ 返回 null。
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = entries[i]?.text
    if (typeof text !== 'string') continue
    if (text.startsWith('[process] running') || text.startsWith('[process] starting')) {
      return null
    }
    if (!text.startsWith('[process] exited')) continue
    const t = entries[i]?.time
    const at = t ? new Date(t) : null
    if (!at || Number.isNaN(at.getTime())) continue
    const m = text.match(/exited \(([^)]+)\)/)
    return { at, code: m ? m[1] : null }
  }
  return null
}

/**
 * 纯函数：exited 场景是否允许自动拉起。
 *
 * 退出码甄别（区分主动停止与异常退出）：
 *  - exit=0（正常自退）或 exit=143（SIGTERM——面板停止/受控重启）：任何年龄段都视为主动操作，不自动拉起。
 *    这修复了"用户停止后去吃午饭，回来发现被自动拉起"的对着干场景。
 *  - 其他退出码（1/信号名等）或无退出记录：视为异常死亡，经陈旧窗口（默认 10 分钟）后自动拉起。
 */
export function shouldAutoRelaunchExited(
  exitInfo: ProcessExitInfo | null,
  now: number,
  staleMinutes = 10,
): { auto: boolean; reason: string } {
  if (!exitInfo) return { auto: true, reason: '无退出记录（视为未知死亡）' }
  if (exitInfo.code === '0' || exitInfo.code === '143') {
    return {
      auto: false,
      reason: `exit=${exitInfo.code}（主动/受控停止形态），不自动拉起——如需启动请手动点「启动 Connector」`,
    }
  }
  const ageMin = (now - exitInfo.at.getTime()) / 60_000
  if (ageMin > staleMinutes) {
    return { auto: true, reason: `异常退出（exit=${exitInfo.code}）已 ${Math.round(ageMin)} 分钟无人处理（陈旧死亡）` }
  }
  return {
    auto: false,
    reason: `异常退出记录新鲜（${Math.max(0, Math.round(ageMin))} 分钟前，exit=${exitInfo.code}），等待陈旧窗口`,
  }
}
