/**
 * Vendor the Harness runtime closure for one release into
 * `packages/harness-<version>/npm-dsh/`, the layout the Desktop app's `file:`
 * dependencies point at.
 *
 * Upstream is now published to the npm registry (0.1.2-rc.1 predated that and
 * had to be built from a source tag), so vendoring is a `npm pack` sweep over
 * the closure's registry packages, which keeps the build reproducible without a
 * source checkout.
 *
 * `npm pack` is used rather than fetching the registry tarball URL directly:
 * npm resolves through whatever proxy configuration the machine actually has,
 * whereas a direct HTTP client must replicate it and silently fails otherwise
 * (a 404 on the tarball path is the usual symptom of a bypassed proxy).
 *
 * The input is a closure manifest: a JSON object mapping package name to the
 * exact version to vendor. Produce one by resolving the target with npm and
 * reading `package-lock.json`:
 *
 *   npm install --package-lock-only @deepseek-ai/dsh@<version>
 *
 * Usage:
 *   node scripts/vendor-harness.mjs <version> <closure.json> [--dry-run] [--jobs N]
 *
 * The script is idempotent: an already-present, valid tarball is skipped, so an
 * interrupted run resumes by simply running again. A tarball that fails to
 * unpack is treated as absent and re-fetched, so a truncated file left by a
 * killed run self-heals.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const [, , VERSION, CLOSURE_PATH] = process.argv
const DRY_RUN = process.argv.includes('--dry-run')
const jobsIndex = process.argv.indexOf('--jobs')
const JOBS = jobsIndex === -1 ? 4 : Number(process.argv[jobsIndex + 1])

if (VERSION === undefined || CLOSURE_PATH === undefined) {
  console.error('usage: node scripts/vendor-harness.mjs <version> <closure.json> [--dry-run] [--jobs N]')
  process.exit(1)
}

// `fileURLToPath`, not `URL.pathname`: the repository path contains non-ASCII
// characters (`AI项目`), which `pathname` leaves percent-encoded and would
// therefore write every tarball into a literal `AI%E9%A1%B9%E7%9B%AE` tree.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT_DIR = join(REPO_ROOT, 'packages', `harness-${VERSION}`, 'npm-dsh')

/** npm's tarball filename for a scoped package: `@scope/name` → `scope-name-<version>.tgz`. */
function tarballName(name, version) {
  return `${name.replace(/^@/u, '').replace(/\//gu, '-')}-${version}.tgz`
}

/** Registry packages only: local `file:`/workspace entries are not vendorable. */
function vendorableEntries(closure) {
  return Object.entries(closure)
    .filter(([name]) => name.startsWith('@'))
    .filter(([name]) => !name.includes('/node_modules/'))
    .sort(([a], [b]) => a.localeCompare(b))
}

/**
 * Whether a file is a readable gzip archive.
 *
 * @param path - the candidate tarball.
 * @returns true when `tar` can list it.
 */
async function isIntactTarball(path) {
  try {
    await execFileAsync('tar', ['-tzf', path], { maxBuffer: 8 * 1024 * 1024 })
    return true
  } catch {
    return false
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * @param items - the work items.
 * @param limit - maximum concurrency.
 * @param worker - the async worker.
 */
async function mapLimit(items, limit, worker) {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      await worker(items[index])
    }
  })
  await Promise.all(runners)
}

const closure = JSON.parse(readFileSync(CLOSURE_PATH, 'utf8'))
const entries = vendorableEntries(closure)

console.log(`vendoring ${entries.length} package(s) at ${VERSION}`)
console.log(`target: ${OUT_DIR}`)
console.log(`jobs:   ${JOBS}`)
if (DRY_RUN) console.log('(dry run: nothing will be written)')

if (!DRY_RUN) mkdirSync(OUT_DIR, { recursive: true })

const failures = []
const scratch = await mkdtemp(join(tmpdir(), 'dsh-vendor-'))

let written = 0
let skipped = 0
let done = 0

await mapLimit(entries, DRY_RUN ? 1 : JOBS, async ([name, version]) => {
  const target = join(OUT_DIR, tarballName(name, version))

  try {
    if (DRY_RUN) {
      console.log(`  would pack ${name}@${version}`)
      return
    }
    if (existsSync(target) && (await isIntactTarball(target))) {
      skipped += 1
      return
    }

    // Pack into the scratch directory, then rename into place, so a killed run
    // never leaves a truncated tarball that a later run would treat as complete.
    const { stdout } = await execFileAsync('npm', ['pack', `${name}@${version}`, '--pack-destination', scratch], {
      cwd: scratch,
      maxBuffer: 16 * 1024 * 1024,
    })
    const produced = stdout.trim().split('\n').filter(Boolean).pop()
    if (produced === undefined) throw new Error('npm pack produced no filename')
    const staging = join(scratch, produced)
    if (!(await isIntactTarball(staging))) throw new Error('packed tarball failed to unpack')
    rmSync(target, { force: true })
    renameSync(staging, target)
    written += 1
  } catch (error) {
    failures.push({ name, version, reason: error.message.split('\n')[0] })
  } finally {
    done += 1
    if (done % 10 === 0 || done === entries.length) {
      console.log(`  ${done}/${entries.length} (written ${written}, skipped ${skipped}, failed ${failures.length})`)
    }
  }
})

rmSync(scratch, { recursive: true, force: true })

console.log('')
console.log(`written: ${written}`)
console.log(`skipped (already present): ${skipped}`)
console.log(`failed:  ${failures.length}`)
if (failures.length > 0) {
  console.log('\n-- failures --')
  for (const f of failures) console.log(`  ${f.name}@${f.version}: ${f.reason}`)
  process.exitCode = 1
}
