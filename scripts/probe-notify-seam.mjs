/**
 * Verify the notification seam end to end, in the order the app actually does it.
 *
 * The design rests on two claims that are both easy to get wrong:
 *
 *  1. A hook in the page's main world can hand frames to the isolated preload
 *     world through the shared `window`, because it cannot see the preload's
 *     `contextBridge` objects. If that is wrong the path is silently dead.
 *  2. The hook must be installed *before* the page's own scripts run. The
 *     official client opens its Remote socket during page load, so a wrap
 *     applied on `did-finish-load` never sees a single frame.
 *
 * So this probe mirrors the app: a real preload that installs the real hook
 * source via `webFrame.executeJavaScript` at load time, loads a real Harness
 * page, and reports whether the client's own frames reached the isolated world.
 *
 * Run:  npx electron scripts/probe-notify-seam.mjs
 * Read: cat "${TMPDIR:-/tmp}/notify-seam.log"
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { WEBSOCKET_HOOK_SOURCE } from '../src/main/desktop-notify.ts'

const OUT = join(tmpdir(), 'notify-seam.log')
const PRELOAD = join(tmpdir(), 'notify-seam-preload.cjs')
const HARNESS_ENTRY = join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const log = (m) => appendFileSync(OUT, `${m}\n`)

/**
 * A preload standing in for the app's: it installs the hook at load time, just
 * like the real one, then reports the frames it collects over the seam.
 */
const PRELOAD_SOURCE = `
const { ipcRenderer, webFrame } = require('electron')
const received = []
window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const payload = event.data
  if (!payload || payload.__dshNotifyFrame !== true) return
  received.push(payload)
})
ipcRenderer.on('seam-ask', () => {
  const sample = JSON.stringify(received.slice(0, 3).map((r) => String(r.data).slice(0, 120)))
  ipcRenderer.send('seam-count', received.length, sample)
})
webFrame.executeJavaScript(${JSON.stringify(WEBSOCKET_HOOK_SOURCE)}).then(
  (r) => ipcRenderer.send('seam-hook', String(r)),
  (e) => ipcRenderer.send('seam-hook', 'error: ' + String(e))
)
`
writeFileSync(PRELOAD, PRELOAD_SOURCE)

function nodeBin() {
  if (process.env.DSH_PROBE_NODE) return process.env.DSH_PROBE_NODE
  return spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
}

function start() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-seam-'))
  const child = spawn(nodeBin(), [HARNESS_ENTRY, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    env: { ...process.env, DSH_HOME: home, NO_COLOR: '1', DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let out = ''
  const urlReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('url timeout')), 90_000)
    const scan = (b) => {
      out += b.toString()
      const m = /dsh web:\s*(\S+)/u.exec(out)
      if (m) { clearTimeout(timer); resolve(m[1]) }
    }
    child.stdout.on('data', scan)
    child.stderr.on('data', scan)
  })

  ipcMain.on('seam-hook', (_e, result) => log(`[1] hook install result: ${result}`))
  ipcMain.on('seam-count', (_e, count, sample) => {
    log(`[3] preload received ${count} frame(s) from the live client`)
    if (count > 0) log(`[3a] sample: ${sample}`)
  })

  urlReady.then(async (url) => {
    log('[0] harness url captured')
    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: PRELOAD }
    })
    await win.loadURL(url)
    log('[2] page loaded')

    await new Promise((r) => setTimeout(r, 15_000))
    win.webContents.send('seam-ask')

    setTimeout(() => {
      child.kill('SIGTERM')
      app.exit(0)
    }, 2500)
  }, (e) => { log(`[ERR-URL] ${e}`); app.exit(1) })
}

app.whenReady().then(start, (e) => { log(`[ERR-READY] ${e}`); app.exit(1) })
