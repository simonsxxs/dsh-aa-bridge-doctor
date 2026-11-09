# Changelog

## 0.3.2 (2026-11-09)

社区审核（awesome-dsh-plugin #12877，判据 A）修复——从条目 URL 直接安装现在可用：

- `lib/` 构建产物入库（不再被 .gitignore 忽略）：git 安装即含入口文件，无需构建
- 新增 `prepare` 脚本（`npm run build`）：即便产物缺失也会在安装时用 tsc 重建（devDeps 已含 typescript）
- 双保险路径：入库产物（零构建安装）+ prepare（自愈构建）

## 0.3.1 (2026-11-08)

第五轮评审（自审复核）收尾：

- **身份锚点补全**：comm 因子新增第三锚点——本机 connector-source 目录内（`uv run` 在项目目录建 `.venv`，DSH Desktop 内置 connector 形态的 venv 解释器位于此，而非全局 `~/.agents-anywhere` 树）。前缀伪造（`<sourceDir>-2/…`）被拒，已有测试
- **冒烟闭环**：每个场景独立的调用记录路径；② 断言记录次数增量与 relaunch 调用内容、③ 断言本夹具记录 ≥1——"假 uv 被调用"从口头声明变为数据断言
- 清理 ③ 中空等的旧 marker 逻辑（无功能影响）

## 0.3.0 (2026-11-07)

codex CLI 两轮评审驱动的安全强化版本（上轮 3 P0 + 本轮身份伪造/补充组穿透全部修复）：

- **身份判定绑定本机安装（四轮评审迭代至锚定级）**：第一因子要求 --config 下一 token 逐字符等于本机 connector.json 路径、--directory 精确等于本机 connector-source 路径、anywhere-cli 接受裸名与 `/anywhere-cli` 后缀；第二因子 comm 必须等于本 Doctor 发现的 uv 二进制或位于 `~/.agents-anywhere/` 树内（venv python 所在地）——系统 python3 携带完整真实参数的伪造样例也被拒（评审四轮穿透关闭）
- **Fail Closed 全链路**：三处身份校验（首查/终止前复核/SIGKILL 前闸）均为双因子，任一无法验证即不自动终止
- **spawnDetached 挂 error 监听**：异步启动失败（ENOENT 等）不再可能崩溃宿主，由 8 秒存活验证兜底检出
- **恢复验证**：终止前预检启动条件（uv 必须是当前用户可执行文件，含补充组判定）；拉起后 8 秒存活验证，"拉起即成功"改为"验证后才算恢复"
- **退出码甄别**：exit=0/143（主动/受控停止）任何年龄段都不自动拉起；异常退出码经 10 分钟陈旧窗口后拉起；退出后若出现过 running 事件，旧记录不再屏蔽
- **限流内存化**：状态构造时加载一次、内存为准、落盘 best-effort——状态文件写失败不再使冷却/配额失效；失败的恢复尝试同样消耗配额
- **logscan 逐条解析 + 毫秒比较**：一行数组多条记录正确计数；混合时区（+08:00/Z）比较不再误判
- **多平台通知**：macOS osascript / Linux notify-send / Windows PowerShell（best-effort）；README 平台矩阵如实标注
- 测试 57 项单测 + 冒烟 5 场景（含身份拒绝、启动即死拦截）

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
