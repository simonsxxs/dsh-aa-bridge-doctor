import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { shouldRotateLog, appendLog } from '../../src/host/index.js'

describe('index.appendLog（首写与轮转）', () => {
  it('文件不存在时首写成功（回归：轮转 statSync 吞写）', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-append-')), 'bridge-doctor.log')
    appendLog(file, 'first line')
    assert.equal(fs.existsSync(file), true)
    assert.match(fs.readFileSync(file, 'utf8'), /first line/)
  })

  it('超过 512KB 时滚动为 .1 备份并继续追加', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-append-')), 'bridge-doctor.log')
    fs.writeFileSync(file, 'x'.repeat(512 * 1024 + 1))
    appendLog(file, 'after rotation')
    assert.equal(fs.existsSync(file + '.1'), true)
    assert.match(fs.readFileSync(file, 'utf8'), /after rotation/)
  })
})

describe('index.shouldRotateLog', () => {
  it('超过 512KB → 轮转', () => {
    assert.equal(shouldRotateLog(512 * 1024 + 1), true)
  })

  it('等于或低于 512KB → 不轮转', () => {
    assert.equal(shouldRotateLog(512 * 1024), false)
    assert.equal(shouldRotateLog(0), false)
  })
})
