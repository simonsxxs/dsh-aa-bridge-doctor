# Agents Anywhere 桥接「持续离线」根因分析报告

> 分析日期：2026-11-07 · 样本：simon 的 MacBook Air（macOS，DSH NEXT 2.0.21-next，AA dsh-bridge-next 2.1.0，httpx 0.28.1 / httpcore 1.0.9 / anyio 4.x）
> 结论可信度：日志统计 + 源码行号 + 异常链源码 + 对照实验，四重证据闭环

---

## 一、现象

- 电脑进程活着、整机网络正常（浏览器/其他应用可上网），手机却显示设备**离线**
- 本次持续 **4.3 小时**（07:54–12:12），期间日志唯一线索是一句空泛的报错：
  ```
  connector backend network unavailable error=backend authentication request failed: ; reconnecting in 3.0s
  ```
  冒号后面**是空的**——这个空消息本身就是关键线索

## 二、证据链

### 2.1 日志统计（本次卡死窗口）

| 指标 | 数值 | 含义 |
|---|---|---|
| 鉴权失败总数 | 337 次 | 4.3 小时 |
| 稳态失败间隔 | **中位 63s**（最小 5s / 最大 67s） | = **60 秒挂起超时 + 3 秒退避**，每次尝试都干等满超时 |
| 开头 8 次间隔 | 5~7 秒 | 代理切换瞬间的快速失败，随后转入 63s 死循环 |
| websocket 断开 | 1 次（07:54:04，code=1011 keepalive ping timeout） | 长连接被网络环境变化弄断的时点 |

### 2.2 代码缺陷（dsh-bridge-next connector 源码）

| 位置 | 代码 | 问题 |
|---|---|---|
| `connector/server/client.py:142` | `self._http_client = self._new_http_client(timeout=60)` | 共享 HTTP 客户端超时 60s，与日志节奏吻合 |
| `connector/server/client.py:526` | `trust_env=not is_loopback_url(...)` | `trust_env=True` → 继承环境代理变量，出网路径绑定代理层 |
| `connector/server/auth.py:39` | `client = self._http_client_getter()` | 鉴权**永远复用**共享客户端（工厂分支只在共享为 None 时启用） |
| `connector/server/client.py:146-205` | `while True:` 捕获 `ConnectorNetworkError` → `sleep(3)` → 重来 | **循环内从不重建客户端**（client 只在 243-245 清理路径关闭） |
| `connector/server/auth.py:55` | `f"backend authentication request failed: {exc}"` | 用 `str(exc)` 丢失异常类型，超时时恰为空 |

### 2.3 空错误消息的完整异常链（源码级）

```
anyio.fail_after(60s) 超时
  └─ raise TimeoutError()                      ← 内置异常，无参数
httpcore/_backends/anyio.py:27-33
  └─ map_exceptions: raise ReadTimeout(exc)    ← 把原始异常对象当参数传入
httpx/_transports/default.py:118
  └─ message = str(exc) = str(TimeoutError()) = ""  → ReadTimeout("")
connector/server/auth.py:55
  └─ "backend authentication request failed: "  ← 日志里的空消息
```

**⇒ 日志中的空消息 = 一次耗尽 60 秒超时的挂起，铁证。**

### 2.4 对照实验

- 同机**新进程**：curl（直连/走代理）、connector 同款 venv Python → 全部 200 OK（0.2s）
- 卡死状态**锁定在进程内部**：共享客户端的连接池/路径一旦进入病态，重连循环永远复用它，永不自愈
- 黑洞地址复现：耗尽超时后抛 `ConnectTimeout/ReadTimeout`（SSL 握手路径带 ssl 文本；anyio fail_after 路径为空），行为与日志完全一致

## 三、根因结论（三层叠加）

| 层 | 性质 | 内容 |
|---|---|---|
| A. 触发层（环境） | 普遍 | 代理/TUN 切换、睡眠唤醒瞬间弄断长连接。fake-ip 模式（198.18.0.0/15）下尤其高发 |
| B. 卡死层（**缺陷核心**） | 代码 | 共享 httpx 客户端进入病态后，重连循环永远复用它：**不重建、不降级、不探测**。3 秒重试退化为每 63 秒撞同一堵墙，**永不自愈** |
| C. 观测层（可诊断性） | 代码 | `str(exc)` 吞掉异常类型，空消息让日志失去诊断价值，用户和开发者都无法一眼定位 |

