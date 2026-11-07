# Changelog

## 0.1.0 (2026-11-07)

首次发布。

- 检测：Connector 进程存活 + AA 统一日志鉴权失败签名（窗口计数）+（可选）云端设备/Runtime 状态
  - `exited`：进程退出无人拉起（dsh-desktop#1334）→ 默认自动重新拉起
  - `wedged`：进程存活但连续鉴权失败（#381 空超时死循环形态）→ 默认仅提醒，可开自动重启
  - `stuck-syncing`：DSH Runtime 卡「正在同步 DSH 会话…」（#501 形态，需开启 `checkDeviceApi`）→ 提醒恢复指引
- 恢复：SIGTERM → 等待退出 →（必要时 SIGKILL）→ 重新拉起；主路径为内置 uv 直接构造 argv（空格路径安全），兜底 PATH uv / ps 命令行（校验可执行文件存在）
- 护栏：冷却时间、每日上限、全动作日志（`~/.agents-anywhere/bridge-doctor/`）
- 兼容性：host-only（无客户端半区），不依赖 `@deepseek-ai/dsh-client-ui-slots`（规避 #570）
- 构建：纯 tsc，无原生打包依赖，Node ≥ 22.19
