/**
 * Fork update manager.
 *
 * A drop-in replacement for ./update-manager used by builds that ship without
 * upstream's `app-update.yml` (electron-builder.local.cjs sets
 * `publish: null`): adhoc-signed local builds cannot install through
 * Squirrel.Mac, and must never follow upstream's release channel anyway —
 * that would replace this fork with someone else's build.
 *
 * The IPC surface, status machine, skip-version semantics, and check timers
 * deliberately mirror update-manager so the renderer cannot tell the two
 * apart. Only the transport differs:
 *
 *   check    → GET latest-mac.json from the fork's own GitHub releases
 *   download → stream the zip, verify sha512, ditto-extract, verify the
 *              staged bundle identifier matches the running app
 *   install  → detached swap script + app.exit(), see fork-swap-installer.ts
 *
 * macOS only; there is no swap installer for Windows yet, where the manager
 * reports itself unsupported rather than pretending.
 */
import { app, BrowserWindow, ipcMain, net, powerMonitor, shell } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { UpdateStatus } from '../../shared/contracts'
import {
  shouldCheckAfterResume,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_STARTUP_DELAY_MS,
  UPDATE_STARTUP_JITTER_MS
} from './update-policy'
import { initialUpdateStatus, reduceUpdateStatus, type UpdateStateEvent } from './update-state'
import {
  readSkippedVersion,
  shouldOfferUpdate,
  skippedVersionPath,
  writeSkippedVersion
} from './skipped-version'
import { compareVersions } from './version-catalog'
import {
  fetchForkUpdateManifest,
  loadForkUpdateConfig,
  manifestUrlForTag,
  selectForkUpdateFile,
  type ForkUpdateConfig,
  type ForkUpdateManifest
} from './fork-update-config'
import {
  clearPendingUpdates,
  downloadForkUpdateFile,
  pendingUpdateRoot
} from './fork-update-download'
import {
  appBundlePathFromAppPath,
  backupPathFor,
  findUpdateBackups,
  readBundleIdentifier,
  stageForkUpdate,
  writeSwapScript,
  type SwapPlan
} from './fork-swap-installer'

const TRANSIENT_STATUS_MS = 8_000

let status = initialUpdateStatus(app.getVersion())
let prepareToInstall: (() => Promise<void>) | undefined
let config: ForkUpdateConfig | undefined
let pendingManifest: ForkUpdateManifest | undefined
let stagedAppPath: string | undefined
let startupTimer: NodeJS.Timeout | undefined
let intervalTimer: NodeJS.Timeout | undefined
let resetTimer: NodeJS.Timeout | undefined
let lastCheckedAt = 0
let busy: Promise<unknown> | undefined
let installing = false
let started = false
let handlersRegistered = false
let skippedVersion: string | undefined
let skipLoaded = false
let manualCheck = false
let pendingDowngrade = false

export function getUpdateStatus(): UpdateStatus {
  return { ...status }
}

export function registerForkUpdateHandlers(): void {
  if (handlersRegistered) return
  handlersRegistered = true
  ipcMain.handle('updates:status', () => getUpdateStatus())
  ipcMain.handle('updates:check', () => checkForUpdates(true))
  ipcMain.handle('updates:install', () => installDownloadedUpdate())
  ipcMain.handle('updates:skip', (_event, version: unknown) => skipUpdate(version))
  ipcMain.handle('updates:download', () => downloadAvailableUpdate())
  ipcMain.handle('updates:list-versions', () => listForkReleases())
  ipcMain.handle('updates:install-version', (_event, version: unknown) =>
    installSpecificVersion(version)
  )
}

function skipFile(): string {
  return skippedVersionPath(app.getPath('userData'))
}

function currentSkippedVersion(): string | undefined {
  if (!skipLoaded) {
    skippedVersion = readSkippedVersion(skipFile())
    skipLoaded = true
  }
  return skippedVersion
}

/** Same semantics as update-manager: durable per-version silence. */
export function skipUpdate(version: unknown): UpdateStatus {
  if (typeof version !== 'string' || !version) return getUpdateStatus()
  skippedVersion = version
  skipLoaded = true
  writeSkippedVersion(skipFile(), version)
  transition({ type: 'reset' })
  return getUpdateStatus()
}