## 四、影响面：为什么肯定不止一个人

满足以下任一条件的用户都会周期性中招：

- 代理工具（Clash/V2Ray/Surge 等）**切换节点或重启** → 长连接断 → 重连卡死循环
- 笔记本**合盖睡眠后唤醒** → 同上
- 路由器重拨 / WiFi 切换 / IP 变化 → 同上

国内 DSH + AA 用户几乎必开代理 → 触发是环境性的，卡死是代码性的。卡死后设备持续离线直到人工重启 Connector 进程——**这就是"有时候桥接不上、一直离线"的完整解释**。

另一个独立场景：重启电脑后 DSH NEXT 未开机自启 → 整条链未运行 → 手机离线（属正常设计，靠登录项解决）。

## 五、上游修复建议（可直接提 issue 给 anywhere-labs/Agents-Anywhere）

1. **可诊断性**：`auth.py` 日志改用 `f"{type(exc).__name__}: {exc}"`（或 `repr(exc)`）→ 一次卡死即可定位到超时类型
2. **自愈核心**：重连循环内计数连续网络失败，**连续 ≥5 次后重建共享客户端**（`aclose()` + `_new_http_client()`）→ 破除进程内病态，手机 1 分钟内自动恢复
3. **鉴权降级**：鉴权请求改走一次性短超时客户端（`auth.py` 已有 `factory(30)` 分支，可改为始终走一次性），或在共享 client 前置一次性探测
4. **超时优化**：鉴权类请求 connect timeout 降到 5–10s，避免每次浪费 60s
5. **可选**：直连/代理双路径探测回退；对 `web.agents-anywhere.com` 提供官方"建议直连"指引

## 六、可分发的 DSH 插件方案：「AA Bridge Doctor」

**定位**：任何装了 `@agents-anywhere/dsh-bridge-next` 的 DSH 用户，装上本插件后，桥接卡死从「离线数小时直到人工重启」变成「自动检测 + 通知 + 一键/自动重启，1 分钟自愈」。

### 功能分层

| 层级 | 能力 | 实现 |
|---|---|---|
| 检测 | tail AA 统一日志 `~/.agents-anywhere/logs/runtime-*.jsonl`，识别签名「进程存活 + 连续鉴权失败 + 超时空消息」；可选调 AA 云端 API 对照设备状态（复用 `~/.agents-anywhere/dsh-bridge-next/account.json` 的 token，只读） | 纯 TS，插件 Host 内定时器 |
| 通知 | macOS 系统通知 + DSH 面板卡片（离线时长、失败计数、根因标签） | osascript / DSH 客户端 UI |
| 自愈 | 经 MeshCall 调 `aa.local.v2.Control.restart`（与 AA 插件同协议、同 DSH 进程内，天然兼容）→ 等效用户点「重启 Connector」，**无需重启 DSH、不打断会话** | 复用 AA 插件同款 typert 生成客户端 |
| 策略 | 阈值可配（连续失败次数 / 持续分钟数）；自动重启 / 仅提醒两种模式；每小时最多一次；动作全量写日志 | 插件设置 |

### 与上游修复的关系

- 上游修复（第五节）是治本，但依赖 AA 团队发版
- 本插件在**任何 AA 版本上**都能兜底（检测+重启路径不依赖上游改代码），上游发版后插件自然变成"监控+保险"

### 分发

- npm 包（如 `dsh-aa-bridge-doctor`）+ GitHub 开源
- 安装：`dsh plugin --profile desktop add dsh-aa-bridge-doctor`（与 AA 插件同安装方式）
- 文档：README 含原理说明（即本报告）、FAQ、卸载

### Roadmap

1. **Phase 1**：上游 issue（英文，附本报告）+ 本地补丁验证（在 connector-source 打补丁验证修复有效）
2. **Phase 2**：插件 MVP——检测 + 通知 + 面板一键重启按钮
3. **Phase 3**：自动自愈模式 + npm/GitHub 分发

