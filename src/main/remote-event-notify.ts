/**
 * Turn Harness Remote events into desktop notifications.
 *
 * The Desktop app is a window onto a long-running local Harness, so the tasks
 * that matter are the ones that *stop and wait for a person*. Two forwarded
 * events have that shape:
 *
 *  - `approval/request` — a tool call needs a decision before it may run.
 *  - `user-questions/request` — the agent asked a structured question.
 *
 * Both arrive on the client's `$events` Remote stream, whose frames are
 * `{ type: 'item', streamId, value }` items. The event name and payload live
 * inside `value`, and the exact nesting is not part of any promise this app can
 * rely on, so the parser walks the value recursively looking for a known event
 * name instead of hard-coding a path. That keeps notifications working across
 * upstream envelope changes rather than silently going quiet.
 *
 * The pure half — parsing and the notify decision — is separated from the
 * Electron half so it can be unit-tested against captured frames.
 */

/** Forwarded event that means "a tool call is blocked on a human decision". */
export const APPROVAL_EVENT = 'approval/request'

/** Forwarded event that means "the agent asked the user a question". */
export const USER_QUESTIONS_EVENT = 'user-questions/request'

/** Where the client receives forwarded events. */
export const EVENTS_ENDPOINT = '$events'

/** A notification this app should show. */
export interface DesktopNotification {
  /** The forwarded event that produced it. */
  event: string
  /** Short headline for the notification title. */
  title: string
  /** One-line body. */
  body: string
}

/**
 * Whether a frame belongs to the forwarded-events stream.
 *
 * The client opens `$events` explicitly, so its `streamId` is learned from the
 * opening frame rather than guessed. Items on other streams (session control,
 * workspace follow) are ignored.
 *
 * @param payload - one decoded WebSocket text frame.
 * @returns the stream id when this frame opens the events stream.
 */
export function eventsStreamIdFromOpen(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const frame = payload as Record<string, unknown>
  if (frame.type !== 'open') return undefined
  if (frame.endpoint !== EVENTS_ENDPOINT) return undefined
  return typeof frame.streamId === 'string' && frame.streamId !== '' ? frame.streamId : undefined
}

/**
 * Depth-first search for the first value carrying a known event name.
 *
 * Only own enumerable properties are visited, and recursion is bounded so a
 * pathological frame cannot stall the main process.
 *
 * @param value - the candidate subtree.
 * @param names - event names to look for.
 * @param depth - remaining recursion budget.
 * @returns the found event name and its payload, if any.
 */
function findEvent(
  value: unknown,
  names: readonly string[],
  depth: number
): { name: string; payload: Record<string, unknown> } | undefined {
  if (depth <= 0 || value === null || typeof value !== 'object') return undefined

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEvent(item, names, depth - 1)
      if (found !== undefined) return found
    }
    return undefined
  }

  const record = value as Record<string, unknown>

  // Shape A: the event name is a key, its value the payload.
  for (const name of names) {
    const candidate = record[name]
    if (candidate !== undefined) {
      return {
        name,
        payload: candidate !== null && typeof candidate === 'object' ? (candidate as Record<string, unknown>) : {}
      }
    }
  }

  // Shape B: a discriminator field names the event, the payload sits beside it.
  for (const key of ['event', 'name', 'type'] as const) {
    const candidate = record[key]
    if (typeof candidate === 'string' && names.includes(candidate)) {
      const nested = record.payload ?? record.value ?? record.data
      return {
        name: candidate,
        payload: nested !== null && typeof nested === 'object' ? (nested as Record<string, unknown>) : record
      }
    }
  }

  for (const nested of Object.values(record)) {
    const found = findEvent(nested, names, depth - 1)
    if (found !== undefined) return found
  }
  return undefined
}

/** First non-empty string among the candidates. */
function firstText(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * Describe an approval request in one line.
 *
 * The Harness supplies `toolName` and an optional `reason`; anything else is
 * best-effort so an unrecognised payload still produces a useful notification
 * instead of none.
 *
 * @param payload - the approval request payload.
 * @returns the notification to show.
 */
function describeApproval(payload: Record<string, unknown>): DesktopNotification {
  const tool = firstText(payload, ['toolName', 'tool', 'name']) ?? 'a tool'
  const reason = firstText(payload, ['reason', 'message', 'detail', 'summary'])
  return {
    event: APPROVAL_EVENT,
    title: 'Approval needed',
    body: reason === undefined ? `${tool} is waiting for your decision` : `${tool}: ${reason}`
  }
}

/**
 * Describe a user-question request in one line.
 *
 * The payload carries a `questions` array; the first question's text is the
 * most useful thing to surface, since the notification cannot collect answers.
 *
 * @param payload - the question request payload.
 * @returns the notification to show.
 */
function describeQuestions(payload: Record<string, unknown>): DesktopNotification {
  const questions = Array.isArray(payload.questions) ? payload.questions : []
  const first = questions.find((item) => item !== null && typeof item === 'object') as
    | Record<string, unknown>
    | undefined
  const text =
    first === undefined
      ? undefined
      : firstText(first, ['question', 'text', 'prompt', 'title', 'header'])
  const extra = questions.length > 1 ? ` (+${questions.length - 1} more)` : ''
  return {
    event: USER_QUESTIONS_EVENT,
    title: 'Input needed',
    body: text === undefined ? 'The agent asked a question' : `${text}${extra}`
  }
}

/**
 * Convert one decoded frame into a notification, when it warrants one.
 *
 * @param payload - the decoded JSON frame.
 * @param eventsStreamId - the `$events` stream id learned from its opening frame.
 * @returns the notification, or undefined when the frame is unrelated.
 */
export function notificationForFrame(
  payload: unknown,
  eventsStreamId: string | undefined
): DesktopNotification | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const frame = payload as Record<string, unknown>

  // Stream items carry the event under `value`; accept a bare event object too,
  // since the allowlist is what matters and the envelope is incidental.
  let candidate: unknown = frame
  if (frame.type === 'item') {
    if (eventsStreamId !== undefined && frame.streamId !== eventsStreamId) return undefined
    candidate = frame.value
  }

  const found = findEvent(candidate, [APPROVAL_EVENT, USER_QUESTIONS_EVENT], 12)
  if (found === undefined) return undefined

  return found.name === APPROVAL_EVENT ? describeApproval(found.payload) : describeQuestions(found.payload)
}
