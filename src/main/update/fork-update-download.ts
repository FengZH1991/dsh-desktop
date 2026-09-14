/**
 * Fork update channel: download transport.
 *
 * Streams the release zip to disk with byte-level progress, then verifies the
 * sha512 from the manifest before anything is allowed near /Applications.
 * The fetch implementation is injected by the caller: the manager passes
 * Electron's `net.fetch` (which honors the system proxy, important for
 * reaching GitHub here), while tests pass a plain stub — this module never
 * imports Electron so it stays unit-testable.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { join } from 'node:path'

import type { ForkUpdateFile } from './fork-update-config'

export function pendingUpdateRoot(userDataPath: string): string {
  return join(userDataPath, 'pending-update')
}

/**
 * Wipe leftovers from earlier runs: half downloads, consumed staging
 * directories, generated swap scripts. Called once when the manager starts.
 */
export function clearPendingUpdates(userDataPath: string): void {
  rmSync(pendingUpdateRoot(userDataPath), { recursive: true, force: true })
}

export async function downloadForkUpdateFile(
  file: ForkUpdateFile,
  userDataPath: string,
  onProgress: (percent: number) => void,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<string> {
  const root = pendingUpdateRoot(userDataPath)
  mkdirSync(root, { recursive: true })
  const destination = join(root, `update-${file.arch}.zip`)

  const response = await fetchImpl(file.url)
  if (!response.ok || !response.body) {
    throw new Error(`更新包下载失败: HTTP ${response.status}`)
  }

  const total = Number(response.headers.get('content-length')) || file.size
  let received = 0
  const reader = response.body.getReader()
  const writer = createWriteStream(destination)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (!writer.write(value)) {
        await once(writer, 'drain')
      }
      if (total > 0) onProgress((received / total) * 100)
    }
  } finally {
    writer.end()
    await once(writer, 'close').catch(() => undefined)
  }

  const digest = await sha512Base64(destination)
  if (digest !== file.sha512) {
    rmSync(destination, { force: true })
    throw new Error('更新包 SHA-512 校验失败，已丢弃')
  }
  onProgress(100)
  return destination
}

function sha512Base64(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    createReadStream(filePath)
      .on('data', (chunk: string | Buffer) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('base64')))
  })
}
