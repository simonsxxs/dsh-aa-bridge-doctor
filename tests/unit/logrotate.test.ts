import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { shouldRotateLog } from '../src/host/index.js'

describe('index.shouldRotateLog', () => {
  it('超过 512KB → 轮转', () => {
    assert.equal(shouldRotateLog(512 * 1024 + 1), true)
  })

  it('等于或低于 512KB → 不轮转', () => {
    assert.equal(shouldRotateLog(512 * 1024), false)
    assert.equal(shouldRotateLog(0), false)
  })
})
