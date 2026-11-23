/**
 * Completion notifier — browser-half behavior test.
 *
 * Runs the real client module against a fake page: a fake `Notification`
 * class, a fake `document`, a fake reply route, and the Client services it
 * reads. Covers the exact running → stopped edge, the focused-conversation
 * skip, child-agent filtering, the confirmation wording, the reply body, the
 * per-conversation cooldown, and the click action.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const SOURCE = new URL('../client.js', import.meta.url)

/** Let the async reply lookup settle before asserting. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

/**
 * Load a fresh instance of the client module with fake browser globals.
 * @param options - permission, focus, clock, and the reply route behavior.
 * @returns the context, status controls, and recorded notifications.
 */
async function load(options = {}) {
  const {
    permission = 'granted',
    focused = false,
    now = 1_000,
    reply = '已经改好了，测试全部通过。',
    replyFails = false,
  } = options
  /** Notifications the page was asked to show. */
  const shown = []
  /** Reply lookups the page performed. */
  const lookups = []
  /** Conversations opened from a notification. */
  let focusedCalls = 0
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
        lookups.push(`open:${id}`)
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
  globalThis.fetch = async (url) => {
    lookups.push(String(url))
    if (replyFails) return { ok: false, status: 503, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { text: reply } }) }
  }
  const realNow = Date.now
  Date.now = () => now

  await import(`${SOURCE.href}?case=${Math.random()}`)
  const module = registered.factory()
  module.apply(ctx)
  Date.now = realNow

  return {
    shown,
    lookups,
    rows,
    setStatus,
    opened: () => lookups.filter(entry => entry.startsWith('open:')),
    focused: () => focusedCalls,
  }
}

test('notifies once with the app title and the reply body, and opens on click', async () => {
  const { shown, setStatus, rows, opened, focused } = await load()
  rows.a = { displayTitle: '重构持久化层', retainedBy: { mainView: 1 } }

  setStatus('a', true)
  setStatus('a', false)
  await flush()

  assert.equal(shown.length, 1)
  assert.equal(shown[0].title, 'DeepSeek Harness')
  assert.equal(shown[0].settings.body, '已经改好了，测试全部通过。')
  assert.equal(shown[0].settings.tag, 'dsh-completion-a')

  shown[0].onclick()
  assert.equal(focused(), 1)
  assert.deepEqual(opened(), ['open:a'])
  assert.equal(shown[0].closed, true)
})

test('stays quiet while the conversation is the focused main view', async () => {
  const { shown, setStatus, rows } = await load({ focused: true })
  rows.a = { displayTitle: 'A', retainedBy: { mainView: 1 } }

  setStatus('a', true)
  setStatus('a', false)
  await flush()

  assert.equal(shown.length, 0)
})

test('notifies for a background conversation even with the window focused', async () => {
  const { shown, setStatus, rows } = await load({ focused: true })
  rows.b = { displayTitle: 'B', retainedBy: { mainView: 0 } }

  setStatus('b', true)
  setStatus('b', false)
  await flush()

  assert.equal(shown.length, 1)
})

test('skips child agent sessions and rows the page does not know', async () => {
  const { shown, setStatus, rows } = await load()
  rows.child = { displayTitle: 'child', origin: 'subagent', retainedBy: {} }

  setStatus('child', true)
  setStatus('child', false)
  setStatus('missing', true)
  setStatus('missing', false)
  await flush()

  assert.equal(shown.length, 0)
})

test('reports a pending confirmation without reading the reply', async () => {
  const { shown, setStatus, rows, lookups } = await load()
  rows.a = { displayTitle: 'A', retainedBy: {} }

  setStatus('a', true)
  setStatus('a', false, { key: 'approval-1', kind: 'approval' })
  await flush()

  assert.equal(shown.length, 1)
  assert.equal(shown[0].settings.body, 'body.attention')
  assert.equal(lookups.length, 0)
})

test('falls back to the completion text when the reply route fails', async () => {
  const { shown, setStatus, rows } = await load({ replyFails: true })
  rows.a = { displayTitle: 'A', retainedBy: {} }

  setStatus('a', true)
  setStatus('a', false)
  await flush()

  assert.equal(shown.length, 1)
  assert.equal(shown[0].settings.body, 'body.completed')
})

test('folds a long reply into one bounded banner line', async () => {
  const long = `第一行内容\n\n${'很长的回复'.repeat(60)}`
  const { shown, setStatus, rows } = await load({ reply: long })
  rows.a = { displayTitle: 'A', retainedBy: {} }

  setStatus('a', true)
  setStatus('a', false)
  await flush()

  assert.equal(shown.length, 1)
  const body = shown[0].settings.body
  assert.equal(body.length, 160)
  assert.ok(body.endsWith('…'))
  assert.ok(!body.includes('\n'))
})

test('shows plain text without Markdown markers', async () => {
  const reply = '**完成**：`npm test` 通过，详见 [PR](https://example.com/pr)。\n\n```js\nconst a = 1\n```'
  const { shown, setStatus, rows } = await load({ reply })
  rows.a = { displayTitle: 'A', retainedBy: {} }

  setStatus('a', true)
  setStatus('a', false)
  await flush()

  assert.equal(shown.length, 1)
  assert.equal(shown[0].settings.body, '完成：npm test 通过，详见 PR。 const a = 1')
  assert.ok(!shown[0].settings.body.includes('`'))
  assert.ok(!shown[0].settings.body.includes('http'))
})

test('does not notify twice inside the cooldown window', async () => {
  const { shown, setStatus, rows } = await load({ now: 5_000 })
  rows.a = { displayTitle: 'A', retainedBy: {} }

  setStatus('a', true)
  setStatus('a', false)
  setStatus('a', true)
  setStatus('a', false)
  await flush()

  assert.equal(shown.length, 1)
})

test('never asks the page to notify without permission', async () => {
  const { shown, setStatus, rows } = await load({ permission: 'denied' })
  rows.a = { displayTitle: 'A', retainedBy: {} }

  setStatus('a', true)
  setStatus('a', false)
  await flush()

  assert.equal(shown.length, 0)
})
