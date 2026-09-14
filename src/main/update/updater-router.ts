/**
 * Update implementation router.
 *
 * Three build flavors exist and each needs a different updater:
 *
 *   - upstream production builds carry `app-update.yml` next to the bundle
 *     resources → Squirrel/electron-updater via ./update-manager;
 *   - local fork builds set `publish: null` but bake in `fork-update.json`
 *     → the swap-based ./fork-update-manager (adhoc signing cannot install
 *     through Squirrel, and upstream's feed would replace this fork with
 *     someone else's build);
 *   - anything else (dev runs, misconfigured packages) → inert handlers that
 *     report "unsupported" so the renderer never dangles.
 *
 * update-manager.ts itself stays untouched so upstream merges apply cleanly;
 * index.ts imports this module instead of it directly.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import type { UpdateStatus } from '../../shared/contracts'
import { initialUpdateStatus } from './update-state'
import { loadForkUpdateConfig } from './fork-update-config'
import {
  checkForUpdates as upstreamCheckForUpdates,
  registerUpdateHandlers as registerUpstreamHandlers,
  startUpdateManager as startUpstreamManager,
  stopUpdateManager as stopUpstreamManager
} from './update-manager'
import {
  checkForUpdates as forkCheckForUpdates,
  registerForkUpdateHandlers,
  startForkUpdateManager,
  stopForkUpdateManager
} from './fork-update-manager'

type Implementation = 'upstream' | 'fork' | 'none'

let chosen: Implementation | undefined

function selectImplementation(): Implementation {
  if (chosen) return chosen
  chosen = 'none'
  if (app.isPackaged) {
    if (existsSync(join(process.resourcesPath, 'app-update.yml'))) {
      chosen = 'upstream'
    } else if (loadForkUpdateConfig(process.resourcesPath)) {
      chosen = 'fork'
    }
  }
  console.info('[updater] implementation:', chosen)
  return chosen
}

export function registerUpdateHandlers(): void {
  switch (selectImplementation()) {
    case 'upstream':
      registerUpstreamHandlers()
      return
    case 'fork':
      registerForkUpdateHandlers()
      return
    default:
      registerInertHandlers()
  }
}

export function startUpdateManager(options: { prepareToInstall: () => Promise<void> }): void {
  switch (selectImplementation()) {
    case 'upstream':
      startUpstreamManager(options)
      return
    case 'fork':
      startForkUpdateManager(options)
      return
    default:
      console.info('[updater] no update channel configured, staying idle')
  }
}

export function stopUpdateManager(): void {
  switch (selectImplementation()) {
    case 'upstream':
      stopUpstreamManager()
      return
    case 'fork':
      stopForkUpdateManager()
  }
}

export async function checkForUpdates(manual = false): Promise<UpdateStatus | undefined> {
  switch (selectImplementation()) {
    case 'upstream':
      return upstreamCheckForUpdates(manual)
    case 'fork':
      return forkCheckForUpdates(manual)
    default:
      return undefined
  }
}

/** The renderer always finds its channels; they just decline politely. */
function registerInertHandlers(): void {
  const status = (): UpdateStatus => ({
    ...initialUpdateStatus(app.getVersion()),
    phase: 'unsupported',
    message: '此构建未配置更新渠道。'
  })
  ipcMain.handle('updates:status', status)
  ipcMain.handle('updates:check', status)
  ipcMain.handle('updates:download', status)
  ipcMain.handle('updates:install', () => undefined)
  ipcMain.handle('updates:skip', status)
  ipcMain.handle('updates:list-versions', () => [])
  ipcMain.handle('updates:install-version', status)
}
