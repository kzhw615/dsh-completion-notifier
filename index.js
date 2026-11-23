/**
 * Completion notifier — Host half.
 *
 * The notification itself is raised by the browser half. This half supplies the
 * one piece of content the page cannot know on its own: the assistant text of
 * the turn that just finished. A background conversation is not open in the
 * page, so the client has no message history for it; here the Host watches
 * every committed `assistant/message` and keeps the latest non-empty text per
 * Session, then answers the page's private query route.
 *
 * The route is admitted by the same browser credential as the page: it exposes
 * nothing but the text the user is already allowed to read in that Session.
 */

/** Cordis plugin name. */
export const name = 'completion-notifier'

/** Absolute prefix of the package's private browser route. */
const CHANNEL = '/completion-notifier'

/** Longest reply text cached and returned; the banner only shows a line or two. */
const MAX_TEXT_CHARS = 4000

/**
 * Extract the visible text of one committed assistant message.
 * @param message - the `assistant/message` payload's message.
 * @returns joined text blocks, or an empty string when the step was tool-only.
 */
function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text.trim())
    }
  }
  return parts.join('\n')
}

/**
 * Cache the assistant's latest reply and serve it to the page.
 * @param ctx - registrant context.
 */
export function apply(ctx) {
  /** Latest non-empty assistant text per Session id. */
  const replies = new Map()

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
    const text = textOf(event.message)
    if (text === '') return
    replies.set(session.id, text.slice(0, MAX_TEXT_CHARS))
  }), 'completion-notifier: assistant reply cache')

  ctx.effect(() => ctx.on('session/disposed', (session) => {
    replies.delete(session.id)
  }), 'completion-notifier: reply cache cleanup')

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const webServer = webCtx.get('webServer')
    const connection = webCtx.get('connection')
    if (webServer === undefined || connection === undefined) {
      ctx.logger?.warn?.('completion-notifier: the web transport is unavailable, so notifications cannot read the reply text')
      return
    }

    /** Answer one browser request on the package's private channel. */
    function respond(req, res) {
      const admission = connection.admit(req)
      if (admission.rejection !== undefined) {
        res.writeHead(admission.rejection)
        res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET', 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      const url = new URL(req.url ?? CHANNEL, 'http://completion-notifier.invalid')
      if (url.pathname !== `${CHANNEL}/reply`) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      const text = replies.get(url.searchParams.get('session') ?? '') ?? ''
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, value: { text } }))
    }

    try {
      webCtx.effect(
        () => webServer.register({ kind: 'prefix', path: CHANNEL, handler: respond }),
        `completion-notifier: ${CHANNEL} route`,
      )
    } catch (error) {
      ctx.logger?.error?.('completion-notifier: could not register the reply route', error)
    }
  })
}
