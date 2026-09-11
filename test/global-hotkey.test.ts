import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HOTKEY,
  decideToggleAction,
  normaliseAccelerator,
  registerGlobalHotkey,
  resolveAccelerator,
  type GlobalShortcutLike
} from '../src/main/global-hotkey'

describe('normaliseAccelerator', () => {
  it('canonicalises the default spelling', () => {
    expect(normaliseAccelerator('CommandOrControl+Shift+D')).toBe('CommandOrControl+Shift+D')
  })

  it.each([
    ['cmd+shift+d', 'Command+Shift+D'],
    ['CMD+SHIFT+D', 'Command+Shift+D'],
    ['ctrl+alt+p', 'Control+Alt+P'],
    ['option+space', 'Alt+Space'],
    ['super+k', 'Super+K'],
    ['cmdorctrl+shift+f5', 'CommandOrControl+Shift+F5'],
    ['command+return', 'Command+Return'],
    ['control+escape', 'Control+Escape'],
    ['alt+pageup', 'Alt+PageUp']
  ])('normalises %s to %s', (input, expected) => {
    expect(normaliseAccelerator(input)).toBe(expected)
  })

  it('accepts multi-character key identifiers it has no alias for', () => {
    expect(normaliseAccelerator('Command+MediaPlayPause')).toBe('Command+MediaPlayPause')
  })

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['Command', 'a modifier with no key'],
    ['Shift+Alt', 'modifiers only'],
    ['D', 'a bare key that would swallow a global keystroke'],
    ['Command++D', 'an empty step between modifiers'],
    ['Command+Command+D', 'a repeated modifier']
  ])('rejects %s (%s)', (input) => {
    expect(normaliseAccelerator(input)).toBeUndefined()
  })

  it.each([
    ['Command+D+', 'Command+D'],
    ['+Command+D', 'Command+D']
  ])('tolerates a stray separator: %s → %s', (input, expected) => {
    expect(normaliseAccelerator(input)).toBe(expected)
  })
})

describe('resolveAccelerator', () => {
  it('falls back to the default when nothing was stored', () => {
    expect(resolveAccelerator(null)).toBe(DEFAULT_HOTKEY)
  })

  it('honours a valid stored value', () => {
    expect(resolveAccelerator('Command+Alt+J')).toBe('Command+Alt+J')
  })

  it('treats a deliberately blank value as disabled', () => {
    expect(resolveAccelerator('')).toBeUndefined()
    expect(resolveAccelerator('   ')).toBeUndefined()
  })

  it('falls back to the default when the stored value is unusable', () => {
    expect(resolveAccelerator('not a shortcut')).toBe(DEFAULT_HOTKEY)
    expect(resolveAccelerator('D')).toBe(DEFAULT_HOTKEY)
  })
})

describe('decideToggleAction', () => {
  it('hides a focused window so the shortcut also dismisses', () => {
    expect(decideToggleAction({ hasWindow: true, isMinimized: false, isFocused: true, isAppFocused: true })).toBe('hide')
  })

  it('restores a window that exists but lost focus', () => {
    expect(decideToggleAction({ hasWindow: true, isMinimized: false, isFocused: false, isAppFocused: true })).toBe('restore')
  })

  it('restores when the window is focused but the app is in the background', () => {
    expect(decideToggleAction({ hasWindow: true, isMinimized: false, isFocused: true, isAppFocused: false })).toBe('restore')
  })

  it('restores a minimized window rather than hiding it', () => {
    expect(decideToggleAction({ hasWindow: true, isMinimized: true, isFocused: false, isAppFocused: false })).toBe('restore')
  })

  it('restores when there is no window yet', () => {
    expect(decideToggleAction({ hasWindow: false, isMinimized: false, isFocused: false, isAppFocused: false })).toBe('restore')
  })
})

/** A recording fake for the `globalShortcut` seam. */
function fakeShortcuts(registerResult = true): GlobalShortcutLike & { registered: string[]; unregistered: string[] } {
  const registered: string[] = []
  const unregistered: string[] = []
  return {
    registered,
    unregistered,
    register: vi.fn((accelerator: string) => {
      if (!registerResult) return false
      registered.push(accelerator)
      return true
    }),
    unregister: vi.fn((accelerator: string) => {
      unregistered.push(accelerator)
    }),
    isRegistered: vi.fn(() => false)
  }
}

describe('registerGlobalHotkey', () => {
  it('registers the resolved accelerator and reports it', () => {
    const shortcuts = fakeShortcuts()
    const handle = registerGlobalHotkey(shortcuts, null, () => {})

    expect(handle?.accelerator).toBe(DEFAULT_HOTKEY)
    expect(shortcuts.registered).toEqual([DEFAULT_HOTKEY])
  })

  it('does not register when the preference is disabled', () => {
    const shortcuts = fakeShortcuts()
    expect(registerGlobalHotkey(shortcuts, '', () => {})).toBeUndefined()
    expect(shortcuts.registered).toEqual([])
  })

  it('reports nothing when another application already owns the combination', () => {
    const shortcuts = fakeShortcuts(false)
    expect(registerGlobalHotkey(shortcuts, null, () => {})).toBeUndefined()
  })

  it('unregisters exactly once on dispose', () => {
    const shortcuts = fakeShortcuts()
    const handle = registerGlobalHotkey(shortcuts, 'Command+Alt+J', () => {})

    handle?.dispose()
    handle?.dispose()

    expect(shortcuts.unregistered).toEqual(['Command+Alt+J'])
  })

  it('forwards presses to the callback', () => {
    let pressed = 0
    const shortcuts: GlobalShortcutLike = {
      register: (_accelerator, callback) => {
        callback()
        return true
      },
      unregister: () => {},
      isRegistered: () => false
    }
    registerGlobalHotkey(shortcuts, null, () => {
      pressed += 1
    })
    expect(pressed).toBe(1)
  })
})
