/**
 * Completion notifier — browser-half behavior test.
 *
 * Runs the real client module against a fake page: a fake `Notification`
 * class, a fake `document`, and the two Client services it reads. Covers the
 * exact running → stopped edge, the focused-conversation skip, child-agent
 * filtering, the confirmation wording, the per-conversation cooldown, and the
 * click action.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const SOURCE = new URL('../client.js', import.meta.url)

/**
 * Load a fresh instance of the client module with fake browser globals.
 * @param options - permission state, focus state, and the clock.
 * @returns the module, its context, and the recorded notifications.
 */
function load(options = {}) {
  const { permission = 'granted', focused = false, now = 1_000 } = options
  /** Notifications the page was asked to show. */
  const shown = []
  /** Clicks performed on a notification. */
  let focusedCalls = 0
  /** Conversations opened from a notification. */
  const opened = []
  /** Module registered by the loader. */
  let registered

  class FakeNotification {
    static permission = permission
    static requestPermission = async () => permission

    constructor(title, settings) {
      this.title = title
      this.settings = settings
      this.closed = false
      shown.push(this)
    }

    close() {
      this.closed = true
    }
  }

  const statuses = new Map()
  const subscribers = new Set()
  const rows = {}

  const ctx = {
    effect(factory) {
      return factory()
    },
    locale: {
      register() {},
      bind: () => key => key,
    },
    sessions: {
      list: { getSnapshot: () => ({ byId: rows }) },
    },
    uiSession: {
      sessionStatus: {
        getSnapshot: () => statuses,
        subscribe: (listener) => {
          subscribers.add(listener)
          return () => subscribers.delete(listener)
        },
      },
    },
    uiWorkspace: {
      openSession: (id) => {
        opened.push(id)
      },
    },
  }

  const setStatus = (id, running, pendingInteraction) => {
    statuses.set(id, { running, pendingInteraction, completionUnread: false })
    for (const listener of [...subscribers]) listener()
  }

  globalThis.window = {
    __ModuleLoader__: {
      load: (definition) => {
        registered = definition
      },
    },
    addEventListener() {},
    removeEventListener() {},
    focus: () => {
      focusedCalls += 1
    },
  }
  globalThis.document = { hasFocus: () => focused }
  globalThis.Notification = FakeNotification
  const realNow = Date.now
  Date.now = () => now

  return import(`${SOURCE.href}?case=${Math.random()}`).then(() => {
    const module = registered.factory()
    module.apply(ctx)
    Date.now = realNow
    return { module, shown, setStatus, rows, opened, focused: () => focusedCalls }
  })
}

test('notifies once on the true → false edge and opens on click', async () => {
  const { shown, setStatus, rows, opened, focused } = await load()
  rows.a = { displayTitle: '重构持久化层', retainedBy: { mainView: 1 }, origin: undefined }

  setStatus('a', true)
  setStatus('a', false)

  assert.equal(shown.length, 1)
  assert.equal(shown[0].title, '重构持久化层')
  assert.equal(shown[0].settings.body, 'body.completed')
  assert.equal(shown[0].settings.tag, 'dsh-completion-a')

  shown[0].onclick()
  assert.equal(focused(), 1)
  assert.deepEqual(opened, ['a'])
  assert.equal(shown[0].closed, true)
})

test('stays quiet while the conversation is the focused main view', async () => {
  const { shown, setStatus, rows } = await load({ focused: true })
  rows.a = { displayTitle: 'A', retainedBy: { mainView: 1 } }

  setStatus('a', true)
  setStatus('a', false)

  assert.equal(shown.length, 0)
})

test('notifies for a background conversation even with the window focused', async () => {
  const { shown, setStatus, rows } = await load({ focused: true })
  rows.b = { displayTitle: 'B', retainedBy: { mainView: 0 } }

  setStatus('b', true)
  setStatus('b', false)

  assert.equal(shown.length, 1)
})

test('skips child agent sessions and rows the page does not know', async () => {
  const { shown, setStatus, rows } = await load()
  rows.child = { displayTitle: 'child', origin: 'subagent', retainedBy: {} }

  setStatus('child', true)
  setStatus('child', false)
  setStatus('missing', true)
  setStatus('missing', false)

  assert.equal(shown.length, 0)
})

test('reports a pending confirmation instead of completion', async () => {
  const { shown, setStatus, rows } = await load()
  rows.a = { displayTitle: 'A', retainedBy: {} }

  setStatus('a', true)
  setStatus('a', false, { key: 'approval-1', kind: 'approval' })

  assert.equal(shown.length, 1)
  assert.equal(shown[0].settings.body, 'body.attention')
})

test('does not notify twice inside the cooldown window', async () => {
  const { shown, setStatus, rows } = await load({ now: 5_000 })
  rows.a = { displayTitle: 'A', retainedBy: {} }

  setStatus('a', true)
  setStatus('a', false)
  setStatus('a', true)
  setStatus('a', false)

  assert.equal(shown.length, 1)
})

test('never asks the page to notify without permission', async () => {
  const { shown, setStatus, rows } = await load({ permission: 'denied' })
  rows.a = { displayTitle: 'A', retainedBy: {} }

  setStatus('a', true)
  setStatus('a', false)

  assert.equal(shown.length, 0)
})
