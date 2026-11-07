import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { classify, type DetectorInput } from '../../src/host/detector.js'
import { parseLine, scanRecentFailures } from '../../src/host/logscan.js'
import { splitCommandLine } from '../../src/host/process.js'

const base: DetectorInput = {
  runtimeRecordExists: true,
  processAlive: true,
  failuresInWindow: 0,
  failureThreshold: 5,
}

describe('detector.classify', () => {
  it('未安装时不做任何动作', () => {
    const out = classify({ ...base, runtimeRecordExists: false, processAlive: false })
    assert.equal(out.state, 'not-installed')
    assert.equal(out.shouldNotify, false)
    assert.equal(out.healApplicable, false)
  })

  it('健康状态', () => {
    const out = classify(base)
    assert.equal(out.state, 'healthy')
    assert.equal(out.shouldNotify, false)
  })

  it('失败数低于阈值 → 健康', () => {
    const out = classify({ ...base, failuresInWindow: 4 })
    assert.equal(out.state, 'healthy')
  })

  it('进程存活 + 失败达阈值 → wedged', () => {
    const out = classify({ ...base, failuresInWindow: 5 })
    assert.equal(out.state, 'wedged')
    assert.equal(out.shouldNotify, true)
    assert.equal(out.healApplicable, true)
  })

  it('进程死亡 → exited（dsh-desktop#1334 形态），即使没有失败记录', () => {
    const out = classify({ ...base, processAlive: false, failuresInWindow: 0 })
    assert.equal(out.state, 'exited')
    assert.equal(out.shouldNotify, true)
    assert.equal(out.healApplicable, true)
  })

  it('死亡 + 失败同时存在 → 优先 exited', () => {
    const out = classify({ ...base, processAlive: false, failuresInWindow: 99 })
    assert.equal(out.state, 'exited')
  })
})

describe('detector.classify（日志静默变体 + 默认参数覆盖验证）', () => {
  it('进程存活但日志静默 ≥ 阈值 → wedged（事件循环挂死特征）', () => {
    const out = classify({ ...base, failuresInWindow: 0, newestLogAgeMin: 20, logSilenceMinutes: 15 })
    assert.equal(out.state, 'wedged')
    assert.match(out.reason, /日志已静默/)
    assert.equal(out.healApplicable, true)
  })

  it('日志静默未达阈值 → healthy', () => {
    const out = classify({ ...base, newestLogAgeMin: 10, logSilenceMinutes: 15 })
    assert.equal(out.state, 'healthy')
  })

  it('newestLogAgeMin 为 null（日志文件缺失）→ 不触发静默判定', () => {
    const out = classify({ ...base, newestLogAgeMin: null, logSilenceMinutes: 15 })
    assert.equal(out.state, 'healthy')
  })

  it('默认参数对 63s 节奏覆盖（本机事故形态）：10 分钟窗口 ≥4 次', () => {
    const cadence63 = Math.floor((10 * 60) / 63) // ≈9
    const out = classify({ ...base, failuresInWindow: cadence63, failureThreshold: 4 })
    assert.equal(out.state, 'wedged')
  })

  it('默认参数对 120s 节奏覆盖（#381 形态）：10 分钟窗口 ≥4 次', () => {
    const cadence120 = Math.floor((10 * 60) / 120) // =5
    const out = classify({ ...base, failuresInWindow: cadence120, failureThreshold: 4 })
    assert.equal(out.state, 'wedged')
  })

  it('旧默认（5 分钟/5 次）对 63s 节奏确实漏检——证明改参必要（回归守护）', () => {
    const cadence63 = Math.floor((5 * 60) / 63) // =4
    const out = classify({ ...base, failuresInWindow: cadence63, failureThreshold: 5, windowMinutes: 5 } as DetectorInput)
    assert.equal(out.state, 'healthy') // 旧参数下确实检不出——这就是为什么改了默认
  })
})

