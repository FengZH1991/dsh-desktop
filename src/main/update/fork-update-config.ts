/**
 * Fork update channel: configuration and manifest handling.
 *
 * This fork ships without upstream's `app-update.yml` (see
 * electron-builder.local.cjs: `publish: null`), so the Squirrel-based
 * update-manager has no feed — and could not install through Squirrel anyway,
 * since the local builds are adhoc-signed and Squirrel.Mac requires a real
 * code signature.
 *
 * Instead the app reads a small JSON manifest published as a stable asset on
 * the fork's own GitHub releases:
 *
 *   releases/latest/download/latest-mac.json
 *
 * The manifest names the zip for each architecture together with its sha512.
 * `DSH_FORK_UPDATE_MANIFEST_URL` overrides the baked-in URL so the whole flow
 * can be exercised against a local HTTP server without touching GitHub.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const FORK_UPDATE_MANIFEST_URL_ENV = 'DSH_FORK_UPDATE_MANIFEST_URL'
export const FORK_UPDATE_CONFIG_RESOURCE = 'fork-update.json'

export interface ForkUpdateConfig {
  manifestUrl: string
  releasesApiUrl?: string
}

export interface ForkUpdateFile {
  platform: string
  arch: string
  url: string
  sha512: string
  size: number
}

export interface ForkUpdateManifest {
  version: string
  releaseDate?: string
  notes?: string
  files: ForkUpdateFile[]
}

const FETCH_TIMEOUT_MS = 10_000

export function forkUpdateConfigPath(resourcesPath: string): string {
  return join(resourcesPath, FORK_UPDATE_CONFIG_RESOURCE)
}

/**
 * Resolve the fork update configuration. The environment override wins so a
 * packaged build can be pointed at a local test server; otherwise the JSON
 * resource baked into the app by electron-builder is used. Missing or invalid
 * configuration means this build simply has no fork update channel.
 */
export function loadForkUpdateConfig(
  resourcesPath: string,
  env: NodeJS.ProcessEnv = process.env
): ForkUpdateConfig | undefined {
  const override = env[FORK_UPDATE_MANIFEST_URL_ENV]
  if (override) return { manifestUrl: override }
  try {
    const raw = JSON.parse(readFileSync(forkUpdateConfigPath(resourcesPath), 'utf8')) as Record<
      string,
      unknown
    >
    if (typeof raw.manifestUrl !== 'string' || !raw.manifestUrl) return undefined
    return {
      manifestUrl: raw.manifestUrl,
      releasesApiUrl:
        typeof raw.releasesApiUrl === 'string' && raw.releasesApiUrl
          ? raw.releasesApiUrl
          : undefined
    }
  } catch {
    return undefined
  }
}

export function parseForkUpdateManifest(raw: unknown): ForkUpdateManifest | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.version !== 'string' || !record.version) return undefined
  if (!Array.isArray(record.files)) return undefined
  const files: ForkUpdateFile[] = []
  for (const entry of record.files) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const file = entry as Record<string, unknown>
    if (
      typeof file.platform !== 'string' ||
      typeof file.arch !== 'string' ||
      typeof file.url !== 'string' ||
      !file.url ||
      typeof file.sha512 !== 'string' ||
      !file.sha512 ||
      typeof file.size !== 'number' ||
      !Number.isFinite(file.size)
    ) {
      return undefined
    }
    files.push({
      platform: file.platform,
      arch: file.arch,
      url: file.url,
      sha512: file.sha512,
      size: file.size
    })
  }
  if (files.length === 0) return undefined
  return {
    version: record.version,
    releaseDate: typeof record.releaseDate === 'string' ? record.releaseDate : undefined,
    notes: typeof record.notes === 'string' ? record.notes : undefined,
    files
  }
}

export function selectForkUpdateFile(
  manifest: ForkUpdateManifest,
  platform: string,
  arch: string
): ForkUpdateFile | undefined {
  return manifest.files.find((file) => file.platform === platform && file.arch === arch)
}

/**
 * Derive the manifest URL for one specific release tag from the stable
 * `releases/latest/download/` URL, so "install this past version" can fetch
 * that release's own manifest. Returns undefined when the configured URL does
 * not follow the GitHub `latest/download` convention.
 */
export function manifestUrlForTag(manifestUrl: string, tag: string): string | undefined {
  const marker = '/latest/download/'
  const index = manifestUrl.indexOf(marker)
  if (index < 0) return undefined
  return `${manifestUrl.slice(0, index)}/download/${tag}/${manifestUrl.slice(index + marker.length)}`
}

export async function fetchForkUpdateManifest(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<ForkUpdateManifest> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`更新清单请求失败: HTTP ${response.status}`)
    }
    const manifest = parseForkUpdateManifest(await response.json())
    if (!manifest) {
      throw new Error('更新清单格式无效')
    }
    return manifest
  } finally {
    clearTimeout(timer)
  }
}
