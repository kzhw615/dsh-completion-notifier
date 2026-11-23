/**
 * Completion notifier — Host-half test.
 *
 * Loads the real Host module with a fake Cordis context: it dispatches
 * committed assistant messages into the reply cache and then calls the private
 * browser route the way the page does, checking the text, the auth rejection,
 * and the method guard.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/**
 * Build a fake Host context and the captured route.
 * @returns the captured handlers, the route, and admission rejection control.
 */
function mount() {
  const handlers = {}
  const state = { route: undefined, reject: false }

  const webServer = {
    register(route) {
      state.route = route
      return () => {}
    },
  }
  const connection = {
    admit() {
      return state.reject ? { rejection: 401 } : {}
    },
  }

  const ctx = {
    effect: factory => factory(),
    on: (name, handler) => {
      handlers[name] = handler
      return () => {}
    },
    inject: (dependencies, callback) => callback({
      get: name => (name === 'webServer' ? webServer : connection),
      effect: factory => factory(),
    }),
    logger: { warn() {}, error() {} },
  }

  apply(ctx)
  return { handlers, state }
}

/** Minimal Node-style response recorder. */
function response() {
  const out = { code: 0, headers: {}, body: '' }
  return {
    out,
    writeHead(code, headers) {
      out.code = code
      out.headers = headers ?? {}
    },
    end(body) {
      out.body = body ?? ''
    },
  }
}

const SESSION = 'session-1'

test('caches the latest assistant text and answers the private route', () => {
  const { handlers, state } = mount()

  handlers['session/event']({ id: SESSION }, {
    type: 'assistant/message',
    message: {
      content: [
        { type: 'text', text: '重构完成。' },
        { type: 'tool-call', name: 'bash' },
        { type: 'text', text: '测试全绿。' },
      ],
    },
  })

  const res = response()
  state.route.handler({ method: 'GET', url: `/completion-notifier/reply?session=${SESSION}` }, res)

  assert.equal(res.out.code, 200)
  assert.deepEqual(JSON.parse(res.out.body), { ok: true, value: { text: '重构完成。\n测试全绿。' } })
})

test('keeps the previous text when a step carries only tool calls', () => {
  const { handlers, state } = mount()

  handlers['session/event']({ id: SESSION }, {
    type: 'assistant/message',
    message: { content: [{ type: 'text', text: '先回答你。' }] },
  })
  handlers['session/event']({ id: SESSION }, {
    type: 'assistant/message',
    message: { content: [{ type: 'tool-call', name: 'bash' }] },
  })

  const res = response()
  state.route.handler({ method: 'GET', url: `/completion-notifier/reply?session=${SESSION}` }, res)
  assert.equal(JSON.parse(res.out.body).value.text, '先回答你。')
})

test('rejects a request the browser credential does not admit', () => {
  const { state } = mount()
  state.reject = true

  const res = response()
  state.route.handler({ method: 'GET', url: `/completion-notifier/reply?session=${SESSION}` }, res)

  assert.equal(res.out.code, 401)
  assert.equal(res.out.body, 'unauthorized')
})

test('rejects another method and an unknown endpoint', () => {
  const { state } = mount()

  const post = response()
  state.route.handler({ method: 'POST', url: `/completion-notifier/reply?session=${SESSION}` }, post)
  assert.equal(post.out.code, 405)

  const missing = response()
  state.route.handler({ method: 'GET', url: '/completion-notifier/nope' }, missing)
  assert.equal(missing.out.code, 404)
})

test('forgets a Session when it is disposed', () => {
  const { handlers, state } = mount()

  handlers['session/event']({ id: SESSION }, {
    type: 'assistant/message',
    message: { content: [{ type: 'text', text: '临时内容。' }] },
  })
  handlers['session/disposed']({ id: SESSION })

  const res = response()
  state.route.handler({ method: 'GET', url: `/completion-notifier/reply?session=${SESSION}` }, res)
  assert.equal(JSON.parse(res.out.body).value.text, '')
})
