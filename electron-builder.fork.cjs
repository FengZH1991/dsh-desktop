/**
 * Fork packaging config: builds a real "DSH Desktop" app for this fork.
 *
 * Identical to the upstream production config — same `io.dsh.desktop`
 * identity, same name and icon — with two deliberate differences:
 *
 *   `publish: null` disables the upstream electron-updater channel. The
 *   upstream config points updates at `https://dshdesktop.com/updates/latest/`,
 *   which is the *upstream* project's release channel. This is a fork, so
 *   leaving that in place would make the app replace itself with someone
 *   else's build — and unsigned / adhoc-signed builds cannot install through
 *   Squirrel.Mac anyway.
 *
 *   `fork-update.json` is baked into Resources instead, enabling the fork's
 *   own swap-based updater (src/main/update/fork-update-manager.ts), which
 *   follows this fork's GitHub releases. Edit `build/fork-update.json` to
 *   point at your own repository, then publish with
 *   `scripts/release-local.mjs` (`npm run release:local`).
 */
const packageJson = require('./package.json')

module.exports = {
  ...packageJson.build,
  publish: null,
  extraResources: [
    ...packageJson.build.extraResources,
    { from: 'build/fork-update.json', to: 'fork-update.json' }
  ]
}
