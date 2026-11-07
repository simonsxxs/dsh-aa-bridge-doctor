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

describe('logscan.parseLine', () => {
  const windowStart = Date.parse('2026-11-07T12:00:00+08:00')

  it('识别官方统一日志格式中的鉴权失败', () => {
    const line =
      '[{"source": "connector", "record": {"time": "2026-11-07T12:07:34.716083+08:00", "level": "WARNING", "name": "connector.server.client", "message": "connector backend network unavailable error=backend authentication request failed: ; reconnecting in 3.0s"}}]'
    const r = parseLine(line, windowStart)
    assert.equal(r.fail, true)
    assert.equal(r.at, '2026-11-07T12:07:34.716083+08:00')
  })

  it('窗口之前的失败不计入', () => {
    const line =
      '[{"source": "connector", "record": {"time": "2026-11-07T07:54:10.246455+08:00", "level": "WARNING", "name": "x", "message": "backend authentication request failed: ; reconnecting"}}]'
    const r = parseLine(line, windowStart)
    assert.equal(r.fail, false)
  })

  it('无关行不报错不计数', () => {
    assert.equal(parseLine('{"hello":"world"}', windowStart).fail, false)
    assert.equal(parseLine('', windowStart).fail, false)
    assert.equal(parseLine('garbage line without json', windowStart).fail, false)
    assert.equal(parseLine('[{"record":{"message":"backend authentication request failed: x"}}]', windowStart).fail, false)
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
