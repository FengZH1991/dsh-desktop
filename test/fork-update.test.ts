import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  forkUpdateConfigPath,
  loadForkUpdateConfig,
  manifestUrlForTag,
  parseForkUpdateManifest,
  selectForkUpdateFile,
  FORK_UPDATE_MANIFEST_URL_ENV
} from '../src/main/update/fork-update-config'
import {
  appBundlePathFromAppPath,
  backupPathFor,
  findUpdateBackups,
  generateSwapScript,
  readBundleIdentifier,
  stageForkUpdate
} from '../src/main/update/fork-swap-installer'
import { compareVersions } from '../src/main/update/version-catalog'

const execFile = promisify(execFileCallback)
const projectRoot = path.resolve(import.meta.dirname, '..')
const temporaryRoots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fork-update-test-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

const VALID_MANIFEST = {
  version: '0.1.1-feng.2',
  releaseDate: '2026-09-11T20:00:00.000Z',
  notes: 'test',
  files: [
    { platform: 'mac', arch: 'arm64', url: 'https://example.test/a.zip', sha512: 'abc', size: 10 }
  ]
}

describe('fork update manifest', () => {
  it('parses a valid manifest', () => {
    expect(parseForkUpdateManifest(VALID_MANIFEST)).toMatchObject({ version: '0.1.1-feng.2' })
  })

  it.each([
    ['null', null],
    ['a string', '"nope"'],
    ['missing version', { files: VALID_MANIFEST.files }],
    ['empty files', { version: '1.0.0', files: [] }],
    ['file without sha512', { version: '1.0.0', files: [{ ...VALID_MANIFEST.files[0], sha512: '' }] }],
    ['file without url', { version: '1.0.0', files: [{ ...VALID_MANIFEST.files[0], url: '' }] }]
  ])('rejects %s', (_label, raw) => {
    expect(parseForkUpdateManifest(typeof raw === 'string' ? JSON.parse(raw) : raw)).toBeUndefined()
  })

  it('selects the file matching the running architecture', () => {
    const manifest = parseForkUpdateManifest({
      ...VALID_MANIFEST,
      files: [
        VALID_MANIFEST.files[0],
        { platform: 'mac', arch: 'x64', url: 'https://example.test/x.zip', sha512: 'def', size: 9 }
      ]
    })
    expect(manifest).toBeDefined()
    expect(selectForkUpdateFile(manifest!, 'mac', 'x64')?.url).toBe('https://example.test/x.zip')
    expect(selectForkUpdateFile(manifest!, 'mac', 'arm64')?.url).toBe('https://example.test/a.zip')
    expect(selectForkUpdateFile(manifest!, 'win', 'x64')).toBeUndefined()
  })

  it('orders fork prerelease versions so the channel can advance', () => {
    expect(compareVersions('0.1.1-feng.2', '0.1.1-feng.1')).toBe(1)
    expect(compareVersions('0.1.1-feng.10', '0.1.1-feng.9')).toBe(1)
    expect(compareVersions('0.8.2-feng.1', '0.1.1-feng.9')).toBe(1)
    expect(compareVersions('0.1.1-feng.1', '0.1.1')).toBe(-1)
  })
})

describe('manifestUrlForTag', () => {
  it('rewrites the stable latest URL to a tag-pinned one', () => {
    expect(
      manifestUrlForTag(
        'https://github.com/FengZH1991/dsh-desktop/releases/latest/download/latest-mac.json',
        'v0.1.1-feng.2'
      )
    ).toBe(
      'https://github.com/FengZH1991/dsh-desktop/releases/download/v0.1.1-feng.2/latest-mac.json'
    )
  })

  it('refuses URLs that do not follow the latest/download convention', () => {
    expect(manifestUrlForTag('https://example.test/feed.json', 'v1')).toBeUndefined()
  })
})

describe('fork update config', () => {
  it('prefers the environment override so packaged builds can be tested locally', async () => {
    const root = await tempRoot()
    const config = loadForkUpdateConfig(root, {
      [FORK_UPDATE_MANIFEST_URL_ENV]: 'http://127.0.0.1:9999/latest-mac.json'
    } as NodeJS.ProcessEnv)
    expect(config?.manifestUrl).toBe('http://127.0.0.1:9999/latest-mac.json')
  })

  it('falls back to the baked resource file', async () => {
    const root = await tempRoot()
    await writeFile(
      forkUpdateConfigPath(root),
      JSON.stringify({ manifestUrl: 'https://example.test/m.json', releasesApiUrl: 'https://api.example.test' })
    )
    const config = loadForkUpdateConfig(root, {} as NodeJS.ProcessEnv)
    expect(config?.manifestUrl).toBe('https://example.test/m.json')
    expect(config?.releasesApiUrl).toBe('https://api.example.test')
  })

  it('returns undefined when neither source exists', async () => {
    expect(loadForkUpdateConfig(await tempRoot(), {} as NodeJS.ProcessEnv)).toBeUndefined()
  })
})

