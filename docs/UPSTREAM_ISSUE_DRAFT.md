# Draft comment for Agents-Anywhere#381 (English)

> 用途：以评论形式贴到 https://github.com/anywhere-labs/Agents-Anywhere/issues/381 ，
> 或作为新 issue 的正文（去掉开头称呼）。提交前请把 `<your-machine>` 等占位符替换为你的实际信息。
> 本文由对本机事故的完整取证 + 对 main 分支源码比对得出，可直接引用。

---

Independent reproduction and additional evidence — the wedge also reproduces on **DSH-plugin-managed Connectors** (not only Desktop), and it is still reachable on current `main`.

## Environment

- DSH NEXT desktop 2.0.21-next (kernel `@deepseek-ai/dsh` 0.2.1-rc.4), macOS (Apple Silicon)
- `@agents-anywhere/dsh-bridge-next` 2.1.0 (bundled connector source `connector-source/4cddd9eece9f3bb8`, httpx 0.28.1 / httpcore 1.0.9)
- Server: hosted `https://web.agents-anywhere.com` (`/api/v2/health` → 200)
- Connector launched as plugin child: `uv run --directory <connector-source> anywhere-cli rpc --config ~/.agents-anywhere/dsh-bridge-next/connector/connector.json`

## Incident timeline (2026-11-07, UTC+8)

| Time | Event |
|---|---|
| 07:54:04 | `backend websocket closed code=1011 reason='keepalive ping timeout'` (proxy/TUN switch on the machine) |
| 07:54:10 | First `backend authentication request failed: ` (**empty detail**) — fast failures for ~40s |
| 07:55 → 12:12 | Steady wedge loop: **337 failures over 4.3 h; median interval 63.0 s** (= the shared client's 60 s timeout + the 3 s reconnect backoff) |
| 12:12:54 | Restarted the Connector via the plugin panel → connected within 4 s, heartbeats fine ever since |

During the whole window the machine's network was healthy (direct and proxied curls from fresh processes returned 200 in ~0.2 s), so — same as this issue's finding — the failure lived **inside the long-lived process**, while fresh processes worked immediately.

## Why the detail is empty (source-level)

With httpx 0.28.1 / httpcore 1.0.9 / anyio 4.x:

1. `anyio.fail_after()` raises the builtin `TimeoutError()` with **no arguments**.
2. httpcore's `map_exceptions` re-raises as `ReadTimeout(original_exception)` — the *object* is the argument, so `str()` stays empty.
3. httpx's `map_httpcore_exceptions` builds `mapped_exc(str(exc))` → still empty.
4. `connector/server/auth.py` wraps it into `f"backend authentication request failed: {exc}"` → the log line we all see.

**An empty detail in this code path is a timeout that burned the client's full 60 s.** Logging `f"{type(exc).__name__}: {exc}"` (or `repr(exc)`) would make every future incident self-describing.

## What we verified

- The record is present, the credential is valid (`POST /connector/auth` with the saved `Connector <id>:<token>` returns 200 — a 401 would instead log `connector authentication failed; stopping`, which never appears).
- Fresh processes (curl / the connector's own venv Python, direct **and** through the proxy) all succeed while the wedged process keeps failing → the broken state is pinned to the process (wedged pooled client), matching this issue's pool hypothesis and httpcore#550-style zombie behaviour.
- The retry loop (`run_forever`) reuses the same shared `AsyncClient` forever: no client rebuild, no one-shot fallback for auth, no failure-counter escalation. On 2.1.0 the client is only closed on the shutdown path.

## Status on `main` (2.2.0-dev)

Great progress already — `NetworkEgress`/`_EgressTransport` (route rebuild on egress change), system-proxy reading, `AA_CONNECTOR_PROXY`, local-proxy-liveness probe, jittered reconnect, heartbeat-stopped detection, certificate hints. Two gaps remain relevant to this issue:

1. **Same-route pool wedge is still not healed.** `_current_route()` swaps pools only when the resolved egress *changes*. When the route stays constant (no proxy at all, as in #381) and the pool wedges anyway, retries keep landing on the same pool. A cheap escalation would close it: after **N consecutive** `ConnectorNetworkError`s, retire the route/pool (`discard_route()`-style — see the withdrawn #562, whose author also agreed it is "a defensible hardening on its own terms") and/or fall back to a one-shot client for `ensure_access_token`.
2. **Timeout-class errors still log empty.** Adding the exception class name costs one line and would have made this diagnosable in one glance instead of a 4-hour blind loop.

For completeness: the DSH-plugin side has a related but distinct gap — when the Connector process exits unexpectedly the host records it but does not respawn (anywhere-labs/dsh-desktop#1334), so a wedge *or* a silent death both end in "device offline until a human notices".

Happy to provide the full log timeline (337 entries, sanitized) or run any proposed patch against this machine.

---

## 中文对照要点（提交时可删）

- 独立复现：插件管理的 Connector 同样中招，且 main 仍可触发（同路由池僵尸不自愈）
- 空消息 = 耗尽 60s 超时（anyio 无参数 TimeoutError → httpcore/httpx 层层转传丢文本）
- 凭据有效、新鲜进程秒通 → 卡死锁定在进程内共享客户端
- 两条具体修复诉求：①连续 N 次失败后弃池重建/鉴权改一次性短超时 client；②日志带异常类型名
- 关联：dsh-desktop#1334（进程退出无 respawn）
