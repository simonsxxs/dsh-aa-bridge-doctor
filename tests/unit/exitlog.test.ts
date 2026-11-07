import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { readLastProcessExit, shouldAutoRelaunchExited } from '../../src/host/exitlog.js'

function writeFixture(entries: Array<{ time: string; text: string }>): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-exit-')), 'connector-output.json')
  fs.writeFileSync(file, JSON.stringify(entries))
  return file
}

describe('exitlog.readLastProcessExit', () => {
  it('从官方 connector-output.json 中取最近一次退出', () => {
    const file = writeFixture([
      { id: 1, time: '2026-11-07T04:12:55.940Z', text: '[process] exited (143)' },
      { id: 2, time: '2026-11-07T04:13:04.886Z', text: '[process] running' },
      { id: 3, time: '2026-11-07T05:00:00.000Z', text: '[process] exited (0)' },
    ])
    const info = readLastProcessExit(file)
    assert.ok(info)
    assert.equal(info.code, '0')
    assert.equal(info.at.toISOString(), '2026-11-07T05:00:00.000Z')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })

  it('文件缺失/无退出记录 → null', () => {
    assert.equal(readLastProcessExit('/nonexistent/x.json'), null)
    const file = writeFixture([{ id: 1, time: '2026-11-07T04:13:04.886Z', text: '[process] running' }])
    assert.equal(readLastProcessExit(file), null)
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })
})

describe('exitlog.shouldAutoRelaunchExited', () => {
  const now = Date.parse('2026-11-07T12:00:00Z')

  it('无退出记录 → 允许自动拉起', () => {
    const r = shouldAutoRelaunchExited(null, now)
    assert.equal(r.auto, true)
  })

  it('刚退出（< 10 分钟）→ 不自动拉起（人为/受控操作）', () => {
    const r = shouldAutoRelaunchExited({ at: new Date(now - 3 * MIN), code: '143' }, now)
    assert.equal(r.auto, false)
    assert.match(r.reason, /人为/)
  })

  it('退出已久（> 10 分钟）→ 允许自动拉起（#1334 场景）', () => {
    const r = shouldAutoRelaunchExited({ at: new Date(now - 4 * 60 * MIN), code: '1' }, now)
    assert.equal(r.auto, true)
    assert.match(r.reason, /陈旧/)
  })
})

const MIN = 60_000
