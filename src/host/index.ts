import fs from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Config, type Config as ConfigType } from './config.js'
import { aaPaths } from './paths.js'
import { classify } from './detector.js'
import { scanRecentFailures } from './logscan.js'
import { isAlive } from './process.js'
import { notify } from './notifier.js'
import { Healer } from './healer.js'
import { readAccount, readConnectorId, fetchDeviceStatus, fetchDshRuntime, findStuckDshRuntime } from './device.js'

export { Config }
export const name = 'dsh-aa-bridge-doctor'

const DEFAULTS = {
  failureThreshold: 5,
  windowMinutes: 5,
  cooldownMinutes: 60,
  maxRestartsPerDay: 6,
  pollSeconds: 30,
  stuckStartingMinutes: 15,
}

export function apply(ctx: Context, config: ConfigType) {
  if (!config.enabled) return
  const paths = aaPaths()
  const healer = new Healer(paths, (line) => appendLog(paths.doctorLog, line))
  const settings = {
    failureThreshold: config.failureThreshold ?? DEFAULTS.failureThreshold,
    windowMinutes: config.windowMinutes ?? DEFAULTS.windowMinutes,
    cooldownMinutes: config.cooldownMinutes ?? DEFAULTS.cooldownMinutes,
    maxRestartsPerDay: config.maxRestartsPerDay ?? DEFAULTS.maxRestartsPerDay,
    pollSeconds: Math.max(10, config.pollSeconds ?? DEFAULTS.pollSeconds),
    checkDeviceApi: config.checkDeviceApi ?? false,
  }
  // DSH Runtime 卡「正在同步」的首次观测时间（会话内存即可）
  const startingSeen = new Map<string, number>()
  const stuckNotified = new Set<string>()

  appendLog(
    paths.doctorLog,
    `Bridge Doctor 启动 exited=${config.autoRestartExited ? 'auto' : 'notify'} wedged=${config.autoRestartWedged ? 'auto' : 'notify'} poll=${settings.pollSeconds}s window=${settings.windowMinutes}m threshold=${settings.failureThreshold}`,
  )

  let busy = false
  const tick = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      await runOnce(config, settings, paths, healer)
      if (settings.checkDeviceApi) {
        await checkDshRuntimeStuck(settings, paths, healer, startingSeen, stuckNotified)
      }
    } catch (err) {
      appendLog(paths.doctorLog, `检查轮出错: ${err instanceof Error ? err.stack : String(err)}`)
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => void tick(), settings.pollSeconds * 1_000)
  const firstRun = setTimeout(() => void tick(), 8_000)

  // cordis：apply 返回的函数在插件卸载时执行
  return () => {
    clearInterval(timer)
    clearTimeout(firstRun)
    appendLog(paths.doctorLog, 'Bridge Doctor 停止')
  }
}

