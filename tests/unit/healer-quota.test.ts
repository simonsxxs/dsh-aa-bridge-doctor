
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { Healer } from '../../src/host/healer.js'
import { aaPaths } from '../../src/host/paths.js'

describe('healer 配额与冷却记账（评审修复 #5：失败尝试同样消耗）', () => {
  function makeHealer(): { healer: Healer; stateFile: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-quota-'))
    const paths = aaPaths(home)
    return { healer: new Healer(paths, () => {}, '/usr/bin/true'), stateFile: paths.doctorState }
  }

  it('recordAttempt 后每日配额立即消耗（maxPerDay=1 时第二次 canHeal 拒绝）', () => {
    const { healer } = makeHealer()
    assert.equal(healer.canHeal('wedged', 60, 1).allowed, true)
    healer.recordAttempt('wedged') // 模拟一次失败尝试（未成功）
    const gated = healer.canHeal('wedged', 60, 1)
    assert.equal(gated.allowed, false)
    assert.match(gated.reason, /上限/)
    const cooled = healer.canHeal('exited', 60, 1)
    assert.equal(cooled.allowed, false, 'exited 与 wedged 分开计时，但共用每日配额')
  })

  it('recordAttempt 触发冷却（同 kind 短期内拒绝）', () => {
    const { healer } = makeHealer()
    healer.recordAttempt('exited')
    const gated = healer.canHeal('exited', 60, 6)
    assert.equal(gated.allowed, false)
    assert.match(gated.reason, /冷却/)
  })
})

describe('状态持久化失败时的限流（评审二轮新 P1：内存态兜底）', () => {
  it('状态文件不可写 → recordAttempt 仍使下一轮 canHeal 拒绝（内存为准）', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-quota-ro-'))
    const paths = aaPaths(home)
    // 用普通文件占据 doctorDir，使 mkdirSync/writeFileSync 失败（先建父目录链）
    fs.mkdirSync(path.dirname(paths.doctorDir), { recursive: true })
    fs.writeFileSync(paths.doctorDir, 'blocker')
    const healer = new Healer(paths, () => {}, '/usr/bin/true')
    healer.recordAttempt('wedged')
    const gated = healer.canHeal('wedged', 60, 6)
    assert.equal(gated.allowed, false, '写盘失败不影响会话内冷却/配额')
    assert.match(gated.reason, /冷却/)
    fs.rmSync(home, { recursive: true, force: true })
  })
})
