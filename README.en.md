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
| `exited` | record exists, process dead. **Guard**: a fresh exit (< 10 min, likely a manual stop) only notifies; a stale silent death auto-relaunches (per dsh-desktop#1334) | notify; auto-relaunch when `autoRestartExited` |
| `wedged` | process alive, failures ≥ `failureThreshold` | notify; auto-restart when `autoRestartWedged` (SIGTERM → wait → relaunch) |
| `stuck-syncing` | (needs `checkDeviceApi`) DSH Runtime stuck at "Syncing DSH sessions…" ≥ 15 min | notify with recovery guidance (#501 shape) |
| `healthy` / `not-installed` | otherwise | no action |

Guardrails: cooldown between heals, per-day cap, PID-reuse protection (never kills a process whose command line isn't the Connector), full action log at `~/.agents-anywhere/bridge-doctor/`.

Relaunch path: prefers the **uv bundled with DSH NEXT** (`app.asar.unpacked/@dataiku/uv`), falls back to `PATH`, constructs argv directly (spaces-safe). The relaunched process lives and dies exactly like the official plugin's own child.

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
| `uvPath` | `''` | custom uv path (empty = auto-discover) |
| `autoRestartExited` | `true` | auto-relaunch after process exit (guarded) |
| `autoRestartWedged` | `false` | auto-restart on wedge (default notify-only) |
| `failureThreshold` / `windowMinutes` | `5` / `5` | wedge signature |
| `cooldownMinutes` / `maxRestartsPerDay` | `60` / `6` | anti-flapping |
| `pollSeconds` | `30` | check interval |
| `checkDeviceApi` | `false` | cloud cross-check incl. #501 detection |

## Privacy

Everything runs locally. The only network access is the optional `checkDeviceApi` read-only status query; credentials are read from your local `account.json`, used solely for that query, and never logged.

## Development

```bash
npm install
npm run check   # typecheck + build + 30 unit tests
npx tsx scripts/smoke-apply.mjs   # lifecycle integration smoke (tmp fixtures)
npx tsx scripts/smoke-heal.mjs    # hermetic kill→relaunch mechanics smoke
```

Pure-tsc build, no native bundler, Node ≥ 22.19.

## Author

**simon** — [github.com/simonsxxs](https://github.com/simonsxxs)

This plugin was born from a real-world incident investigation; see [docs/ROOT_CAUSE.md](./docs/ROOT_CAUSE.md) for the full root-cause analysis.

## License

MIT © simon (https://github.com/simonsxxs)
