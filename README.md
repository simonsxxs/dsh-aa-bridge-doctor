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
3. （可选）**云端信号**：调用 AA 服务端 API 核对设备在线状态（需开启 `checkDeviceApi`）

| 判定 | 条件 | 默认动作 |
|---|---|---|
| `exited` | 记录存在但进程死亡。**护栏**：退出记录新鲜（< 10 分钟，多半是用户主动停止或插件受控重启）时只提醒不拉起；退出已久无人处理的（#1334 形态）才自动重新拉起 | 通知；`autoRestartExited` 开启且判定为陈旧死亡时**自动重新拉起**（无租约冲突，安全） |
| `wedged` | 进程存活且窗口内失败 ≥ `failureThreshold` | 通知；`autoRestartWedged` 开启时**自动重启 Connector**（SIGTERM→等退出→按原命令行/标准命令重新拉起） |
| `stuck-syncing` | （需 `checkDeviceApi`）DSH Runtime 卡「正在同步 DSH 会话…」≥ 15 分钟 | 通知恢复指引：设备页对 DeepSeek Harness 重新「一键配置」（#501 形态） |
| `healthy` / `not-installed` | 其余 | 不动作 |

护栏：冷却时间（`cooldownMinutes`）、每日上限（`maxRestartsPerDay`）、所有动作写入 `~/.agents-anywhere/bridge-doctor/bridge-doctor.log`。

拉起方式：优先复用 **DSH NEXT 内置的 uv**（`app.asar.unpacked/@dataiku/uv`）直接构造 argv（空格路径安全），兜底 PATH 上的 `uv`，最后才尝试 `ps` 捕获的命令行（校验首个路径真实存在）。拉起的进程与官方插件拉起的一样，**随 DSH NEXT 退出而退出**，不改变任何归属关系。

## 安装 / Install

> 需要：已安装 DeepSeek Harness（社区 DSH NEXT 2.0.x 或官方 0.2.1+）且已安装 `@agents-anywhere/dsh-bridge-next` 并登录。

方式 A — npm（发布后）：

```bash
dsh plugin --profile desktop add dsh-aa-bridge-doctor
```

方式 B — 从源码：

```bash
git clone <repo> && cd dsh-aa-bridge-doctor
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
| `autoRestartExited` | `true` | 进程退出后自动重新拉起 |
| `autoRestartWedged` | `false` | 卡死时自动重启 Connector（默认仅提醒） |
| `failureThreshold` | `5` | 窗口内失败次数阈值 |
| `windowMinutes` | `5` | 失败统计窗口（分钟） |
| `cooldownMinutes` | `60` | 自动恢复冷却 |
| `maxRestartsPerDay` | `6` | 每日自动恢复上限 |
| `pollSeconds` | `30` | 检查间隔 |
| `checkDeviceApi` | `false` | 联网核对设备状态（读取本机 `account.json` 的 token，仅查询、不落日志） |

## 隐私 / Privacy

- 所有检测在**本机完成**；日志内容、会话数据永不离开电脑
- 唯一的网络访问是可选的 `checkDeviceApi`（只读查询设备在线状态），凭据只从本机文件读取、只用于该查询、永不写入日志
- 自动恢复动作与本机文件全部记录在 `~/.agents-anywhere/bridge-doctor/`

## 开发 / Development

```bash
npm install
npm run check   # typecheck + build + 12 项单元测试
```

无原生打包依赖（纯 tsc），任何 Node ≥ 22.19 环境可构建。

## License

MIT
