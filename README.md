# dsh-aa-bridge-doctor

**AA Bridge Doctor（桥接医生）** — 一个 [DeepSeek Harness](https://www.deepseek.com) 插件：检测并恢复 **Agents Anywhere 桥接的"持续离线"故障**（Connector 进程活着但连接永久卡死，手机端一直显示设备离线，只能重启电脑上的进程才能恢复）。

* A DeepSeek Harness plugin that detects and auto-recovers the Agents Anywhere bridge "persistent offline" wedge — the Connector process is alive but its connection is permanently stuck, so your phone shows the device offline until someone restarts the process by hand.

## 它解决什么问题 / What it fixes

已确认的上游问题：

- [Agents-Anywhere#381](https://github.com/anywhere-labs/Agents-Anywhere/issues/381) — 认证请求陷入 60~120s **空超时死循环**，设备永久离线，只能重启恢复
- [dsh-desktop#1334](https://github.com/anywhere-labs/dsh-desktop/issues/1334) — Connector 进程**静默退出后无人拉起**，掉线数小时无人知晓
- [#501](https://github.com/anywhere-labs/Agents-Anywhere/issues/501) — DSH Runtime 永久卡在「正在同步 DSH 会话…」

共同形态（与内部故障类无关）：**进程存活 + 连续鉴权失败 + 设备离线**。官方重连机制只会用同一个（可能已坏死的）HTTP 客户端原样重试，永不重建——所以"每 3 秒重试"退化为"每 63~120 秒撞同一堵墙"。

## 工作原理 / How it works

每 `pollSeconds` 秒执行一次只读检查（三源信号）：

1. **进程信号**：读取 `~/.agents-anywhere/connector-runtime.json` 中的 pid，验证进程存活
2. **日志信号**：扫描 `~/.agents-anywhere/logs/runtime-*.jsonl`，统计时间窗口内的鉴权失败次数
3. **日志静默信号**：进程存活但 AA 日志 ≥ `logSilenceMinutes` 无写入 → 事件循环挂死变体
4. （需开启 `checkDeviceApi`）**云端信号**：设备离线交叉验证（连续离线 → 提醒路由/代理问题）+ DSH Runtime 卡「正在同步」检测（#501）

| 判定 | 条件 | 默认动作 |
|---|---|---|
| `exited` | 记录存在但进程死亡。**退出码甄别**：exit=0/143（主动/受控停止形态）**任何年龄段都不自动拉起**；异常退出码经 10 分钟陈旧窗口后自动拉起（#1334 形态）；无退出记录视为未知死亡、立即允许拉起。退出后若有新实例启动过（running 事件），旧记录不再生效 | 通知；`autoRestartExited` 开启且通过上述甄别时**自动重新拉起**（无租约冲突，安全） |
| `wedged` | 进程存活且（窗口内失败 ≥ `failureThreshold` **或** AA 日志静默 ≥ `logSilenceMinutes`——事件循环挂死变体） | 通知；`autoRestartWedged` 开启时**自动重启 Connector**（身份校验→预检→SIGTERM→存活验证） |
| `stuck-syncing` | （需 `checkDeviceApi`）DSH Runtime 卡「正在同步 DSH 会话…」≥ 15 分钟 | 通知恢复指引：设备页对 DeepSeek Harness 重新「一键配置」（#501 形态） |
| `healthy` / `not-installed` | 其余 | 不动作 |

护栏：冷却时间（`cooldownMinutes`）、每日上限（`maxRestartsPerDay`）、所有动作写入 `~/.agents-anywhere/bridge-doctor/bridge-doctor.log`。

拉起方式：优先复用 **DSH NEXT 内置的 uv**（`app.asar.unpacked/@dataiku/uv`）直接构造 argv（空格路径安全），兜底 PATH 上的 `uv`。终止前先做 PID 身份校验（无法确认即放弃——Fail Closed）与启动条件预检；拉起后做存活验证（8 秒窗口）。注意：拉起使用分离进程（detached），DSH 退出后其存续取决于系统进程管理，**不承诺严格随 DSH 退出**。

## 安装 / Install

> 需要：已安装 DeepSeek Harness（社区 DSH NEXT 2.0.x 或官方 0.2.1+）且已安装 `@agents-anywhere/dsh-bridge-next` 并登录。

方式 A — npm（发布后）：

```bash
dsh plugin --profile desktop add dsh-aa-bridge-doctor
```

方式 B — 从源码：

```bash
git clone https://github.com/simonsxxs/dsh-aa-bridge-doctor.git && cd dsh-aa-bridge-doctor
npm install && npm run check
dsh plugin --profile desktop add .
```

方式 C — 手动（无 dsh CLI 时，已实勘 DSH NEXT 的 profile 结构）：

1. 把本目录复制到固定位置（如 `~/plugins/dsh-aa-bridge-doctor`），在该目录 `npm install && npm run build` 产出 `lib/`
2. 编辑 `~/.dsh/profiles/desktop/package.json`：
   - `dependencies` 加 `"dsh-aa-bridge-doctor": "file:~/plugins/dsh-aa-bridge-doctor"`
   - `dsh.profile.bundles` 数组加 `"dsh-aa-bridge-doctor"`
3. 编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，追加条目：
   ```yaml
   - id: dsh-aa-bridge-doctor
     name: dsh-aa-bridge-doctor
     config: {}
   ```
4. 在 profile 目录执行包管理器安装（该目录用 **pnpm**：`pnpm install`；若你的 profile 用 npm 则 `npm install`）
5. 重启 DSH（生效后：设置页出现「AA Bridge Doctor」；日志在 `~/.agents-anywhere/bridge-doctor/`）

> 注：本插件为 host-only（无 `dsh.client` 客户端半区），不依赖 `@deepseek-ai/dsh-client-ui-slots`，因此不存在 [#570](https://github.com/anywhere-labs/Agents-Anywhere/issues/570) 那类"官方桌面端装入后打不开"的兼容风险。

## 配置 / Configuration（DSH 设置页）

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `uvPath` | `''` | 自定义 uv 路径（必须是可执行文件；留空自动发现） |
| `autoRestartExited` | `true` | 进程退出后自动重新拉起 |
| `autoRestartWedged` | `false` | 卡死时自动重启 Connector（默认仅提醒） |
| `failureThreshold` / `windowMinutes` | `4` / `10` | 失败签名（依据 #381 实测 60~120s 节奏反推；旧 5/5 对 120s 节奏漏检） |
| `logSilenceMinutes` | `15` | 日志静默判定（分钟）：进程存活但 AA 日志无写入 |
| `cooldownMinutes` / `maxRestartsPerDay` | `60` / `6` | 自动恢复冷却 / 每日上限（失败的恢复尝试同样消耗配额） |
| `pollSeconds` | `30` | 检查间隔 |
| `checkDeviceApi` | `false` | 联网核对设备状态（读取本机 `account.json` 的 token，仅查询、不落日志） |


## 平台支持 / Platform

| 平台 | 状态 | 说明 |
|---|---|---|
| macOS (Apple Silicon / Intel) | ✅ 一等支持 | 全部功能实测（检测/通知/恢复/护栏） |
| Linux | ⚠️ 尽力支持 | 检测与恢复可用；通知走 `notify-send`（未装则静默）；uv 发现链有 PATH 兜底但未实测 |
| Windows | ❌ 未测 | 代码路径存在（PowerShell 弹窗通知、进程操作），无实机验证，欢迎反馈 |

## 隐私 / Privacy

- 所有检测在**本机完成**；日志内容、会话数据永不离开电脑
- 唯一的网络访问是可选的 `checkDeviceApi`（只读查询设备在线状态），凭据只从本机文件读取、只用于该查询、永不写入日志
- 自动恢复动作与本机文件全部记录在 `~/.agents-anywhere/bridge-doctor/`

## 开发 / Development

```bash
npm install
npm run check   # typecheck + build + 全量单元测试
```

无原生打包依赖（纯 tsc），任何 Node ≥ 22.19 环境可构建。

## 镜像 / Mirror

Gitee 同步仓库：[gitee.com/simonsxx/dsh-aa-bridge-doctor](https://gitee.com/simonsxx/dsh-aa-bridge-doctor)（国内访问更快的只读镜像，以 GitHub 为准）

## 作者 / Author

- **作者**：simon，一个不懂代码的 AI 极客（<simonsxx@qq.com>）
- **微信交流群**：simonsxxs
- **个人网站**：<https://simonsxx.com>
- **GitHub**：<https://github.com/simonsxxs>
- **Gitee**：<https://gitee.com/simonsxx>

背景与技术分析：本插件源于一次真实的桥接故障取证，根因报告见 [docs/ROOT_CAUSE.md](./docs/ROOT_CAUSE.md)。

## License

MIT © simon (https://github.com/simonsxxs)
