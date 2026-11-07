/**
 * 纯逻辑：根据输入信号判定桥接健康状态。不做任何 IO，便于单元测试。
 *
 * 判定签名（与内部故障类无关 —— 连接池僵尸 / 本地路由失败 / 读挂起均落在这里）：
 *  - 记录存在 + 进程死亡            → exited  （dsh-desktop#1334：无人拉起）
 *  - 记录存在 + 进程存活 + 连续失败 ≥ 阈值 → wedged （#381：空超时死循环）
 *  - 记录存在 + 进程存活 + 日志静默 ≥ 阈值 → wedged （挂死变体：进程在、日志停）
 *  - 其余                            → healthy
 *
 * 默认参数依据（勿随意改回 5 分钟/5 次）：#381 实测 120s/次、本机事故 63s/次，
 * 10 分钟窗口 × 阈值 4 才能同时覆盖两种节奏。
 */

export type BridgeState = 'not-installed' | 'healthy' | 'exited' | 'wedged'

export interface DetectorInput {
  /** connector-runtime.json 是否存在（是否安装/配置过 AA 桥接） */
  runtimeRecordExists: boolean
  /** 共享记录中的 Connector 进程是否存活 */
  processAlive: boolean
  /** 统计窗口内的鉴权失败次数（来自 AA 统一日志） */
  failuresInWindow: number
  failureThreshold: number
  /** 最新一条 AA 日志距现在的分钟数；无法判定（如日志文件缺失）时传 null */
  newestLogAgeMin?: number | null
  /** 日志静默判定阈值（分钟）；进程存活但 AA 日志超时无写入 → 疑似挂死 */
  logSilenceMinutes?: number
}

export interface DetectorOutput {
  state: BridgeState
  reason: string
  shouldNotify: boolean
  /** exited / wedged 时为 true；由调用方结合 auto 开关与冷却决定是否真正执行 */
  healApplicable: boolean
}

export function classify(input: DetectorInput): DetectorOutput {
  const { runtimeRecordExists, processAlive, failuresInWindow, failureThreshold } = input
  const silenceLimit = input.logSilenceMinutes ?? 15

  if (!runtimeRecordExists) {
    return { state: 'not-installed', reason: '未找到 AA 桥接运行记录（未安装或未授权）', shouldNotify: false, healApplicable: false }
  }

  if (!processAlive) {
    return {
      state: 'exited',
      reason: 'Connector 进程已退出且无人拉起（dsh-desktop#1334 形态）',
      shouldNotify: true,
      healApplicable: true,
    }
  }

  if (failuresInWindow >= failureThreshold) {
    return {
      state: 'wedged',
      reason: `进程存活但窗口内鉴权失败 ${failuresInWindow} 次 ≥ 阈值 ${failureThreshold}（#381 空超时死循环形态）`,
      shouldNotify: true,
      healApplicable: true,
    }
  }

  // 日志静默变体：进程活着，但 AA 统一日志长时间无任何写入 —— 连接器事件循环挂死的特征。
  // 已实证健康状态下该日志持续有写入（心跳帧 + 30s 同步 INFO），因此静默 ≥ 阈值即为异常。
  if (
    input.newestLogAgeMin !== null &&
    input.newestLogAgeMin !== undefined &&
    input.newestLogAgeMin >= silenceLimit
  ) {
    return {
      state: 'wedged',
      reason: `进程存活但 AA 日志已静默 ${Math.round(input.newestLogAgeMin)} 分钟 ≥ ${silenceLimit} 分钟（事件循环挂死特征）`,
      shouldNotify: true,
      healApplicable: true,
    }
  }

  return { state: 'healthy', reason: '', shouldNotify: false, healApplicable: false }
}
