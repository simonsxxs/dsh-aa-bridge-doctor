# Changelog

## 0.2.0 (2026-11-07)

外部评审（Kimi）驱动的修复版本——三个硬伤全部修复：

- **检测参数修正**：`windowMinutes` 5→10、`failureThreshold` 5→4。旧默认对 #381 实测的 60~120s 失败节奏（5 分钟窗口仅 2~5 次）会漏检——即对两个上游 issue 的标志性场景沉默。新默认经数学验证同时覆盖 63s 与 120s 两种节奏，并附回归守护测试
- **日志静默检测（新信号）**：进程存活但 AA 统一日志 ≥ `logSilenceMinutes`（默认 15 分钟）无任何写入 → 判定 wedged（事件循环挂死变体）。健康状态下该日志持续有写入（心跳帧 + 30s 同步 INFO），已实证
- **云端交叉验证真正接线**：`checkDeviceApi` 开启时，本机 healthy 但云端设备连续离线 ≥3 次检查 → 提醒"疑似路由/代理问题"（带 10 分钟冷却，不自动重启——该形态重启无益）
- **多平台通知**：macOS osascript / Linux notify-send / Windows PowerShell 弹窗（best-effort）
- **healthy 日志降噪**：状态变化才写 + 每小时一条心跳（旧版每 30 秒一行，一天 2880 行）
- **文档**：平台支持矩阵（macOS 一等/Linux 尽力/Windows 未测）、ROOT_CAUSE.md 增加实现与设计稿差异注记、README 双语同步

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