export function startForkUpdateManager(options: { prepareToInstall: () => Promise<void> }): void {
  prepareToInstall = options.prepareToInstall
  if (started) return
  started = true

  config = loadForkUpdateConfig(process.resourcesPath)
  if (!supportsForkUpdates() || !config) {
    transition({
      type: 'unsupported',
      message: '此构建未配置 fork 更新源。'
    })
    return
  }

  // A leftover backup means the previous swap worked — we are running the new
  // build — so it can go to the Trash. Stale downloads are wiped as well.
  clearPendingUpdates(app.getPath('userData'))
  for (const backup of findUpdateBackups(appBundlePathFromAppPath(app.getAppPath()))) {
    void shell.trashItem(backup).catch((error: unknown) => {
      console.warn('[fork-updater] could not trash old backup', backup, error)
    })
  }

  startupTimer = setTimeout(
    () => void checkForUpdates(),
    UPDATE_STARTUP_DELAY_MS + Math.random() * UPDATE_STARTUP_JITTER_MS
  )
  intervalTimer = setInterval(() => void checkForUpdates(), UPDATE_CHECK_INTERVAL_MS)
  powerMonitor.on('resume', checkAfterResume)
}

export async function checkForUpdates(manual = false): Promise<UpdateStatus> {
  if (!supportsForkUpdates() || !config) {
    transition(
      { type: 'unsupported', message: '此构建未配置 fork 更新源。' },
      manual
    )
    if (manual) scheduleReset()
    return getUpdateStatus()
  }
  if (busy || ['available', 'downloading', 'downloaded'].includes(status.phase)) {
    return getUpdateStatus()
  }

  transition({ type: 'check', manual })
  manualCheck = manual
  lastCheckedAt = Date.now()

  try {
    const manifest = await fetchForkUpdateManifest(config.manifestUrl, electronFetch())
    if (compareVersions(manifest.version, app.getVersion()) <= 0) {
      transition({ type: 'not-available' })
      scheduleReset()
      return getUpdateStatus()
    }
    if (!shouldOfferUpdate(manifest.version, currentSkippedVersion(), manualCheck)) {
      console.info('[fork-updater] skipping', manifest.version, 'at the user’s request')
      transition({ type: 'reset' })
      return getUpdateStatus()
    }
    pendingManifest = manifest
    transition({ type: 'available', version: manifest.version })
  } catch (error) {
    transition({ type: 'error', message: errorMessage(error) })
    if (manual) scheduleReset()
  }
  return getUpdateStatus()
}

/**
 * Consent and download are one action, exactly like update-manager: nothing
 * leaves the network until the user clicks. The zip is downloaded, verified,
 * extracted, and identity-checked here so install is a pure swap.
 */
export async function downloadAvailableUpdate(): Promise<UpdateStatus> {
  if (status.phase !== 'available' || !pendingManifest || busy) return getUpdateStatus()

  const manifest = pendingManifest
  busy = (async () => {
    const file = selectForkUpdateFile(manifest, 'mac', process.arch)
    if (!file) {
      throw new Error(`没有适配 mac ${process.arch} 架构的更新包`)
    }
    const zipPath = await downloadForkUpdateFile(
      file,
      app.getPath('userData'),
      (percent) => transition({ type: 'progress', percent }),
      electronFetch()
    )
    const staged = await stageForkUpdate(zipPath, manifest.version, app.getPath('userData'))
    const currentBundle = appBundlePathFromAppPath(app.getAppPath())
    const stagedId = readBundleIdentifier(staged)
    const currentId = readBundleIdentifier(currentBundle)
    if (!stagedId || stagedId !== currentId) {
      throw new Error(`更新包不是同一个应用（${stagedId ?? '未知'} ≠ ${currentId ?? '未知'}），已拒绝安装`)
    }
    stagedAppPath = staged
  })()

  try {
    await busy
    transition({ type: 'downloaded', version: manifest.version })
  } catch (error) {
    transition({ type: 'error', message: errorMessage(error) })
    if (status.manual) scheduleReset()
  } finally {
    busy = undefined
  }
  return getUpdateStatus()
}

