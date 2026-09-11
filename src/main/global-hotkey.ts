/**
 * Global (system-wide) hotkey: the accelerator grammar, the persisted
 * preference, and the toggle decision.
 *
 * The reason this exists at all: DSH Desktop is a window on a long-running
 * local Harness, so the common interaction is "I am in another app and want to
 * ask the agent something". Without a system-wide accelerator the only ways
 * back in are the Dock, the tray menu, or ⌘-Tab — all of which need the pointer
 * or a window-hunting detour.
 *
 * Everything decidable without Electron lives here and is unit-tested; the
 * module's only Electron touch is `registerGlobalHotkey`, which is injected
 * with the `globalShortcut` seam so tests never need a real app.
 */

/** Persisted key inside `desktop-storage.json`. */
export const HOTKEY_STORAGE_KEY = 'globalHotkey'

/**
 * Default accelerator.
 *
 * Chosen to collide with nothing on a stock macOS or Windows install:
 * ⌘⇧D / Ctrl+Shift+D is not a system shortcut, is not claimed by the browsers'
 * or editors' most common bindings, and is easy to type one-handed.
 */
export const DEFAULT_HOTKEY = 'CommandOrControl+Shift+D'

/** Canonical spelling for every modifier, keyed by the lowercase input. */
const MODIFIER_ALIASES: Record<string, string> = {
  cmd: 'Command',
  command: 'Command',
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super'
}

/**
 * Keys whose canonical spelling differs from a naive capitalisation.
 *
 * Electron's grammar is case-insensitive but the conventional spelling uses
 * capitals (`Return`, not `RETURN`; `Up`, not `UP`), and a few keys are spelled
 * out (`Plus`, `Space`). Normalising keeps a user-typed value comparable to the
 * default and to a previously stored value.
 */
const KEY_ALIASES: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  esc: 'Escape',
  escape: 'Escape',
  space: 'Space',
  spacebar: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  plus: 'Plus',
  minus: 'Minus',
  comma: 'Comma',
  period: 'Period',
  slash: 'Slash',
  backslash: 'Backslash',
  semicolon: 'Semicolon',
  quote: 'Quote',
  backquote: 'Backquote',
  bracketleft: 'BracketLeft',
  bracketright: 'BracketRight'
}

/**
 * Normalise one token of an accelerator to its canonical spelling.
 *
 * @param token - a raw modifier or key token.
 * @returns the canonical token, or undefined when it is not a known modifier
 *   and not a plausible single key.
 */
function normaliseToken(token: string): string | undefined {
  const lower = token.toLowerCase()
  const modifier = MODIFIER_ALIASES[lower]
  if (modifier !== undefined) return modifier

  const key = KEY_ALIASES[lower]
  if (key !== undefined) return key

  // Function keys are conventionally spelled `F1`..`F24`.
  if (/^f([1-9]|1[0-9]|2[0-4])$/u.test(lower)) return lower.toUpperCase()

  // A single printable character is a valid key in Electron's grammar.
  if (token.length === 1) return token.toUpperCase()

  // Multi-character key names are accepted as-is when they look like an
  // identifier, so a future Electron key we do not alias still works.
  if (/^[A-Za-z][A-Za-z0-9]*$/u.test(token)) {
    return token.charAt(0).toUpperCase() + token.slice(1)
  }

  return undefined
}

/**
 * Normalise a user-supplied accelerator into Electron's canonical spelling.
 *
 * @param accelerator - the raw accelerator text.
 * @returns the canonical accelerator, or undefined when it is unusable.
 */
