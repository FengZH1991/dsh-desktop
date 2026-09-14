#!/usr/bin/env node
/**
 * One-command local release for the fork update channel.
 *
 *   node scripts/release-local.mjs [--version X.Y.Z-feng.N] [--notes "..."]
 *                                  [--skip-build] [--dry-run]
 *
 * Pipeline:
 *   1. bump package.json to the fork version line (`<base>-feng.N`,
 *      auto-incremented unless --version pins one);
 *   2. commit + push so the release tag points at a commit GitHub has;
 *   3. build the macOS arm64 zip/dmg with electron-builder.fork.cjs
 *      (publish: null — the zip must NOT carry upstream's app-update.yml);
 *   4. compute sha512 + size and emit dist/latest-mac.json;
 *   5. create (or update) GitHub release `v<version>` on the fork with the
 *      zip, dmg, and latest-mac.json attached.
 *
 * The installed app picks the release up through
 * https://github.com/FengZH1991/dsh-desktop/releases/latest/download/latest-mac.json
 * (see build/fork-update.json and src/main/update/fork-update-manager.ts).
 *
 * Prerequisites: gh CLI authenticated (`gh auth login`), and for a cold build
 * ELECTRON_CACHE pointing at a populated Electron cache (defaults to
 * ~/Library/Caches/electron, which this machine already has).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const REPO = 'FengZH1991/dsh-desktop'
const FORK_SUFFIX = 'feng'
const ZIP_NAME = 'dsh-desktop-mac-arm64.zip'
const DMG_NAME = 'dsh-desktop-mac-arm64.dmg'
const MANIFEST_NAME = 'latest-mac.json'

const root = path.resolve(import.meta.dirname, '..')
const args = parseArgs(process.argv.slice(2))

function parseArgs(argv) {
  const parsed = { version: undefined, notes: undefined, skipBuild: false, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--version':
        parsed.version = argv[++i]
        break
      case '--notes':
        parsed.notes = argv[++i]
        break
      case '--skip-build':
        parsed.skipBuild = true
        break
      case '--dry-run':
        parsed.dryRun = true
        break
      default:
        fail(`未知参数: ${argv[i]}`)
    }
  }
  return parsed
}

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

function run(command, argv, options = {}) {
  console.log(`\n$ ${command} ${argv.join(' ')}`)
  return execFileSync(command, argv, { cwd: root, stdio: 'inherit', ...options })
}

function runQuiet(command, argv) {
  return execFileSync(command, argv, { cwd: root, encoding: 'utf8' }).trim()
}

function readVersion() {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
}

/** `<upstream>-feng.N`, incrementing N; plain `<upstream>` starts at N=1. */
function deriveNextVersion(current) {
  const match = current.match(/^(.+)-feng\.(\d+)$/)
  if (match) return `${match[1]}-feng.${Number(match[2]) + 1}`
  return `${current}-feng.1`
}

function bumpPackageJson(version) {
  const file = path.join(root, 'package.json')
  const text = readFileSync(file, 'utf8')
  const updated = text.replace(/"version": "[^"]+"/, `"version": "${version}"`)
  if (updated === text) fail('package.json 中没有找到 version 字段')
  writeFileSync(file, updated)
}

function main() {
  const current = readVersion()
  const version = args.version ?? deriveNextVersion(current)
  const tag = `v${version}`
  const zipPath = path.join(root, 'dist', ZIP_NAME)
  const dmgPath = path.join(root, 'dist', DMG_NAME)
  const manifestPath = path.join(root, 'dist', MANIFEST_NAME)
  const notes =
    args.notes ??
    `DSH Desktop fork ${version}（本机构建，含全局热键等自有功能；zip 供应用内自动更新，dmg 供手动安装）。`

  console.log(`当前版本: ${current}`)
  console.log(`发布版本: ${version}  (tag ${tag})`)

  if (args.dryRun) {
    console.log('\n[dry-run] 将执行: bump → commit+push → build(若未跳过) → sha512+manifest → gh release')
    return
  }

  // --- preflight ------------------------------------------------------------
  try {
    runQuiet('gh', ['auth', 'status'])
  } catch {
    fail('gh CLI 未登录。请先运行 `gh auth login`（发布需要上传 release 资产）。')
  }
  const status = runQuiet('git', ['status', '--porcelain'])
  if (status) {
    console.warn(`\n⚠ 工作区有未提交改动:\n${status}\n  版本号提交只会包含 package.json。`)
  }

  // --- version bump ----------------------------------------------------------
  if (version !== current) {
    bumpPackageJson(version)
    run('git', ['add', 'package.json'])
    run('git', ['commit', '-m', `chore(release): ${tag}`])
  }
  run('git', ['push', 'origin', 'HEAD'])

  // --- build -----------------------------------------------------------------
  if (!args.skipBuild) {
    const env = {
      ...process.env,
      ELECTRON_CACHE: process.env.ELECTRON_CACHE ?? path.join(homedir(), 'Library/Caches/electron')
    }
    run('npm', ['run', 'build'], { env })
    run(
      'npx',
      [
        'electron-builder',
        '--mac',
        '--arm64',
        '--publish',
        'never',
        '--config',
        'electron-builder.fork.cjs'
      ],
      { env }
    )
  }
  if (!existsSync(zipPath)) {
    fail(`缺少产物 ${ZIP_NAME}（dist/ 下没有，去掉 --skip-build 重新跑）`)
  }

  // --- manifest --------------------------------------------------------------
  const zip = readFileSync(zipPath)
  const manifest = {
    version,
    releaseDate: new Date().toISOString(),
    notes,
    files: [
      {
        platform: 'mac',
        arch: 'arm64',
        url: `https://github.com/${REPO}/releases/download/${tag}/${ZIP_NAME}`,
        sha512: createHash('sha512').update(zip).digest('base64'),
        size: zip.byteLength
      }
    ]
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)

  // --- release ---------------------------------------------------------------
  const assets = [zipPath, manifestPath, ...(existsSync(dmgPath) ? [dmgPath] : [])]
  let releaseExists = true
  try {
    runQuiet('gh', ['release', 'view', tag, '--repo', REPO])
  } catch {
    releaseExists = false
  }
  if (releaseExists) {
    run('gh', ['release', 'upload', tag, '--repo', REPO, '--clobber', ...assets])
  } else {
    run('gh', [
      'release',
      'create',
      tag,
      '--repo',
      REPO,
      '--title',
      `v${version}`,
      '--notes',
      notes,
      ...assets
    ])
  }

  console.log(`\n✓ 已发布 ${tag}`)
  console.log(`  更新清单: https://github.com/${REPO}/releases/latest/download/${MANIFEST_NAME}`)
  console.log('  已安装的应用将在下次检查（或手动「检查更新」）时发现此版本。')
}

main()
