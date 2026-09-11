import { describe, expect, it } from 'vitest'
import {
  APPROVAL_EVENT,
  EVENTS_ENDPOINT,
  eventsStreamIdFromOpen,
  notificationForFrame,
  USER_QUESTIONS_EVENT
} from '../src/main/remote-event-notify'

/**
 * Frames below marked "captured" were recorded from a real `dsh web` instance
 * by `scripts/probe-ws.mjs`. They are the reason the parser tolerates several
 * envelope shapes instead of assuming one.
 */
const CAPTURED_OPEN_SESSION_CONTROL = {
  type: 'open',
  streamId: '0a23b977-abd1-4333-ad62-3c1c6a631e4e',
  endpoint: 'session/control',
  payload: { args: {} }
}

const CAPTURED_ITEM_SESSION_CONTROL = {
  type: 'item',
  streamId: '0a23b977-abd1-4333-ad62-3c1c6a631e4e',
  value: { type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } }
}

const CAPTURED_OPEN_EVENTS = {
  type: 'open',
  streamId: 'events-stream-1',
  endpoint: '$events',
  payload: { args: {} }
}

describe('eventsStreamIdFromOpen', () => {
  it('learns the stream id from the captured $events opening frame', () => {
    expect(eventsStreamIdFromOpen(CAPTURED_OPEN_EVENTS)).toBe('events-stream-1')
  })

  it('ignores other streams, using the captured session-control frame', () => {
    expect(eventsStreamIdFromOpen(CAPTURED_OPEN_SESSION_CONTROL)).toBeUndefined()
  })

  it('ignores non-open frames and junk', () => {
    expect(eventsStreamIdFromOpen(CAPTURED_ITEM_SESSION_CONTROL)).toBeUndefined()
    expect(eventsStreamIdFromOpen(null)).toBeUndefined()
    expect(eventsStreamIdFromOpen('nope')).toBeUndefined()
    expect(eventsStreamIdFromOpen({ type: 'open', endpoint: EVENTS_ENDPOINT })).toBeUndefined()
  })
})

describe('notificationForFrame', () => {
  it('ignores the captured session-control baseline item', () => {
    expect(notificationForFrame(CAPTURED_ITEM_SESSION_CONTROL, 'events-stream-1')).toBeUndefined()
  })

  it('ignores items arriving on a different stream', () => {
    const frame = { type: 'item', streamId: 'other', value: { [APPROVAL_EVENT]: { toolName: 'bash' } } }
    expect(notificationForFrame(frame, 'events-stream-1')).toBeUndefined()
  })

  it('notifies for an approval request nested under a stream item', () => {
    const frame = {
      type: 'item',
      streamId: 'events-stream-1',
      value: { event: APPROVAL_EVENT, payload: { toolName: 'bash', reason: 'run the test suite' } }
    }
    expect(notificationForFrame(frame, 'events-stream-1')).toEqual({
      event: APPROVAL_EVENT,
      title: 'Approval needed',
      body: 'bash: run the test suite'
    })
  })

  it('notifies when the event name is the key rather than a discriminator', () => {
    const frame = { type: 'item', streamId: 's', value: { [APPROVAL_EVENT]: { toolName: 'write' } } }
    expect(notificationForFrame(frame, 's')?.body).toBe('write is waiting for your decision')
  })

  it('falls back to a generic body when the approval payload is unrecognised', () => {
    const frame = { type: 'item', streamId: 's', value: { [APPROVAL_EVENT]: {} } }
    expect(notificationForFrame(frame, 's')).toEqual({
      event: APPROVAL_EVENT,
      title: 'Approval needed',
      body: 'a tool is waiting for your decision'
    })
  })

  it('notifies for a user question and keeps the remaining count', () => {
    const frame = {
      type: 'item',
      streamId: 's',
      value: { event: USER_QUESTIONS_EVENT, payload: { questions: [{ question: 'Which branch?' }, { question: 'Why?' }] } }
    }
    expect(notificationForFrame(frame, 's')).toEqual({
      event: USER_QUESTIONS_EVENT,
      title: 'Input needed',
      body: 'Which branch? (+1 more)'
    })
  })

  it('reads a question given as a header instead of a question field', () => {
    const frame = { type: 'item', streamId: 's', value: { [USER_QUESTIONS_EVENT]: { questions: [{ header: 'Target' }] } } }
    expect(notificationForFrame(frame, 's')?.body).toBe('Target')
  })

  it('still notifies when the question text is missing', () => {
    const frame = { type: 'item', streamId: 's', value: { [USER_QUESTIONS_EVENT]: { questions: [] } } }
    expect(notificationForFrame(frame, 's')?.body).toBe('The agent asked a question')
  })

  it('accepts a bare event object, because the envelope is incidental', () => {
    expect(notificationForFrame({ [APPROVAL_EVENT]: { toolName: 'bash' } }, undefined)?.event).toBe(APPROVAL_EVENT)
  })

  it('finds the event no matter how deeply it is nested', () => {
    const frame = {
      type: 'item',
      streamId: 's',
      value: { wrapper: { inner: { deeper: { [APPROVAL_EVENT]: { toolName: 'edit' } } } } }
    }
    expect(notificationForFrame(frame, 's')?.body).toBe('edit is waiting for your decision')
  })

  it('ignores unrelated forwarded events from the allowlist', () => {
    for (const event of ['api-session/status', 'api-session/activity', 'commands/change', 'llm/adapters-updated']) {
      const frame = { type: 'item', streamId: 's', value: { event, payload: {} } }
      expect(notificationForFrame(frame, 's')).toBeUndefined()
    }
  })

  it('survives junk without throwing', () => {
    expect(notificationForFrame(null, 's')).toBeUndefined()
    expect(notificationForFrame('text', 's')).toBeUndefined()
    expect(notificationForFrame([], 's')).toBeUndefined()
    expect(notificationForFrame({ type: 'item', value: [] }, 's')).toBeUndefined()
  })
})
