/**
 * Compute the runtime dependency closure of `@deepseek-ai/dsh` at a target
 * version straight from the npm registry, and diff it against the closure
 * currently vendored by this repository.
 *
 * The Desktop app ships a fully vendored Harness: every `@deepseek-ai/*`
 * package is a `file:` dependency on a tarball under
 * `packages/harness-<version>/`. Upgrading therefore means (1) knowing exactly
 * which packages and versions the new root closure needs, (2) packing them, and
 * (3) rewriting the `file:` dependency map.
 *
 * This script only reports. It never writes to the working tree, so it is safe
 * to run before deciding to upgrade.
 *
 * Version resolution: a dependency range is resolved against the registry's
 * published version list with `semver`, preferring the highest version that
 * satisfies it. Because an upstream prerelease such as `0.1.5-rc.1` usually
 * admits `0.1.5-rc.2` under a caret range, pass `--pin <version>` to force
 * every package whose satisfying set contains that exact version to use it.
 * Without a pin the closure tracks the newest prerelease, which is not what a
 * reproducible Desktop build should do.
 *
 * Usage:
 *   node scripts/harness-closure.mjs 0.1.5-rc.1 --pin 0.1.5-rc.1
 *   node scripts/harness-closure.mjs 0.1.5-rc.1 --pin 0.1.5-rc.1 --json > closure.json
 */

import { readFile } from 'node:fs/promises'
import semver from 'semver'

const TARGET = process.argv[2]
const AS_JSON = process.argv.includes('--json')
const pinIndex = process.argv.indexOf('--pin')
const PIN = pinIndex === -1 ? undefined : process.argv[pinIndex + 1]

if (!TARGET) {
  console.error('usage: node scripts/harness-closure.mjs <version> [--pin <version>] [--json]')
  process.exit(1)
}

const REGISTRY = 'https://registry.npmjs.org'
const ROOT = '@deepseek-ai/dsh'
/**
 * Concurrent registry requests, and the per-request ceiling.
 *
 * Both are deliberately modest. A local HTTP proxy (ClashX and friends) is a
 * common developer setup and saturates well below the registry's own capacity;
 * an unbounded fan-out then hangs instead of failing, which is far harder to
 * diagnose than a slow run.
 */
const CONCURRENCY = 4
const REQUEST_TIMEOUT_MS = 30_000

/** Memoized package documents, plus the in-flight promise for each name. */
const packuments = new Map()

/**
 * Fetch and memoize one package document.
 *
 * The in-flight promise is memoized before it settles so that N concurrent
 * requests for the same name share a single network call.
 *
 * @param name - the package name.
 * @returns the registry document.
 */
function fetchPackument(name) {
  const cached = packuments.get(name)
  if (cached !== undefined) return cached
  const pending = (async () => {
    const res = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  })()
  packuments.set(name, pending)
  return pending
}

/**
 * Run `tasks` with at most `limit` in flight, preserving input order.
 *
 * @param items - the inputs to map over.
 * @param limit - maximum concurrent invocations.
 * @param worker - the async mapper.
 * @returns the mapped results in input order.
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Resolve a dependency range to a concrete published version.
 *
 * @param name - the dependency package name.
 * @param range - the semver range the dependent declared.
 * @param doc - that package's registry document.
 * @returns the chosen version, or undefined when nothing satisfies the range.
 */
function resolveVersion(name, range, doc) {
  const versions = Object.keys(doc.versions ?? {})
  if (versions.length === 0) return undefined

  // A concrete version is authoritative: never second-guess an exact pin.
  if (semver.valid(range) !== null) return semver.valid(range)

  const options = { includePrerelease: true }
  // The pin only applies to packages that actually publish it AND whose range
  // admits it. Without the existence check, an unrelated package such as
  // `node-addon-require-builtin@^0.1.4` would be forced onto `0.1.5-rc.1`.
  if (PIN !== undefined && versions.includes(PIN) && semver.satisfies(PIN, range, options)) return PIN
  return semver.maxSatisfying(versions, range, options) ?? undefined
}

/**
 * Walk the runtime dependency closure level by level, resolving each level
 * concurrently.
 *
 * Breadth-first by level is deliberate: it converges in a handful of rounds
 * even though the closure has ~300 nodes, and each round's fetches overlap.
 *
 * @param rootName - the root package name.
 * @param rootRange - the root version or range.
 * @returns the closure and everything that could not be resolved.
 */