export function normaliseAccelerator(accelerator: string): string | undefined {
  const parts = accelerator.split('+')
  // Tolerate a leading or trailing separator, but not an empty step in the
  // middle: `Command++D` is a typo whose intent is ambiguous, and guessing
  // would silently bind something other than what was asked for.
  const trimmed = parts.map((part) => part.trim())
  const first = trimmed.findIndex((part) => part.length > 0)
  if (first === -1) return undefined
  let last = trimmed.length - 1
  while (last > first && trimmed[last] === '') last -= 1
  const tokens = trimmed.slice(first, last + 1)
  if (tokens.some((token) => token.length === 0)) return undefined
  if (tokens.length === 0) return undefined

  const normalised: string[] = []
  for (const token of tokens) {
    const value = normaliseToken(token)
    if (value === undefined) return undefined
    // Repeating a modifier is always a mistake and Electron ignores the
    // duplicate, so reject rather than silently accept a different binding.
    if (normalised.includes(value) && Object.values(MODIFIER_ALIASES).includes(value)) return undefined
    normalised.push(value)
  }

  // A modifier with no key would register nothing useful.
  const hasKey = normalised.some((token) => !Object.values(MODIFIER_ALIASES).includes(token))
  if (!hasKey) return undefined

  // A bare key with no modifier would swallow that key system-wide, which is
  // never what someone wants from a "show my agent" shortcut.
  const hasModifier = normalised.some((token) => Object.values(MODIFIER_ALIASES).includes(token))
  if (!hasModifier) return undefined

  return normalised.join('+')
}

/**
 * Decide which accelerator to register from a persisted value.
 *
 * An unusable or absent stored value falls back to the default rather than
 * leaving the user with no shortcut, and a blank stored value means "the user
 * turned it off".
 *
 * @param stored - the raw persisted value, or null when never set.
 * @returns the accelerator to register, or undefined when disabled.
 */
export function resolveAccelerator(stored: string | null): string | undefined {
  if (stored === null) return DEFAULT_HOTKEY
  if (stored.trim() === '') return undefined
  return normaliseAccelerator(stored) ?? DEFAULT_HOTKEY
}

/** What a hotkey press should do to the main window. */
export type ToggleAction = 'hide' | 'restore'

/**
 * Decide whether a press hides or restores.
 *
 * A focused window hides on the next press, so the same shortcut is both "summon"
 * and "dismiss". A window that exists but is not focused is brought forward
 * instead, which is the case after switching apps.
 *
 * @param state - the window and app focus facts.
 * @returns the action to take.
 */
export function decideToggleAction(state: {
  hasWindow: boolean
  isMinimized: boolean
  isFocused: boolean
  isAppFocused: boolean
}): ToggleAction {
  if (!state.hasWindow) return 'restore'
  if (state.isMinimized) return 'restore'
  return state.isFocused && state.isAppFocused ? 'hide' : 'restore'
}

/** The subset of Electron's `globalShortcut` this module needs. */
export interface GlobalShortcutLike {
  register: (accelerator: string, callback: () => void) => boolean
  unregister: (accelerator: string) => void
  isRegistered: (accelerator: string) => boolean
}

/** Handle returned by {@link registerGlobalHotkey}. */
export interface GlobalHotkeyHandle {
  /** The accelerator that ended up registered. */
  accelerator: string
  /** Unregister it. Safe to call more than once. */
  dispose: () => void
}

/**
 * Register the global hotkey, tolerating a conflict.
 *
 * `globalShortcut.register` returns false — and does not throw — when another
 * application already owns the combination, so a press that cannot be honoured
 * must be reported rather than assumed to work.
 *
 * @param shortcuts - the `globalShortcut` seam.
 * @param stored - the raw persisted accelerator value.
 * @param onTrigger - invoked on each press.
 * @returns the handle, or undefined when disabled or the registration lost.
 */
export function registerGlobalHotkey(
  shortcuts: GlobalShortcutLike,
  stored: string | null,
  onTrigger: () => void
): GlobalHotkeyHandle | undefined {
  const accelerator = resolveAccelerator(stored)
  if (accelerator === undefined) return undefined

  const registered = shortcuts.register(accelerator, onTrigger)
  if (!registered) return undefined

  let disposed = false
  return {
    accelerator,
    dispose: () => {
      if (disposed) return
      disposed = true
      shortcuts.unregister(accelerator)
    }
  }
}
