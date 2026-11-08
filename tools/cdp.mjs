#!/usr/bin/env node
// 用 CDP 驱动本机 Chromium，跑屏幕截图 + 页面探测。
// 用法：node tools/cdp.mjs <url> <out.png> [width] [height] [waitMs]
//   或：node tools/cdp.mjs <url> --eval "<js 表达式>"   → 打印返回值

import { spawn } from 'node:child_process'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN =
  process.env.CHROME_BIN ||
  '/Applications/Tabbit Browser.app/Contents/MacOS/Tabbit Browser'

const argv = process.argv.slice(2)
const url = argv[0]
const arg2 = argv[1]

const probe = arg2 === '--eval'
const shotAfter = arg2 === '--shot'
// 形态 A: cdp.mjs URL out.png [w] [h] [wait]
// 形态 B: cdp.mjs URL --eval '<expr>'
// 形态 C: cdp.mjs URL --shot out.png '<setup expr>' [w] [h]
const expr = probe ? argv[2] : shotAfter ? argv[3] : null
const outPng = probe ? null : shotAfter ? argv[2] : arg2
const W = probe ? +(argv[3] || 420) : shotAfter ? +(argv[4] || 420) : +(argv[2] || 420)
const H = probe ? +(argv[4] || 940) : shotAfter ? +(argv[5] || 940) : +(argv[3] || 940)
const WAIT = probe ? 2000 : +(argv[shotAfter ? 6 : 4] || 2500)
if (!url) {
  console.error('用法: cdp.mjs <url> <out.png|--eval expr|--shot out.png setupExpr>')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = await mkdtemp(join(tmpdir(), 'cdp-'))
// 端口被占会导致 CDP 连不上，先探一个空端口
let port = 0
for (let p = 9300; p < 9800; p++) {
  try {
    await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(150) })
  } catch {
    port = p
    break
  }
}
if (!port) port = 9300 + Math.floor(Math.random() * 500)

const child = spawn(BIN, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--hide-scrollbars',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'inherit'], detached: false })

let exited = null
child.on('exit', (code, sig) => {
  exited = `exit code=${code} sig=${sig}`
})

async function waitPort() {
  for (let i = 0; i < 80; i++) {
    if (exited) throw new Error(`Chromium 提前退出 (${exited})`)
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(400),
      })
      if (r.ok) return
    } catch {}
    await sleep(150)
  }
  throw new Error(`Chromium 没起来（端口 ${port}，${exited || '进程还在但没监听'}）`)
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.waiters = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.waiters.has(msg.id)) {
        const { resolve, reject } = this.waiters.get(msg.id)
        this.waiters.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.waiters.has(id)) {
          this.waiters.delete(id)
          reject(new Error(`${method} 超时`))
        }
      }, 180000)
    })
  }
}

try {
  await waitPort()
  const list = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(list.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.addEventListener('open', r)
    ws.addEventListener('error', j)
  })
  const cdp = new CDP(ws)

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 2, mobile: true,
  })

  await cdp.send('Page.navigate', { url })
  await sleep(WAIT)

  if (probe) {
    // 表达式可以返回 Promise；awaitPromise 在外层等待，结果再序列化
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(async()=>{try{const v=await (${expr});return JSON.stringify(v)}catch(e){return 'ERR: '+e.message}})()`,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) console.log('异常:', JSON.stringify(r.exceptionDetails))
    console.log(r.result?.value ?? '(空)')
  } else if (shotAfter && expr) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(async()=>{try{await (${expr});return 'ok'}catch(e){return 'ERR: '+e.message}})()`,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.result?.value !== 'ok') console.log('setup:', r.result?.value)
    await sleep(500)
    // 先量出整页高度，再把视口拉高拍全屏（captureBeyondViewport 与
    // setDeviceMetricsOverride 组合会报 width 反序列化错误，走这条路更稳）
    const m = await cdp.send('Runtime.evaluate', {
      expression: 'Math.min(document.documentElement.scrollHeight, 4000)',
      returnByValue: true,
    })
    const fullH = m.result?.value || H
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: Math.ceil(fullH), deviceScaleFactor: 2, mobile: true,
    })
    await sleep(220)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(outPng, Buffer.from(shot.data, 'base64'))
    console.log(`已写入 ${outPng} (${W}x${Math.ceil(fullH)})`)
  } else {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(outPng, Buffer.from(shot.data, 'base64'))
    console.log(`已写入 ${outPng}`)
  }

  ws.close()
} finally {
  child.kill('SIGKILL')
  await sleep(200)
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