describe('logscan.parseLine', () => {
  const windowStart = Date.parse('2026-11-07T12:00:00+08:00')

  it('识别官方统一日志格式中的鉴权失败', () => {
    const line =
      '[{"source": "connector", "record": {"time": "2026-11-07T12:07:34.716083+08:00", "level": "WARNING", "name": "connector.server.client", "message": "connector backend network unavailable error=backend authentication request failed: ; reconnecting in 3.0s"}}]'
    const r = parseLine(line, windowStart)
    assert.equal(r.failCount, 1)
    assert.equal(r.lastFailAt, '2026-11-07T12:07:34.716083+08:00')
  })

  it('一行数组含多条失败记录时逐条计数（评审修复）', () => {
    const rec = (t, msg) => ({ source: 'connector', record: { time: t, level: 'WARNING', name: 'x', message: msg } })
    const line = JSON.stringify([
      rec('2026-11-07T12:01:00+08:00', 'heartbeat ok'),
      rec('2026-11-07T12:02:00+08:00', 'backend authentication request failed: ; reconnecting'),
      rec('2026-11-07T12:03:00+08:00', 'backend authentication request failed: ; reconnecting'),
      rec('2026-11-07T12:04:00+08:00', 'another info'),
    ])
    const r = parseLine(line, windowStart)
    assert.equal(r.failCount, 2)
    assert.equal(r.lastFailAt, '2026-11-07T12:03:00+08:00')
    assert.equal(r.newestAt, '2026-11-07T12:04:00+08:00')
  })

  it('窗口之前的失败不计入', () => {
    const line =
      '[{"source": "connector", "record": {"time": "2026-11-07T07:54:10.246455+08:00", "level": "WARNING", "name": "x", "message": "backend authentication request failed: ; reconnecting"}}]'
    const r = parseLine(line, windowStart)
    assert.equal(r.failCount, 0)
  })

  it('无关行不报错不计数', () => {
    assert.equal(parseLine('{"hello":"world"}', windowStart).failCount, 0)
    assert.equal(parseLine('', windowStart).failCount, 0)
    assert.equal(parseLine('garbage line without json', windowStart).failCount, 0)
    assert.equal(parseLine('[{"record":{"message":"backend authentication request failed: x"}}]', windowStart).failCount, 0)
  })
})

describe('process.splitCommandLine', () => {
  it('解析带空格路径的引号参数', () => {
    const args = splitCommandLine(
      '/Applications/DSH NEXT.app/uv run --directory "/Users/s/my dir/src" anywhere-cli rpc --config "/Users/s/my dir/connector.json"',
    )
    assert.ok(args)
    assert.equal(args.length, 9)
    assert.equal(args[3], '--directory')
    assert.equal(args[4], '/Users/s/my dir/src')
    assert.equal(args[8], '/Users/s/my dir/connector.json')
  })

  it('引号不闭合时拒绝', () => {
    assert.equal(splitCommandLine('uv run --directory "/unfinished'), null)
  })

  it('空串返回 null', () => {
    assert.equal(splitCommandLine('   '), null)
  })
})

describe('logscan.scanRecentFailures（跨轮转文件）', () => {
  function line(time: string, marker = true): string {
    const msg = marker ? 'backend authentication request failed: ; reconnecting in 3.0s' : 'heartbeat sent'
    return JSON.stringify([
      { source: 'connector', record: { time, level: marker ? 'WARNING' : 'INFO', name: 'connector.server.client', message: `connector backend network unavailable error=${msg}` } },
    ])
  }

  it('窗口跨越轮转边界时，旧文件尾部与新城文件都计入', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-logscan-'))
    const now = Date.now()
    // 旧文件：T-6min 与 T-4min 各一次失败（T-4min 在窗口内）
    const old = [
      line(new Date(now - 6 * MIN).toISOString()),
      line(new Date(now - 4 * MIN).toISOString()),
    ].join('\n')
    // 新文件：T-1min 一次失败
    const cur = line(new Date(now - 1 * MIN).toISOString())
    fs.writeFileSync(path.join(dir, 'runtime-00000000000000000100.jsonl'), old + '\n')
    fs.writeFileSync(path.join(dir, 'runtime-00000000000000000101.jsonl'), cur + '\n')
    const r = scanRecentFailures(dir, 5, now)
    assert.equal(r.failures, 2)
    assert.ok(r.lastFailureAt!.startsWith(new Date(now - 1 * MIN).toISOString().slice(0, 16)))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('旧文件整段超出窗口 → 只计新文件的', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-logscan-'))
    const now = Date.now()
    const old = line(new Date(now - 60 * MIN).toISOString())
    const cur = line(new Date(now - 1 * MIN).toISOString())
    fs.writeFileSync(path.join(dir, 'runtime-00000000000000000200.jsonl'), old + '\n')
    fs.writeFileSync(path.join(dir, 'runtime-00000000000000000201.jsonl'), cur + '\n')
    const r = scanRecentFailures(dir, 5, now)
    assert.equal(r.failures, 1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('日志目录不存在 → 0 次失败', () => {
    const r = scanRecentFailures('/nonexistent/logs-dir-xyz', 5)
    assert.equal(r.failures, 0)
  })
})

const MIN = 60_000
