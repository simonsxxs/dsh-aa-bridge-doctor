import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classify, type DetectorInput } from '../../src/host/detector.js'
import { parseLine } from '../../src/host/logscan.js'
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
