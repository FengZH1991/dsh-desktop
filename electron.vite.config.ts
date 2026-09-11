import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          'windows-menu': resolve('src/preload/windows-menu.ts')
        },
        // `electron` must be external. `externalizeDepsPlugin()` only covers
        // `dependencies`, and electron apps keep electron in `devDependencies`,
        // so Rollup otherwise bundles all of `node_modules/electron` into the
        // preload. That copy evaluates `getElectronPath()` relative to its own
        // chunk directory, throws "Electron failed to install correctly", and
        // takes the whole preload down with it: every `contextBridge` export
        // disappears, which is what broke the workspace directory picker.
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  }
})
