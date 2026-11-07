import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isConnectorCommandLine, isConnectorExecutable } from '../../src/host/healer.js'

/** 本机安装唯一的 connector 配置路径（身份绑定的锚点） */
const CFG = '/home/u/.agents-anywhere/dsh-bridge-next/connector/connector.json'
const SRC = '/home/u/.agents-anywhere/dsh-bridge-next/connector-source/abc123'
const UV = '/Applications/DSH NEXT.app/.../bin/uv'

describe('healer.isConnectorCommandLine（第一因子：绑定本机 config 路径）', () => {
  it('官方拉起形态（--directory 与 --config 均精确匹配本机安装）→ true', () => {
    assert.equal(
      isConnectorCommandLine(`uv run --directory ${SRC} anywhere-cli rpc --config ${CFG}`, CFG, SRC),
      true,
    )
  })

  it('路径含空格的引号形态 → true', () => {
    assert.equal(
      isConnectorCommandLine(`uv run --directory "${SRC}" anywhere-cli rpc --config "${CFG}"`, CFG, SRC),
      true,
    )
  })

  it('--directory 指向别的目录 → false（评审四轮：sourceDir 也必须精确绑定）', () => {
    assert.equal(
      isConnectorCommandLine(`uv run --directory /other/src anywhere-cli rpc --config ${CFG}`, CFG, SRC),
      false,
    )
  })

  it('venv 直调形态（/x/venv/bin/anywhere-cli rpc --config …）→ true（路径后缀兼容）', () => {
    assert.equal(isConnectorCommandLine(`/x/venv/bin/anywhere-cli rpc --config ${CFG}`, CFG), true)
  })

  it('评审三轮穿透：三关键词但 --config 指向别处 → false', () => {
    assert.equal(
      isConnectorCommandLine(
        '/usr/bin/python3 /tmp/watch-log.py /tmp/report anywhere-cli rpc --config notes.log',
        CFG,
      ),
      false,
    )
  })

  it('评审四轮穿透：无关脚本携带【真实】config 路径与完整形态 → argv 可过，但 comm 因子拦截（见下组）', () => {
    // argv 层面：结构完整且 config 真实 → argv 因子为 true（这正是四轮发现的缺口）
    const argvPass = isConnectorCommandLine(
      `/usr/bin/python3 /tmp/evil.py --directory ${SRC} anywhere-cli rpc --config ${CFG}`,
      CFG,
      SRC,
    )
    assert.equal(argvPass, true)
    // 但 comm=/usr/bin/python3 既非本机 uv、也不在 ~/.agents-anywhere 树内 → 第二因子拒绝
    assert.equal(isConnectorExecutable('/usr/bin/python3', UV), false)
  })

  it('带空格文件名伪造 token 序列（--config 不匹配本机路径）→ false', () => {
    assert.equal(isConnectorCommandLine('tail -f /tmp/report anywhere-cli rpc --config', CFG), false)
  })

  it('--config 路径不完全一致（前缀相似）→ false', () => {
    assert.equal(isConnectorCommandLine(`uv run anywhere-cli rpc --config ${CFG}.bak`, CFG), false)
  })

  it('仅含 connector.json 的无关命令 → false', () => {
    assert.equal(isConnectorCommandLine('tail -f /x/connector.json', CFG), false)
  })

  it('有 config 匹配但缺 rpc → false', () => {
    assert.equal(isConnectorCommandLine(`uv run anywhere-cli --config ${CFG}`, CFG), false)
  })

  it('缺 anywhere-cli token（仅有 rpc 与 --config）→ false', () => {
    assert.equal(isConnectorCommandLine(`uv run something rpc --config ${CFG}`, CFG), false)
  })

  it('引号不闭合（切分失败）→ null → Fail Closed', () => {
    assert.equal(isConnectorCommandLine('uv run --directory "/unfinished', CFG), null)
  })

  it('commandLine 为 null → null', () => {
    assert.equal(isConnectorCommandLine(null, CFG), null)
  })
})

describe('healer.isConnectorExecutable（第二因子：comm allowlist）', () => {
  it('本机 uv（精确等于发现值）→ true', () => {
    assert.equal(isConnectorExecutable(UV, UV), true)
  })

  it('venv python（位于 ~/.agents-anywhere 树内）→ true', () => {
    assert.equal(
      isConnectorExecutable('/home/u/.agents-anywhere/dsh-bridge-next/connector-venv/bin/Python.app/Contents/MacOS/Python', UV),
      true,
    )
    assert.equal(
      isConnectorExecutable('/home/u/.agents-anywhere/dsh-bridge-next/connector-venv/bin/python3', UV),
      true,
    )
  })

  it('系统 python3 / 家目录 uv（非本机发现值、不在树内）→ false（四轮修复核心）', () => {
    assert.equal(isConnectorExecutable('/usr/bin/python3', UV), false)
    assert.equal(isConnectorExecutable('/opt/homebrew/bin/python3', UV), false)
    assert.equal(isConnectorExecutable('/opt/homebrew/bin/uv', UV), false)
  })

  it('tail / sleep / bash / 无关路径 → false（comm 来自内核，不可伪造）', () => {
    assert.equal(isConnectorExecutable('/usr/bin/tail'), false)
    assert.equal(isConnectorExecutable('/bin/sleep'), false)
    assert.equal(isConnectorExecutable('/bin/bash'), false)
    assert.equal(isConnectorExecutable('/tmp/report anywhere-cli rpc --config'), false)
  })

  it('无法获取（ps 失败）→ null → Fail Closed', () => {
    assert.equal(isConnectorExecutable(null), null)
  })
})
