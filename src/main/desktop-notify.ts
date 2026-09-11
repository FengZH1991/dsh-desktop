/**
 * Electron-side plumbing for desktop notifications: the main-world hook that
 * observes the Harness Remote WebSocket, and the main-process notifier.
 *
 * Why a hook at all: the Harness forwards `approval/request` and
 * `user-questions/request` to the browser over the client's own WebSocket, and
 * the main process has no connection of its own. The alternative — giving the
 * main process a second authenticated client — means replicating the launch
 * token and cookie exchange, and it would still need the same event allowlist.
 * Wrapping `WebSocket` in the page is far less machinery.
 *
 * The hook runs in the *main world*, because that is where the official client
 * opens its socket; `contextIsolation: true` puts the preload in an isolated
 * world where a wrap would be invisible to it. It posts frames to the preload,
 * which parses them with the tested pure parser and forwards only actual
 * notifications to the main process — so the IPC volume is near zero rather
 * than one message per frame.
 */

export type { DesktopNotification } from './remote-event-notify'

/** Preload → main: a notification the user must see. */
export const NOTIFY_CHANNEL = 'dsh:desktop-notification'

/**
 * The main-world hook source.
 *
 * Written as a self-contained expression because it is injected with
 * `executeJavaScript`. It forwards only text frames on `$events`, so the
 * session-control and workspace streams never cross the boundary.
 */
export const WEBSOCKET_HOOK_SOURCE = `
(() => {
  if (globalThis.__dshNotifyHookInstalled) return 'already-installed'
  globalThis.__dshNotifyHookInstalled = true

  const Native = globalThis.WebSocket
  const eventsStreams = new Set()

  function forward(channel, direction, data) {
    try {
      if (typeof data !== 'string') return
      // Keep only frames that can matter: the events stream's own opener and
      // anything on a stream it announced.
      const looksLikeOpener = data.includes('"$events"')
      const maybeItem = direction === 'recv' && /"streamId"\\s*:/.test(data)
      if (!looksLikeOpener && !maybeItem) return
      // The main world cannot see the preload's contextBridge objects, but both
      // worlds share the window object, so postMessage is the seam that works.
      window.postMessage({ __dshNotifyFrame: true, channel, direction, data }, '*')
    } catch {
      // A notification must never break the client's own messaging.
    }
  }

  class DshNotifyWebSocket extends Native {
    constructor(...args) {
      super(...args)
      this.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return
        try {
          const frame = JSON.parse(event.data)
          if (frame && frame.type === 'open' && frame.endpoint === '$events' && typeof frame.streamId === 'string') {
            eventsStreams.add(frame.streamId)
          }
        } catch {}
        forward('recv', 'recv', event.data)
      })
    }
    send(data) {
      forward('send', 'send', data)
      return super.send(data)
    }
  }

  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    try { DshNotifyWebSocket[key] = Native[key] } catch {}
  }
  globalThis.WebSocket = DshNotifyWebSocket

  // The stream ids are advisory: the parser re-checks the frame, and a missing
  // id only costs a few extra frames.
  globalThis.__dshNotifyEventsStreams = eventsStreams
  return 'installed'
})()
`

/**
 * Install the main-world hook on a window's contents.
 *
 * @param contents - the window's web contents.
 * @returns a promise settling with the hook result, never rejecting.
 */
export async function installWebSocketHook(contents: {
  executeJavaScript: (code: string) => Promise<unknown>
}): Promise<unknown> {
  try {
    return await contents.executeJavaScript(WEBSOCKET_HOOK_SOURCE)
  } catch (error) {
    // The client works without notifications; a failed hook is not fatal.
    console.warn(`[desktop-notify] could not install the WebSocket hook: ${String(error)}`)
    return undefined
  }
}