export async function installDownloadedUpdate(): Promise<void> {
  if (status.phase !== 'downloaded' || !pendingManifest || !stagedAppPath || installing) return
  installing = true

  try {
    const currentBundle = appBundlePathFromAppPath(app.getAppPath())
    const plan: SwapPlan = {
      pid: process.pid,
      currentAppPath: currentBundle,
      stagedAppPath,
      backupPath: backupPathFor(currentBundle, app.getVersion()),
      logPath: join(app.getPath('userData'), 'fork-update-swap.log')
    }
    const scriptPath = writeSwapScript(plan)
    console.info('[fork-updater] swap script ready at', scriptPath)

    // The detached script waits for this PID before touching the bundle.
    spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref()

    await prepareToInstall?.()
    app.exit(0)
  } catch (error) {
    installing = false
    transition({ type: 'error', message: errorMessage(error) }, true)
    scheduleReset()
  }
}

/**
 * Install a chosen past release (downgrades included). The manifest for that
 * tag is fetched from the same GitHub release that carries its zip.
 */
export async function installSpecificVersion(version: unknown): Promise<UpdateStatus> {
  if (typeof version !== 'string' || !version || !config) return getUpdateStatus()
  if (busy || ['checking', 'downloading', 'downloaded'].includes(status.phase)) {
    return getUpdateStatus()
  }

  pendingDowngrade = compareVersions(version, app.getVersion()) < 0
  manualCheck = true
  transition({ type: 'check', manual: true })

  try {
    const url = manifestUrlForTag(config.manifestUrl, `v${version}`)
    if (!url) throw new Error('更新源不支持按版本安装')
    const manifest = await fetchForkUpdateManifest(url, electronFetch())
    if (manifest.version !== version) {
      throw new Error('在更新源未找到该版本')
    }
    pendingManifest = manifest
    transition({ type: 'available', version })
    await downloadAvailableUpdate()
  } catch (error) {
    transition({ type: 'error', message: errorMessage(error) })
    scheduleReset()
  } finally {
    pendingDowngrade = false
  }
  return getUpdateStatus()
}

export function stopForkUpdateManager(): void {
  if (startupTimer) clearTimeout(startupTimer)
  if (intervalTimer) clearInterval(intervalTimer)
  if (resetTimer) clearTimeout(resetTimer)
  startupTimer = undefined
  intervalTimer = undefined
  resetTimer = undefined
  if (started && app.isReady()) powerMonitor.removeListener('resume', checkAfterResume)
}

interface ForkReleaseEntry {
  version: string
  tag: string
  archiveUrl: string
}

async function listForkReleases(): Promise<ForkReleaseEntry[]> {
  if (!config?.releasesApiUrl) return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await electronFetch()(config.releasesApiUrl, { signal: controller.signal })
    if (!response.ok) throw new Error(`版本列表请求失败: HTTP ${response.status}`)
    const releases = (await response.json()) as Array<Record<string, unknown>>
    return releases
      .filter((release) => release.draft !== true && release.prerelease !== true)
      .map((release) => {
        const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
        const version = tag.replace(/^v/, '')
        const archiveUrl = manifestUrlForTag(config?.manifestUrl ?? '', tag)
        return archiveUrl && version ? { version, tag, archiveUrl } : undefined
      })
      .filter((release): release is ForkReleaseEntry => release !== undefined)
      .filter((release) => compareVersions(release.version, app.getVersion()) !== 0)
      .sort((a, b) => compareVersions(b.version, a.version))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Electron's net stack honors the system proxy — which plain undici fetch
 * does not, and GitHub is unreliable without one on this network. The cast is
 * deliberate: Electron's Response implements the subset of the fetch contract
 * used here (ok/status/headers/json/body).
 */
function electronFetch(): typeof fetch {
  return (net?.fetch ?? globalThis.fetch).bind(net) as typeof fetch
}

function transition(event: UpdateStateEvent, manualOverride?: boolean): void {
  if (event.type !== 'reset' && resetTimer) {
    clearTimeout(resetTimer)
    resetTimer = undefined
  }

  status = reduceUpdateStatus(status, event)
  if (manualOverride !== undefined) status.manual = manualOverride
  if (pendingDowngrade && event.type !== 'reset') status.downgrade = true

  console.info('[fork-updater] status', status.phase, status.percent ?? '')
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('updates:status-changed', getUpdateStatus())
  }
}

function scheduleReset(): void {
  if (!status.manual) return
  if (resetTimer) clearTimeout(resetTimer)
  resetTimer = setTimeout(() => transition({ type: 'reset' }), TRANSIENT_STATUS_MS)
}

function checkAfterResume(): void {
  if (shouldCheckAfterResume(lastCheckedAt)) void checkForUpdates()
}

function supportsForkUpdates(): boolean {
  return app.isPackaged && process.platform === 'darwin'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
