import z from '@deepseek-ai/schemastery'

export interface Config {
  enabled?: boolean
  uvPath?: string
  autoRestartExited?: boolean
  autoRestartWedged?: boolean
  failureThreshold?: number
  windowMinutes?: number
  logSilenceMinutes?: number
  cooldownMinutes?: number
  maxRestartsPerDay?: number
  pollSeconds?: number
  checkDeviceApi?: boolean
}

// 默认参数依据：#381 实测卡死节奏为 60~120s/次（本机事故 63s 中位、#381 报告 120s）。
// 10 分钟窗口 × 阈值 4 可同时覆盖两种节奏；旧默认（5 分钟/5 次）对 63s 节奏
// （窗口内约 4.8 次）与 120s 节奏（约 2.5 次）都会漏检——即对两个标志性场景沉默。
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description('启用桥接医生'),
  uvPath: z.string().default('').description('自定义 uv 路径（留空自动发现：DSH 内置 → PATH → ~/.local/bin）'),
  autoRestartExited: z.boolean().default(true).description('进程退出后自动拉起（dsh-desktop#1334 场景）'),
  autoRestartWedged: z.boolean().default(false).description('卡死时自动重启 Connector（默认仅提醒）'),
  failureThreshold: z.number().default(4).min(2).max(100).description('卡死判定：窗口内失败次数阈值'),
  windowMinutes: z.number().default(10).min(1).max(120).description('失败统计窗口（分钟）'),
  logSilenceMinutes: z.number().default(15).min(5).max(240).description('日志静默判定（分钟）：进程存活但 AA 日志无写入'),
  cooldownMinutes: z.number().default(60).min(5).max(1440).description('两次自动恢复的最短间隔（分钟）'),
  maxRestartsPerDay: z.number().default(6).min(1).max(48).description('每日自动恢复上限'),
  pollSeconds: z.number().default(30).min(10).max(600).description('检查间隔（秒）'),
  checkDeviceApi: z.boolean().default(false).description('启用云端检测：设备离线交叉验证 + DSH Runtime 卡「正在同步」检测（#501，读取本机 account.json 的 token，仅查询）'),
})
