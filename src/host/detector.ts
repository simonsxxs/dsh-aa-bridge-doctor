/**
 * 纯逻辑：根据输入信号判定桥接健康状态。不做任何 IO，便于单元测试。
 *
 * 判定签名（与内部故障类无关 —— 连接池僵尸 / 本地路由失败 / 读挂起均落在这里）：
 *  - 记录存在 + 进程死亡            → exited  （dsh-desktop#1334：无人拉起）
 *  - 记录存在 + 进程存活 + 连续失败 ≥ 阈值 → wedged （#381：空超时死循环）
 *  - 其余                            → healthy
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

  return { state: 'healthy', reason: '', shouldNotify: false, healApplicable: false }
}
