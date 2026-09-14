# Third-Party Notices

This project is a community fork built on top of the following open-source
projects. Each remains the property of its respective owners and is used under
the terms of its own license.

## Upstream project

### DSH Desktop — https://github.com/dataelement/dsh-desktop

- License: [MIT](LICENSE)
- Copyright (c) 2026 DataElement

This repository is a fork of `dataelement/dsh-desktop`. The vast majority of
the codebase — the Electron shell, Harness lifecycle management, preset
packages, PPT mode, phone access, Safe Mode, and the original update UI and
state machine — comes from the upstream project. Fork modifications are
marked in git history on top of the upstream commit line.

## Bundled runtime

### DeepSeek Harness — https://github.com/deepseek-ai/deepseek-harness

- License: MIT (`@deepseek-ai/dsh` and family)
- Bundled version: `dsh-v0.1.2-rc.1`
  (commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`)

Harness is the Agent runtime and Web UI that this desktop shell hosts. Its
npm packages are vendored under `packages/harness-0.1.2-rc.1/` (see that
directory's README for the exact reproduction steps) and installed into the
app at runtime. Adjustments on top of the published packages are maintained
as `patch-package` patches under `patches/` (21 patches, all against
`@deepseek-ai/*` packages); each patched package remains under its upstream
license.

## Platform and key dependencies

| Component | License | Note |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron) | MIT | Application shell (v43) |
| [electron-builder](https://github.com/electron-userland/electron-builder) | MIT | Packaging |
| [electron-vite](https://github.com/alex8088/electron-vite) | MIT | Build tooling |
| [patch-package](https://github.com/ds300/patch-package) | MIT | Applies `patches/` |
| cordis / cosmokit / schemastery | MIT | Harness vendor family, vendored under `packages/harness-0.1.2-rc.1/npm-vendor/` |

Runtime dependencies installed from npm remain subject to their own licenses;
see `package-lock.json` for the full dependency tree.

## PPT templates

The built-in PPT template catalog ships derived and generated template
material. Provenance and remediation history are documented in
[`docs/ppt-implementation-provenance-and-remediation-2026-09-06.md`](docs/ppt-implementation-provenance-and-remediation-2026-09-06.md)
and [`packages/ppt-runtime/README.md`](packages/ppt-runtime/README.md).

## Trademarks

"DeepSeek", "DeepSeek Harness", and "DSH Desktop" names and logos belong to
their respective owners. This is an unofficial community fork and is not
affiliated with or endorsed by DataElement or DeepSeek.
