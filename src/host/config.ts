import z from '@deepseek-ai/schemastery'

export interface Config {
  enabled?: boolean
  autoRestartExited?: boolean
  autoRestartWedged?: boolean
  failureThreshold?: number
  windowMinutes?: number
  cooldownMinutes?: number
  maxRestartsPerDay?: number
  pollSeconds?: number
  checkDeviceApi?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description('启用桥接医生'),
  autoRestartExited: z.boolean().default(true).description('进程退出后自动拉起（dsh-desktop#1334 场景）'),
  autoRestartWedged: z.boolean().default(false).description('卡死时自动重启 Connector（默认仅提醒）'),
  failureThreshold: z.number().default(5).min(2).max(100).description('卡死判定：窗口内失败次数阈值'),
  windowMinutes: z.number().default(5).min(1).max(120).description('失败统计窗口（分钟）'),
  cooldownMinutes: z.number().default(60).min(5).max(1440).description('两次自动恢复的最短间隔（分钟）'),
  maxRestartsPerDay: z.number().default(6).min(1).max(48).description('每日自动恢复上限'),
  pollSeconds: z.number().default(30).min(10).max(600).description('检查间隔（秒）'),
  checkDeviceApi: z.boolean().default(false).description('联网核对设备在线状态（可选，读取本机 account.json）'),
})
