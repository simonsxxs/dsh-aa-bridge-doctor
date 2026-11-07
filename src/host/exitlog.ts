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
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = entries[i]?.text
    if (typeof text !== 'string' || !text.startsWith('[process] exited')) continue
    const t = entries[i]?.time
    const at = t ? new Date(t) : null
    if (!at || Number.isNaN(at.getTime())) continue
    const m = text.match(/exited \(([^)]+)\)/)
    return { at, code: m ? m[1] : null }
  }
  return null
}

/** 纯函数：exited 场景是否允许自动拉起 */
export function shouldAutoRelaunchExited(
  exitInfo: ProcessExitInfo | null,
  now: number,
  staleMinutes = 10,
): { auto: boolean; reason: string } {
  if (!exitInfo) return { auto: true, reason: '无退出记录（视为未知死亡）' }
  const ageMin = (now - exitInfo.at.getTime()) / 60_000
  if (ageMin > staleMinutes) {
    return { auto: true, reason: `退出已 ${Math.round(ageMin)} 分钟无人处理（陈旧死亡）` }
  }
  return {
    auto: false,
    reason: `退出记录新鲜（${Math.max(0, Math.round(ageMin))} 分钟前，exit=${exitInfo.code ?? '?'}），视为人为/受控操作`,
  }
}