describe('swap installer', () => {
  it('locates the bundle root from the packaged app path', () => {
    expect(appBundlePathFromAppPath('/Applications/DSH Desktop.app/Contents/Resources/app')).toBe(
      '/Applications/DSH Desktop.app'
    )
    expect(appBundlePathFromAppPath('/Applications/DSH Desktop.app')).toBe(
      '/Applications/DSH Desktop.app'
    )
  })

  it('reads the bundle identifier from Info.plist', async () => {
    const root = await tempRoot()
    const bundle = path.join(root, 'Fake.app')
    await mkdir(path.join(bundle, 'Contents'), { recursive: true })
    await writeFile(
      path.join(bundle, 'Contents', 'Info.plist'),
      '<?xml version="1.0"?><plist><dict>' +
        '<key>CFBundleIdentifier</key>\n<string>io.dsh.desktop</string>' +
        '</dict></plist>'
    )
    expect(readBundleIdentifier(bundle)).toBe('io.dsh.desktop')
    expect(readBundleIdentifier(path.join(root, 'Missing.app'))).toBeUndefined()
  })

  it('extracts a real zip and finds the .app inside', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'source')
    await mkdir(path.join(source, 'DSH Desktop.app', 'Contents'), { recursive: true })
    await writeFile(
      path.join(source, 'DSH Desktop.app', 'Contents', 'Info.plist'),
      '<plist><dict><key>CFBundleIdentifier</key><string>io.dsh.desktop</string></dict></plist>'
    )
    const zip = path.join(root, 'update.zip')
    await execFile('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', source, zip])

    const userData = path.join(root, 'userData')
    const staged = await stageForkUpdate(zip, '0.1.1-feng.9', userData)
    expect(staged.endsWith('DSH Desktop.app')).toBe(true)
    expect(readBundleIdentifier(staged)).toBe('io.dsh.desktop')
  })

  it('generates a self-contained swap script with wait, rollback, and relaunch', () => {
    const script = generateSwapScript({
      pid: 4242,
      currentAppPath: '/Applications/DSH Desktop.app',
      stagedAppPath: '/tmp/x/pending-update/staged-1/DSH Desktop.app',
      backupPath: backupPathFor('/Applications/DSH Desktop.app', '0.1.1'),
      logPath: '/tmp/x/fork-update-swap.log'
    })
    expect(script).toContain('PID=4242')
    expect(script).toContain("kill -0 \"$PID\"")
    expect(script).toContain("mv \"$CURRENT\" \"$BACKUP\"")
    expect(script).toContain('/usr/bin/ditto "$STAGED" "$CURRENT"')
    expect(script).toContain('rolling back')
    expect(script).toContain('open "$CURRENT"')
    expect(script).toContain('xattr -dr com.apple.quarantine')
    // Paths with spaces must be single-quoted.
    expect(script).toContain("CURRENT='/Applications/DSH Desktop.app'")
    expect(script).toContain("BACKUP='/Applications/DSH Desktop.app.fork-backup-0.1.1'")
  })

  it('finds leftover backups next to the installed bundle', async () => {
    const root = await tempRoot()
    const appPath = path.join(root, 'DSH Desktop.app')
    await mkdir(appPath, { recursive: true })
    await mkdir(path.join(root, 'DSH Desktop.app.fork-backup-0.1.0'), { recursive: true })
    await mkdir(path.join(root, 'Unrelated.app'), { recursive: true })
    expect(findUpdateBackups(appPath)).toEqual([
      path.join(root, 'DSH Desktop.app.fork-backup-0.1.0')
    ])
  })
})

describe('fork updater wiring', () => {
  it('routes index.ts through the implementation router', async () => {
    const main = await readFile(path.join(projectRoot, 'src/main/index.ts'), 'utf8')
    expect(main).toContain("from './update/updater-router'")
    expect(main).not.toContain("from './update/update-manager'")
  })

  it('bakes fork-update.json into local builds, never upstream builds', async () => {
    const local = await readFile(path.join(projectRoot, 'electron-builder.local.cjs'), 'utf8')
    expect(local).toContain('fork-update.json')
    expect(local).toContain('publish: null')

    const pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as {
      build: { extraResources: Array<{ from: string }> }
    }
    expect(pkg.build.extraResources.some((entry) => entry.from.includes('fork-update'))).toBe(false)
  })

  it('points the baked config at this fork, not upstream', async () => {
    const config = JSON.parse(
      await readFile(path.join(projectRoot, 'build/fork-update.json'), 'utf8')
    ) as { manifestUrl: string }
    expect(config.manifestUrl).toContain('github.com/FengZH1991/dsh-desktop/')
    expect(config.manifestUrl).toContain('/latest/download/')
    expect(config.manifestUrl).not.toContain('dshdesktop.com')
  })

  it('keeps the fork manager on the same IPC contract as the renderer expects', async () => {
    const manager = await readFile(
      path.join(projectRoot, 'src/main/update/fork-update-manager.ts'),
      'utf8'
    )
    for (const channel of [
      'updates:status',
      'updates:check',
      'updates:install',
      'updates:skip',
      'updates:download',
      'updates:list-versions',
      'updates:install-version'
    ]) {
      expect(manager).toContain(`ipcMain.handle('${channel}'`)
    }
    expect(manager).toContain("webContents.send('updates:status-changed'")
    // Identity guard: never replace the app with a different bundle id.
    expect(manager).toContain('readBundleIdentifier(staged)')
    expect(manager).toContain('readBundleIdentifier(currentBundle)')
  })
})