async function runOnce(
  config: ConfigType,
  settings: {
    failureThreshold: number
    windowMinutes: number
    cooldownMinutes: number
    maxRestartsPerDay: number
    pollSeconds: number
  },
  paths: ReturnType<typeof aaPaths>,
  healer: Healer,
): Promise<void> {
  // 1) 共享运行记录（未安装/未授权时不存在）
  let runtimeRecord: { runtime?: { pid?: number; kind?: string } } | null = null
  try {
    runtimeRecord = JSON.parse(fs.readFileSync(paths.runtimeRecord, 'utf8'))
  } catch {
    /* ignore */
  }
  const recordExists = runtimeRecord !== null
  const pid = runtimeRecord?.runtime?.pid

  // 2) 进程存活
  const processAlive = pid !== undefined ? await isAlive(pid) : false

  // 3) 窗口内失败计数
  const scan = scanRecentFailures(paths.logsDir, settings.windowMinutes)

  // 4) 判定（纯函数）
  const verdict = classify({
    runtimeRecordExists: recordExists,
    processAlive,
    failuresInWindow: scan.failures,
    failureThreshold: settings.failureThreshold,
  })

  if (verdict.state === 'not-installed' || verdict.state === 'healthy') return

  // 5) 冷却/配额 + 模式开关
  const kind = verdict.state
  const gate = healer.canHeal(kind, settings.cooldownMinutes, settings.maxRestartsPerDay)
  const autoEnabled = verdict.state === 'exited' ? config.autoRestartExited : config.autoRestartWedged

  appendLog(
    paths.doctorLog,
    `检测到 ${verdict.state}: ${verdict.reason} | 近${settings.windowMinutes}分钟失败=${scan.failures} 最后失败=${scan.lastFailureAt ?? '-'} | 自动恢复=${autoEnabled && gate.allowed ? '执行' : `跳过（${autoEnabled ? gate.reason : '模式未开启'}）`}`,
  )

  // 6) 行动
  if (autoEnabled && gate.allowed) {
    const outcome =
      verdict.state === 'exited'
        ? await healer.relaunchExited()
        : pid !== undefined
          ? await healer.restartWedged(pid)
          : { action: 'none' as const, ok: false, detail: '运行记录缺少 pid，无法重启' }

    notify(
      'AA Bridge Doctor',
      `检测到桥接${verdict.state === 'exited' ? '进程退出' : '卡死'}，自动恢复${outcome.ok ? '成功' : '失败'} ${outcome.detail}`,
    )
    appendLog(paths.doctorLog, `恢复结果: ${outcome.ok ? '成功' : '失败'} ${outcome.detail}`)
    if (!outcome.ok) {
      notify(
        'AA Bridge Doctor',
        `自动恢复失败：${outcome.detail}。请打开 AA 插件面板手动「重启 Connector」。`,
      )
    }
    return
  }

  // 仅提醒
  notify(
    'AA Bridge Doctor',
    verdict.state === 'exited'
      ? 'AA Connector 进程已退出且未拉起，手机端将持续离线。请打开 AA 插件面板点「启动 Connector」。'
      : `AA 桥接疑似卡死（近${settings.windowMinutes}分钟失败 ${scan.failures} 次，进程存活）。请打开 AA 插件面板点「重启 Connector」。`,
  )
}

function appendLog(file: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/** #501 形态检测：DSH Runtime 卡「正在同步 DSH 会话…」超过阈值 → 通知恢复指引（只提醒，不动状态） */
async function checkDshRuntimeStuck(
  settings: { checkDeviceApi: boolean },
  paths: ReturnType<typeof aaPaths>,
  healer: Healer,
  startingSeen: Map<string, number>,
  stuckNotified: Set<string>,
): Promise<void> {
  if (!settings.checkDeviceApi) return
  const account = readAccount(paths)
  const cid = readConnectorId(paths)
  if (!account || !cid) return

  const snap = await fetchDshRuntime(account.apiBaseUrl, account.accessToken, cid)
  const stuck = findStuckDshRuntime(snap, startingSeen, Date.now(), DEFAULTS.stuckStartingMinutes)
  if (!stuck) {
    // 恢复正常后允许下次再提醒
    if (snap && stuckNotified.has(snap.runtimeId) && snap.status !== 'starting') stuckNotified.delete(snap.runtimeId)
    return
  }
  const key = `${stuck.runtimeId}:${new Date().toDateString()}`
  if (stuckNotified.has(key)) return
  stuckNotified.add(key)
  appendLog(
    paths.doctorLog,
    `检测到 DSH Runtime 卡「正在同步」runtimeId=${stuck.runtimeId} 已持续 ${stuck.stuckMinutes} 分钟（#501 形态）`,
  )
  notify(
    'AA Bridge Doctor',
    `DSH Runtime 卡在「正在同步 DSH 会话…」已 ${stuck.stuckMinutes} 分钟。请在手机/网页设备页对 DeepSeek Harness 重新「一键配置」（重建 runtime 实例即可恢复）。`,
  )
}
