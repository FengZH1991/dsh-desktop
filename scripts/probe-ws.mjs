/**
 * Observe the WebSocket frames the official client exchanges with a real
 * Harness, to prove which host events actually reach the browser.
 *
 * Rather than the CDP debugger — whose `Network.enable` never resolves under
 * this Electron build — the page's own `WebSocket` is wrapped by an injected
 * preload script that forwards every frame to the main process over IPC. That
 * needs no debugger permission and no devtools protocol version.
 *
 * Other traps encoded here:
 *  - `await app.whenReady()` at module top level hangs; `.then()` is reliable.
 *  - `process.execPath` is Electron under Electron; use a real Node binary.
 *  - stdout is swallowed under a non-interactive parent; write to a file.
 *
 * Run:  npx electron scripts/probe-ws.mjs
 * Read: cat /tmp/frames.log
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'

const OUT = '/tmp/frames.log'
const PRELOAD = join(tmpdir(), 'dsh-ws-hook.cjs')
const HARNESS_ENTRY = join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const log = (m) => appendFileSync(OUT, `${m}\n`)

/** The injected hook: wrap WebSocket and forward frames to the main process. */
const HOOK = `
const { ipcRenderer } = require('electron')
const Native = WebSocket
class Probed extends Native {
  constructor(...args) {
    super(...args)
    this.addEventListener('message', (event) => {
      try { ipcRenderer.send('ws-frame', 'RECV', typeof event.data === 'string' ? event.data : '<binary>') } catch {}
    })
  }
  send(data) {
    try { ipcRenderer.send('ws-frame', 'SENT', typeof data === 'string' ? data : '<binary>') } catch {}
    return super.send(data)
  }
}
Probed.prototype.CONNECTING = Native.CONNECTING
Probed.prototype.OPEN = Native.OPEN
Probed.prototype.CLOSING = Native.CLOSING
Probed.prototype.CLOSED = Native.CLOSED
globalThis.WebSocket = Probed
`
writeFileSync(PRELOAD, HOOK)

function nodeBin() {
  if (process.env.DSH_PROBE_NODE) return process.env.DSH_PROBE_NODE
  return spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
}

function start() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
  const child = spawn(nodeBin(), [HARNESS_ENTRY, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    env: { ...process.env, DSH_HOME: home, NO_COLOR: '1', DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  const urlReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('url timeout')), 90000)
    const scan = (b) => {
      out += b.toString()
      const m = /dsh web:\s*(\S+)/u.exec(out)
      if (m) { clearTimeout(timer); resolve(m[1]) }
    }
    child.stdout.on('data', scan)
    child.stderr.on('data', scan)
  })

  const frames = []
  ipcMain.on('ws-frame', (_event, dir, data) => {
    frames.push({ dir, data })
  })

  urlReady.then((url) => {
    log('[1] harness url captured')
    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false, preload: PRELOAD }
    })
    win.loadURL(url).then(() => {
      log('[3] url loaded')
      setTimeout(() => {
        log(`[4] captured ${frames.length} frames`)
        const seen = new Set()
        for (const f of frames) {
          if (!f.data || f.data === '<binary>') continue
          let d
          try {
            const p = JSON.parse(f.data)
            if (Array.isArray(p)) d = `array(${p.length})`
            else {
              d = `type=${p.type}`
              if (typeof p.endpoint === 'string') d += ` endpoint=${p.endpoint}`
              if (p.payload && typeof p.payload === 'object') d += ` plKeys=${Object.keys(p.payload).join('|')}`
              if (typeof p.payload?.event === 'string') d += ` event=${p.payload.event}`
            }
          } catch { d = `nonjson(${f.data.length})` }
          const k = `${f.dir} ${d}`
          if (seen.has(k)) continue
          seen.add(k)
          log(`[F] ${f.dir} ${d}`)
        }
        const s = frames.find((x) => x.dir === 'SENT' && x.data !== '<binary>')
        const r = frames.find((x) => x.dir === 'RECV' && x.data !== '<binary>')
        if (s) log(`[SENT_FULL] ${s.data.slice(0, 900)}`)
        if (r) log(`[RECV_FULL] ${r.data.slice(0, 900)}`)
        child.kill('SIGTERM')
        app.exit(0)
      }, 18000)
    }).catch((e) => { log(`[ERR-LOAD] ${e}`); app.exit(1) })
  }, (e) => { log(`[ERR-URL] ${e}`); app.exit(1) })
}

app.whenReady().then(start, (e) => { log(`[ERR-READY] ${e}`); app.exit(1) })
