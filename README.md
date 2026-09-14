<h1 align="center">
  <img src="docs/images/readme-logo-black-v020.png" width="64" alt="DSH Desktop logo" valign="middle" />
  DSH Desktop — Community Fork
</h1>

<p align="center">
  A local-first desktop app for
  <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>,
  forked from <a href="https://github.com/dataelement/dsh-desktop">dataelement/dsh-desktop</a>
  with a self-hosted auto-update channel that works for unsigned builds.
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh.md">简体中文</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-171513.svg" /></a>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-Apple%20Silicon-171513.svg" />
  <a href="https://github.com/FengZH1991/dsh-desktop/releases"><img alt="Releases" src="https://img.shields.io/badge/download-releases-171513.svg" /></a>
</p>

> [!NOTE]
> This is an **unofficial community fork**, not the official DSH Desktop.
> For the official, code-signed and notarized product (macOS Intel/ARM,
> Windows x64), use [dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop)
> and [dshdesktop.com](https://www.dshdesktop.com/).

## Why this fork exists

The official desktop app auto-updates from the vendor's signed release feed.
That mechanism requires Apple Developer ID signing, which a personal build
does not have — so a self-built copy would silently fall behind upstream
forever. This fork adds an update channel that any fork builder can operate
from their own GitHub Releases, no signing certificate required.

## What the fork changes

Everything from upstream 0.1.1, plus:

- **Self-hosted auto-update for unsigned builds** — the app checks a
  `latest-mac.json` manifest on this repository's GitHub Releases, verifies
  the download by SHA-512, and installs it with a swap-style installer
  (extract → identity check → swap after quit → relaunch, with automatic
  rollback). The upstream update UI, state machine, and "skip this version"
  behavior are reused unchanged; Windows is not supported by the fork
  installer yet.
- **Global hotkey** to summon and dismiss the window.
- **Native desktop notifications** for events that block on a person.
- **One-command release tooling** — `npm run release:local` bumps the
  version, builds, hashes, and publishes a GitHub release complete with the
  update manifest.
- Fork releases use the version line `<upstream-version>-feng.N`
  (e.g. `0.1.1-feng.2`), so they order cleanly against upstream versions.

## Download and install (macOS Apple Silicon)

Grab `dsh-desktop-mac-arm64.zip` (or the DMG) from
[Releases](https://github.com/FengZH1991/dsh-desktop/releases).

These builds are **not code-signed or notarized**. macOS Gatekeeper will warn
on first launch — either right-click the app and choose **Open**, or run:

```sh
xattr -dr com.apple.quarantine "/Applications/DSH Desktop.app"
```

Once installed, the app checks for fork updates shortly after startup and
every six hours, and installs them through its own **Restart and install**
flow. You can also check manually from the application menu.

## Run your own update channel

The update feed is just a JSON manifest on GitHub Releases, so any fork can
operate its own channel:

1. Edit [`build/fork-update.json`](build/fork-update.json) to point at **your**
   repository's releases.
2. Build with the fork packaging config:
   ```sh
   npm install          # applies the patch-package patches under patches/
   npm run test && npm run typecheck
   npm run package:fork:mac:arm64
   ```
3. Publish a release (requires [`gh`](https://cli.github.com/) authentication
   with `repo` scope):
   ```sh
   npm run release:local          # add --dry-run to preview
   ```

The release script bumps the `-feng.N` suffix, commits, pushes, builds the
zip/dmg, computes the SHA-512 manifest, and attaches everything to a GitHub
release. Installed copies pick the new version up automatically.

If both an upstream `app-update.yml` and `fork-update.json` are present in a
build, the upstream manager wins — the fork channel only activates when the
upstream channel is absent, so merging future upstream changes to
`src/main/update/update-manager.ts` stays conflict-free.

## Documentation

- [Architecture](docs/architecture.md) and [development guide](docs/development.md)
  — inherited from upstream; sections about the official update feed and
  code signing describe the *upstream* product, not this fork.
- [Preset package format](docs/preset-packages.md)
- [PPT runtime guide](packages/ppt-runtime/README.md)

## Third-party credits and attribution

This project is built on the work of others — see [NOTICE.md](NOTICE.md) for
the full list. In short:

- **[dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop)**
  (MIT, © DataElement) — the upstream project this fork is based on; nearly
  all of the codebase is theirs.
- **[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)**
  (MIT) — the Agent runtime and Web UI bundled by the app; vendored under
  `packages/harness-0.1.2-rc.1/` and adjusted via the 21 `patch-package`
  patches in `patches/`.
- **Electron**, **electron-builder**, **electron-vite** and the other
  dependencies listed in `package-lock.json`, each under its own license.

"DeepSeek" and "DSH Desktop" names and logos belong to their respective
owners; this fork is not affiliated with or endorsed by them.

## License

Open source under the [MIT License](LICENSE) — commercial use, modification,
and redistribution are permitted provided the copyright notices are retained.
Upstream code © DataElement; fork modifications © FengZH1991.
