import os from 'node:os'
import path from 'node:path'

/** Agents Anywhere 本机数据布局（与官方插件约定一致，见 dsh-bridge-next TECHNICAL.md） */
export interface AaPaths {
  home: string
  aaDir: string
  logsDir: string
  runtimeRecord: string
  connectorConfig: string
  accountJson: string
  connectorSourceDir: string
  doctorDir: string
  doctorLog: string
  doctorState: string
}

export function aaPaths(home = os.homedir()): AaPaths {
  const aaDir = path.join(home, '.agents-anywhere')
  return {
    home,
    aaDir,
    logsDir: path.join(aaDir, 'logs'),
    runtimeRecord: path.join(aaDir, 'connector-runtime.json'),
    connectorConfig: path.join(aaDir, 'dsh-bridge-next', 'connector', 'connector.json'),
    accountJson: path.join(aaDir, 'dsh-bridge-next', 'account.json'),
    connectorSourceDir: path.join(aaDir, 'dsh-bridge-next', 'connector-source'),
    doctorDir: path.join(aaDir, 'bridge-doctor'),
    doctorLog: path.join(aaDir, 'bridge-doctor', 'bridge-doctor.log'),
    doctorState: path.join(aaDir, 'bridge-doctor', 'state.json'),
  }
}
