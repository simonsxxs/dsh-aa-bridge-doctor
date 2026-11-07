import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findStuckDshRuntime, type DshRuntimeSnapshot } from '../../src/host/device.js'

const MIN = 60_000

function snap(status: string, runtimeId = 'rti_test'): DshRuntimeSnapshot {
  return { runtimeId, status }
}

describe('device.findStuckDshRuntime', () => {
  it('runtime 正常运行时返回 null 并清空计时', () => {
    const seen = new Map<string, number>([['rti_test', Date.now() - 20 * MIN]])
    const out = findStuckDshRuntime(snap('running'), seen, Date.now(), 15)
    assert.equal(out, null)
    assert.equal(seen.size, 0)
  })

  it('starting 未达阈值 → null，且记录首次观测时间', () => {
    const seen = new Map<string, number>()
    const now = Date.now()
    const out = findStuckDshRuntime(snap('starting'), seen, now, 15)
    assert.equal(out, null)
    assert.equal(seen.get('rti_test'), now)
  })

  it('starting 超过阈值 → 返回卡死时长', () => {
    const now = Date.now()
    const seen = new Map<string, number>([['rti_test', now - 20 * MIN]])
    const out = findStuckDshRuntime(snap('starting'), seen, now, 15)
    assert.ok(out)
    assert.equal(out.runtimeId, 'rti_test')
    assert.equal(out.stuckMinutes, 20)
  })

  it('runtime 消失（被重建）→ null 并清空计时', () => {
    const seen = new Map<string, number>([['rti_test', Date.now() - 30 * MIN]])
    const out = findStuckDshRuntime(null, seen, Date.now(), 15)
    assert.equal(out, null)
    assert.equal(seen.size, 0)
  })

  it('状态翻转为 stopped → null（已从卡死恢复或被停止）', () => {
    const seen = new Map<string, number>([['rti_test', Date.now() - 30 * MIN]])
    const out = findStuckDshRuntime(snap('stopped'), seen, Date.now(), 15)
    assert.equal(out, null)
  })
})
