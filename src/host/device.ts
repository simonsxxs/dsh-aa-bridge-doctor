import fs from 'node:fs'
import type { AaPaths } from './paths.js'

/**
 * AA 云端只读查询（可选能力，checkDeviceApi 开启时才使用）：
 * - 设备在线状态（与日志信号交叉验证）
 * - DSH Runtime 卡「正在同步」检测（#501 形态）
 * 凭据只从本机 account.json 读取，仅用于查询，永不写入日志。
 */

export interface AccountInfo {
  apiBaseUrl: string
  accessToken: string
}

export function readAccount(paths: AaPaths): AccountInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.accountJson, 'utf8'))
    if (typeof raw?.accessToken === 'string' && typeof raw?.apiBaseUrl === 'string') {
      return { apiBaseUrl: raw.apiBaseUrl.replace(/\/$/, ''), accessToken: raw.accessToken }
    }
  } catch {
    /* 未登录或文件缺失 */
  }
  return null
}

export function readConnectorId(paths: AaPaths): string | null {
  // 优先 connector/connector.json（插件写入的权威配置），退回共享运行记录
  try {
    const cfg = JSON.parse(fs.readFileSync(paths.connectorConfig, 'utf8'))
    if (typeof cfg?.connectorId === 'string') return cfg.connectorId
  } catch {
    /* ignore */
  }
  try {
    const rt = JSON.parse(fs.readFileSync(paths.runtimeRecord, 'utf8'))
    if (typeof rt?.runtime?.connectorId === 'string') return rt.runtime.connectorId
  } catch {
    /* ignore */
  }
  return null
}

async function getJson(url: string, token: string, timeoutMs = 15_000): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  }
}

export interface DeviceStatus {
  online: boolean | null
  lastSeenAt: string | null
}

export async function fetchDeviceStatus(base: string, token: string, cid: string): Promise<DeviceStatus | null> {
  const data = (await getJson(`${base}/api/v2/connectors/${cid}`, token)) as any
  const c = data?.connector
  if (!c || typeof c.status !== 'string') return null
  return { online: c.status === 'online', lastSeenAt: typeof c.lastSeenAt === 'string' ? c.lastSeenAt : null }
}

export interface DshRuntimeSnapshot {
  runtimeId: string
  status: string
  reason?: string
}

export async function fetchDshRuntime(base: string, token: string, cid: string): Promise<DshRuntimeSnapshot | null> {
  const data = (await getJson(`${base}/api/v2/connectors/${cid}/runtimes`, token)) as any
  const list = Array.isArray(data?.runtimes) ? data.runtimes : []
  const dsh = list.find((r: any) => r?.runtimeType === 'dsh')
  if (!dsh || typeof dsh.runtimeId !== 'string') return null
  return {
    runtimeId: dsh.runtimeId,
    status: typeof dsh.status === 'string' ? dsh.status : '',
    reason: typeof dsh.reason === 'string' ? dsh.reason : undefined,
  }
}

/** 纯函数：判定 DSH Runtime 是否卡在 starting（#501 形态）。seen 由调用方持久于会话内存。 */
export function findStuckDshRuntime(
  snap: DshRuntimeSnapshot | null,
  seen: Map<string, number>,
  now: number,
  stuckMinutes: number,
): { runtimeId: string; stuckMinutes: number } | null {
  if (!snap || snap.status !== 'starting') {
    // 状态恢复正常/消失 → 清除计时
    if (snap) seen.delete(snap.runtimeId)
    else seen.clear()
    return null
  }
  const first = seen.get(snap.runtimeId) ?? now
  if (!seen.has(snap.runtimeId)) seen.set(snap.runtimeId, now)
  const stuckMinutesActual = (now - first) / 60_000
  if (stuckMinutesActual >= stuckMinutes) {
    return { runtimeId: snap.runtimeId, stuckMinutes: Math.round(stuckMinutesActual) }
  }
  return null
}