async function walkClosure(rootName, rootRange) {
  const seen = new Map()
  const unresolved = []
  let frontier = [[rootName, rootRange]]
  let round = 0

  while (frontier.length > 0) {
    round += 1
    // Drop pairs already visited, and de-duplicate within this frontier.
    const pending = new Map()
    for (const [name, range] of frontier) {
      const key = `${name}\u0000${range}`
      if (!pending.has(key)) pending.set(key, [name, range])
    }
    frontier = []
    if (pending.size === 0) break

    const entries = [...pending.values()]
    process.stderr.write(`  round ${round}: resolving ${entries.length} package(s)…\n`)

    // Resolve this whole level with bounded concurrency, then index the results.
    const resolved = await mapLimit(entries, CONCURRENCY, async ([name, range]) => {
      try {
        const doc = await fetchPackument(name)
        return { name, range, doc, version: resolveVersion(name, range, doc) }
      } catch (error) {
        return { name, range, error }
      }
    })

    for (const item of resolved) {
      if (item.error !== undefined) {
        unresolved.push({ name: item.name, range: item.range, reason: item.error.message })
        continue
      }
      if (item.version === undefined) {
        unresolved.push({ name: item.name, range: item.range, reason: 'no version satisfies range' })
        continue
      }
      const key = `${item.name}@${item.version}`
      if (seen.has(key)) continue

      const manifest = item.doc.versions[item.version]
      if (manifest === undefined) {
        unresolved.push({ name: item.name, range: item.range, reason: `registry has no ${item.version}` })
        continue
      }

      seen.set(key, {
        name: item.name,
        version: item.version,
        license: manifest.license ?? null,
        dependencies: Object.keys(manifest.dependencies ?? {}),
      })

      for (const [depName, depRange] of Object.entries(manifest.dependencies ?? {})) {
        frontier.push([depName, depRange])
      }
    }
  }

  return { seen, unresolved }
}

/** The `@deepseek-ai/*` subset, which is what this repository vendors. */
function subset(seen) {
  const out = new Map()
  for (const value of seen.values()) {
    if (value.name.startsWith('@deepseek-ai/')) out.set(value.name, value.version)
  }
  return out
}

const { seen, unresolved } = await walkClosure(ROOT, TARGET)
const target = subset(seen)

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const current = new Map()
for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
  if (!name.startsWith('@deepseek-ai/') || !range.startsWith('file:')) continue
  const match = /-(\d+\.\d+\.\d+[^/]*)\.tgz$/u.exec(range)
  current.set(name, match ? match[1] : 'unknown')
}

const added = [...target.keys()].filter((name) => !current.has(name)).sort()
const removed = [...current.keys()].filter((name) => !target.has(name)).sort()
const changed = [...target.keys()]
  .filter((name) => current.has(name) && current.get(name) !== target.get(name))
  .sort()
const same = [...target.keys()].filter((name) => current.get(name) === target.get(name)).sort()

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        root: `${ROOT}@${TARGET}`,
        pin: PIN ?? null,
        target: Object.fromEntries(target),
        added,
        removed,
        changed,
        same,
        unresolved,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

console.log(`target root:      ${ROOT}@${TARGET}`)
if (PIN !== undefined) console.log(`pinned at:        ${PIN}`)
console.log(`total closure:    ${seen.size} packages`)
console.log(`@deepseek-ai/*:   ${target.size} packages`)
console.log(`currently locked: ${current.size} packages`)
console.log('')
console.log(`same version:     ${same.length}`)
console.log(`version changed:  ${changed.length}`)
console.log(`added upstream:   ${added.length}`)
console.log(`removed upstream: ${removed.length}`)
if (unresolved.length > 0) console.log(`unresolved:       ${unresolved.length}`)

if (changed.length > 0) {
  console.log('\n-- version changed --')
  for (const name of changed) console.log(`  ${name}  ${current.get(name)} → ${target.get(name)}`)
}
if (added.length > 0) {
  console.log('\n-- added upstream (new rows the Desktop bundle may need) --')
  for (const name of added) console.log(`  ${name}@${target.get(name)}`)
}
if (removed.length > 0) {
  console.log('\n-- removed upstream (Desktop patches may be orphaned) --')
  for (const name of removed) console.log(`  ${name}@${current.get(name)}`)
}
if (unresolved.length > 0) {
  console.log('\n-- unresolved --')
  for (const item of unresolved) console.log(`  ${item.name}@${item.range}  (${item.reason})`)
}
