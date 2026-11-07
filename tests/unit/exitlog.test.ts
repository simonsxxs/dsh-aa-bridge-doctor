import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { readLastProcessExit, shouldAutoRelaunchExited } from '../../src/host/exitlog.js'

const MIN = 60_000

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

  it('退出之后有 running 事件（新实例已启动）→ null，旧退出记录不屏蔽恢复（评审修复 #6）', () => {
    const file = writeFixture([
      { id: 1, time: '2026-11-07T04:12:55.940Z', text: '[process] exited (0)' },
      { id: 2, time: '2026-11-07T04:13:04.886Z', text: '[process] running' },
    ])
    assert.equal(readLastProcessExit(file), null)
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })

  it('文件缺失/无退出记录 → null', () => {
    assert.equal(readLastProcessExit('/nonexistent/x.json'), null)
    const file = writeFixture([{ id: 1, time: '2026-11-07T04:13:04.886Z', text: '[process] running' }])
    assert.equal(readLastProcessExit(file), null)
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })
})

describe('exitlog.shouldAutoRelaunchExited（退出码甄别 + 陈旧窗口）', () => {
  const now = Date.parse('2026-11-07T12:00:00Z')

  it('无退出记录 → 允许自动拉起（未知死亡）', () => {
    const r = shouldAutoRelaunchExited(null, now)
    assert.equal(r.auto, true)
  })

  it('exit=0（正常自退）任何年龄段都不自动拉起——用户主动停止形态', () => {
    const fresh = shouldAutoRelaunchExited({ at: new Date(now - 3 * MIN), code: '0' }, now)
    const stale = shouldAutoRelaunchExited({ at: new Date(now - 4 * 60 * MIN), code: '0' }, now)
    assert.equal(fresh.auto, false)
    assert.equal(stale.auto, false, '即使超过 10 分钟，exit=0 仍是主动停止形态，不自动拉起')
  })

  it('exit=143（SIGTERM/面板停止）任何年龄段都不自动拉起——修复"停止后去吃饭回来被拉起"', () => {
    const stale = shouldAutoRelaunchExited({ at: new Date(now - 4 * 60 * MIN), code: '143' }, now)
    assert.equal(stale.auto, false)
    assert.match(stale.reason, /主动\/受控/)
  })

  it('exit=1（异常崩溃）新鲜 → 等待陈旧窗口', () => {
    const r = shouldAutoRelaunchExited({ at: new Date(now - 3 * MIN), code: '1' }, now)
    assert.equal(r.auto, false)
    assert.match(r.reason, /新鲜/)
  })

  it('exit=1（异常崩溃）陈旧（>10 分钟）→ 允许自动拉起（#1334 场景）', () => {
    const r = shouldAutoRelaunchExited({ at: new Date(now - 4 * 60 * MIN), code: '1' }, now)
    assert.equal(r.auto, true)
    assert.match(r.reason, /陈旧/)
  })

  it('退出码为信号名（如 terminated）→ 按异常处理', () => {
    const stale = shouldAutoRelaunchExited({ at: new Date(now - 4 * 60 * MIN), code: '终止' }, now)
    assert.equal(stale.auto, true)
  })
})