## 七、全网同类问题调研（2026-11-07，GitHub 官方仓库）

> 调研方法：GitHub API 精确错误字符串搜索 + 仓库 issue/PR 全量扫描 + main 分支源码比对。搜索命中 300+ 条相关记录。

### 7.1 核心实锤：#381 与本次事故完全同款（OPEN，无官方回应）

[#381 [bug] Desktop Connector 2.0.3 长跑后认证请求陷入 120s 空超时死循环，设备永久离线](https://github.com/anywhere-labs/Agents-Anywhere/issues/381)（2026-10-21 提出，open，**0 条官方评论**）

| 维度 | #381 报告 | 本次事故 |
|---|---|---|
| 错误形态 | `authentication request failed: `（空） | 完全一致 |
| 节奏 | 120s 循环（438/447 个间隔恰为 120.00s） | 63s 循环（60s 超时 + 3s 退避） |
| 持续时长 | 14 小时+、480 次尝试 | 4.3 小时、337 次 |
| 恢复方式 | 只能完全退出重启 App | 重启 Connector 进程 |
| 触发 | 服务端 5xx / 连接重置（**无代理环境**） | 代理切换（Clash fake-ip） |
| 进程内部证据 | **lsof 采样 130s：0 个 TCP socket**，事件循环空闲 | 未采样（沙箱限制），但同款空超时 |

**关键推论**：#381 的环境无代理，等待发生在进程内（0 socket + 空超时 → 与 httpcore 连接池"僵尸获取"形态吻合，参见 encode/httpcore#550）。⇒ **代理只是众多触发器之一**；共享客户端/连接池进入不可恢复状态才是共同根因，任何网络扰动（服务端 5xx、路由变化、代理切换、睡眠唤醒）都可能触发。

### 7.2 其他已确认的桥接问题（全部 OPEN）

| Issue | 问题 | 状态 |
|---|---|---|
| [dsh-desktop#1334](https://github.com/anywhere-labs/dsh-desktop/issues/1334) | Connector 进程**静默退出后无人拉起**：host 只记录 failure 无 respawn，4 小时无通知无诊断 | OPEN |
| [#501](https://github.com/anywhere-labs/Agents-Anywhere/issues/501) | DSH Runtime **永久卡在「启动中 / 正在同步 DSH 会话…」**：Connector 不读 macOS 系统代理 + ingest 硬编码 60s 超时 + 状态上报无重试 → 死循环 | OPEN |
| [#570](https://github.com/anywhere-labs/Agents-Anywhere/issues/570) | **官方 DSH 桌面端 0.2.2-rc.1 装入 dsh-bridge-next 后应用打不开**（客户端依赖 `dsh-client-ui-slots` 缺失 → INACTIVE_EFFECT 宿主退出） | OPEN |
| [#545](https://github.com/anywhere-labs/Agents-Anywhere/issues/545)（修复 PR [#573](https://github.com/anywhere-labs/Agents-Anywhere/pull/573) 待合并） | 管理锁端口被探测即断开 → 未捕获 `write ECONNRESET` → **整个 DSH Host `exit(1)`，桌面端不可用** | PR open |

### 7.3 社区修复尝试的教训：PR #562（已撤回）

[PR #562 "open a fresh pool when reconnecting"](https://github.com/anywhere-labs/Agents-Anywhere/pull/562) 提出了与本书面建议相同的"重连前丢弃连接池"，但**作者主动撤回**，撤回评论值得细读：

> 该作者的事故日志是 `ConnectError`（TCP 根本连不上 = 本地路由问题），不是池化 socket 的读超时——**每次卡死的内部故障类并不相同**（连接池僵尸 / 本地路由失败 / 读挂起）。`discard_route()` 作为加固仍有价值，但不该宣称"治愈"某次具体事故。

**⇒ 对插件设计的启示：不要赌某一种内部故障类；要做的检测签名是「进程存活 + 连续 N 次网络失败 + 设备离线」这个与故障类无关的外层模式，恢复动作统一为"重建客户端（若上游支持）/ 重启 Connector 进程"。**

### 7.4 官方 main（2.2.0 开发中）已吸收的修复

对比本地安装版（2.1.0，无以下任何机制）与 main 源码（`connector/connector/server/network.py`、`client.py`）：

| main 新增 | 说明 | 对应问题 |
|---|---|---|
| `NetworkEgress` + `_EgressTransport` | **egress（路由）变化时自动换新连接池**，旧池闲置后关闭；客户端本身不重建 | 路由变化导致的池病态（部分吸收 #562 思路） |
| 读取 **macOS/Windows 系统代理**（非仅环境变量）+ bypass 列表 + `AA_CONNECTOR_PROXY` 环境变量 + `direct` 模式 | 直答 #501 的代理盲区 | #501 |
| 每次重连前 `_egress.refresh()` | 系统代理开关即插即用，无需重启 Connector | 代理切换场景 |
| 本地代理端口存活探测（0.5s）→ 死了就直连 | "代理 App 退出但系统开关还开着"的兜底 | 常见翻车场景 |
| 心跳停转检测（`backend heartbeat stopped`） | 主动发现死链而非等 keepalive 超时 | 卡死检测 |
| 抖动重连（1–2 倍随机延迟） | 多设备同时掉线不再齐步重连（#555） | 服务端惊群 |
| 证书失败提示 `certificate_hint` | OSError 类错误可诊断 | 可观测性 |
| 已合并：#555/#556/#557/#558/#559/#571 | 服务端写放大、timeline 卡死、插件接入失败（#468）等 | 项目活跃，2.2.0 将带 Tokens Anywhere |

### 7.5 main 仍未修复的缺口（= 插件的价值空间）

1. **同路由连接池僵尸不自愈**：`_current_route()` 只在 **egress 变化**时才换池。#381 场景（无代理、直连、服务端 5xx 触发池僵尸）egress 不变 → **同一池继续复用 → 依然会永久卡死**。缺"连续 N 次失败强制弃池"。
2. **进程静默退出无 respawn**：插件 Host 侧 `child.on("close")` 只记录不重启（dsh-desktop#1334 实锤）。
3. **空错误消息依旧**：timeout 类异常（anyio fail_after 无参数 `TimeoutError`）在日志里仍无类型名；仅 OSError 加了证书提示。
4. **用户侧无操作提示**：设备离线时手机/Web 无"需要电脑端恢复"的指引（#381 期望项 4）。
5. **DSH Runtime 卡「正在同步」无自愈**（#501）：无重试、无降级、无自动重建 runtime 的路径——本次事故本地修复时用云端 API 重建 runtime 实例正是官方缺失的一环。

### 7.6 版本现状（决定插件兼容矩阵）

| 组件 | 版本 | 是否含上述修复 |
|---|---|---|
| DSH NEXT（社区桌面端） | 2.0.21/2.0.22-next（内核 0.2.1-rc.4） | ❌ 内置 bridge 2.1.0（无 NetworkEgress） |
| 官方 DSH Desktop | 0.2.2-rc.1 | ❌ 且与 bridge 插件不兼容（#570） |
| npm `@agents-anywhere/dsh-bridge-next` latest | 2.1.0 | ❌ |
| 仓库 main（2.2.0-dev） | 迁移至 v2_53 | 部分修复（见 7.5 缺口） |

**⇒ 插件必须按"检测签名与版本无关、恢复动作分版本兜底"设计：检测层吃日志/进程/API 三源信号（全版本通用）；恢复层在旧版走"重启 Connector 进程"，新版可优先尝试轻量动作。**

## 附：本次 incident 时间线（2026-11-07）

```
07:54:04  websocket 断开（keepalive ping timeout，代理切换瞬间）
07:54:10  转入卡死循环：60s 挂起 + 空消息报错，每 63s 一轮
12:12:54  人工重启 Connector → 4 秒内云端恢复
12:13+    发现 DSH 运行时注册丢失（另一独立问题）→ 调云端 API 重建
12:41     Bridge 重连、15 个 DSH 会话上云、手机恢复
```
