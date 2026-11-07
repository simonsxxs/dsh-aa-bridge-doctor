import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isConnectorCommandLine } from '../../src/host/healer.js'

describe('healer.isConnectorCommandLine（PID 复用防线）', () => {
  it('确认是 Connector（uv run anywhere-cli）→ true', () => {
    assert.equal(
      isConnectorCommandLine(
        '/Applications/DSH NEXT.app/uv run --directory /x/connector-source anywhere-cli rpc --config /x/connector.json',
      ),
      true,
    )
  })

  it('路径含空格但确属 Connector → true', () => {
    assert.equal(isConnectorCommandLine('uv run --directory "/x/my dir" anywhere-cli rpc --config "/x/c.json"'), true)
  })

  it('无关进程（sleep）→ false，拒绝终止', () => {
    assert.equal(isConnectorCommandLine('sleep 300'), false)
  })

  it('命令行含 connector.json 的其他用法 → true（宽松匹配可接受）', () => {
    assert.equal(isConnectorCommandLine('tail -f /x/connector.json'), true)
  })

  it('无法验证（ps 不可用/平台不支持）→ null，交由调用方权衡', () => {
    assert.equal(isConnectorCommandLine(null), null)
  })
})
