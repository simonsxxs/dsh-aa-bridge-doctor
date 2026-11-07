// 冒烟夹具预载：记录 argv 到夹具 home 下的 flag 文件后永久阻塞（零 CPU），
// 使复制的 node 二进制在标准 argv（主模块 'run' 不存在）下仍长驻——模拟 Connector。
// 路径通过环境变量 DOCTOR_SMOKE_FLAG 传入，避免任何运行时字符串拼接。
const fs = require('node:fs')
try {
  const flag = process.env.DOCTOR_SMOKE_FLAG
  if (flag) fs.appendFileSync(flag, process.argv.join(' ') + '\n')
} catch {}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
