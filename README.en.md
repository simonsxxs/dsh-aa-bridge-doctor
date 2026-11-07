# dsh-aa-bridge-doctor (English)

**AA Bridge Doctor** — a [DeepSeek Harness](https://www.deepseek.com) plugin that detects and auto-recovers the **Agents Anywhere bridge "persistent offline" wedge**: the Connector process is alive but its connection is permanently stuck, so your phone shows the device offline until someone restarts the process by hand.

> 中文文档见 [README.md](./README.md)（含完整根因分析链接与配置说明）。

## The problem

Confirmed upstream issues:

- [Agents-Anywhere#381](https://github.com/anywhere-labs/Agents-Anywhere/issues/381) — auth requests enter a **60–120s empty-timeout retry loop**, device offline permanently until restart
- [dsh-desktop#1334](https://github.com/anywhere-labs/dsh-desktop/issues/1334) — the Connector process **silently exits and nothing respawns it**
- [#501](https://github.com/anywhere-labs/Agents-Anywhere/issues/501) — DSH Runtime stuck at "Syncing DSH sessions…" forever

The common shape (regardless of the internal failure class): **process alive + repeated auth failures + device offline**. The built-in reconnect reuses the same (possibly wedged) HTTP client forever — it never rebuilds, so "retry every 3s" becomes "hit the same wall every 63–120s" until a human intervenes. Triggers include proxy/node switching, sleep/wake, and Wi-Fi changes — i.e., almost every laptop user.

## What this plugin does

A read-only watcher runs every `pollSeconds` and combines three signals:

1. **Process**: pid from `~/.agents-anywhere/connector-runtime.json`, liveness-checked
2. **Logs**: auth-failure count from `~/.agents-anywhere/logs/runtime-*.jsonl` within the window
3. *(optional)* **Cloud**: device/runtime status from the AA server API (`checkDeviceApi`)

| Verdict | Condition | Default action |
|---|---|---|
| `exited` | record exists, process dead. **Exit-code triage**: exit=0/143 (deliberate/controlled stop) **never auto-relaunches at any age**; abnormal exit codes auto-relaunch after a 10-minute stale window (dsh-desktop#1334); no exit record = unknown death, relaunch allowed immediately. A newer `[process] running` event invalidates the old exit record | notify; auto-relaunch when `autoRestartExited` and triage passes |
| `wedged` | process alive AND (failures ≥ `failureThreshold` OR AA log silent ≥ `logSilenceMinutes` — event-loop hang variant) | notify; auto-restart when `autoRestartWedged` (identity check → preflight → SIGTERM → liveness verification) |
| `stuck-syncing` | (needs `checkDeviceApi`) DSH Runtime stuck at "Syncing DSH sessions…" ≥ 15 min | notify with recovery guidance (#501 shape) |
| `healthy` / `not-installed` | otherwise | no action |

Guardrails: cooldown between heals, per-day cap, PID-reuse protection (never kills a process whose command line isn't the Connector), full action log at `~/.agents-anywhere/bridge-doctor/`.

Relaunch path: prefers the **uv bundled with DSH NEXT** (`app.asar.unpacked/@dataiku/uv`), falls back to `PATH`, constructs argv directly (spaces-safe). Before terminating, the doctor verifies the PID identity (fail-closed: unverifiable means no kill) and pre-flights the launch prerequisites; after launch it verifies the new process survives an 8-second window. Note: the process is spawned detached — its survival after DSH exits depends on system process management and is **not guaranteed to follow DSH**.

## Install

Requires DeepSeek Harness + `@agents-anywhere/dsh-bridge-next` (logged in).

```bash
dsh plugin --profile desktop add dsh-aa-bridge-doctor   # once published
```

Manual install (verified against real DSH NEXT profiles) — see [README.md 方式 C](./README.md).

## Configuration (DSH settings page)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `uvPath` | `''` | custom uv path (must be an executable file; empty = auto-discover) |
| `autoRestartExited` | `true` | auto-relaunch after process exit (guarded) |
| `autoRestartWedged` | `false` | auto-restart on wedge (default notify-only) |
| `failureThreshold` / `windowMinutes` | `4` / `10` | wedge signature (derived from the #381 60–120s cadence; the old 5/5 missed it) |
| `cooldownMinutes` / `maxRestartsPerDay` | `60` / `6` | anti-flapping |
| `logSilenceMinutes` | `15` | log-silence detection while the process is alive |
| `pollSeconds` | `30` | check interval |
| `checkDeviceApi` | `false` | cloud cross-check incl. #501 detection |


## Platform support

| Platform | Status | Notes |
|---|---|---|
| macOS (Apple Silicon / Intel) | ✅ First-class | All features tested (detect/notify/heal/guardrails) |
| Linux | ⚠️ Best-effort | Detection & healing work; notifications via `notify-send` (silent if absent); uv discovery falls back to PATH, untested |
| Windows | ❌ Untested | Code paths exist (PowerShell toast, process ops); no real-machine verification — feedback welcome |

## Privacy

Everything runs locally. The only network access is the optional `checkDeviceApi` read-only status query; credentials are read from your local `account.json`, used solely for that query, and never logged.

## Development

```bash
npm install
npm run check   # typecheck + build + full unit suite
npx tsx scripts/smoke-apply.mjs   # lifecycle integration smoke (tmp fixtures)
npx tsx scripts/smoke-heal.mjs    # hermetic kill→relaunch mechanics smoke
```

Pure-tsc build, no native bundler, Node ≥ 22.19.

## Mirror

Gitee mirror: [gitee.com/simonsxx/dsh-aa-bridge-doctor](https://gitee.com/simonsxx/dsh-aa-bridge-doctor) (read-only mirror for faster access in China; GitHub is authoritative)

## Author / 作者

- **Author / 作者**：simon — 一个不懂代码的 AI 极客 (a non-coder AI geek) <simonsxx@qq.com>
- **WeChat group / 微信交流群**：simonsxxs
- **Website / 个人网站**：<https://simonsxx.com>
- **GitHub**：<https://github.com/simonsxxs>
- **Gitee**：<https://gitee.com/simonsxx>

This plugin was born from a real-world incident investigation; see [docs/ROOT_CAUSE.md](./docs/ROOT_CAUSE.md) for the full root-cause analysis.

## License

MIT © simon (https://github.com/simonsxxs)
