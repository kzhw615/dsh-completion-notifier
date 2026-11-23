/**
 * Completion notifier — browser half.
 *
 * Uses the Session UI status the page already maintains (`uiSession`): when a
 * conversation goes from running to stopped, this module raises one desktop
 * notification unless you are already reading that conversation. The banner
 * names the application and carries the assistant's reply, which the Host half
 * keeps because a background conversation has no history in this page.
 *
 * Clicking the notification focuses the page and opens the conversation.
 */

window.__ModuleLoader__.load({
  id: 'dsh-completion-notifier',
  factory() {
    /** Locale namespace this package registers and binds. */
    const NS = 'completionNotifier'
    /** Do not repeat a notification for the same conversation inside this window. */
    const COOLDOWN_MS = 4000
    /** Banner title: the application, not the conversation. */
    const APP_TITLE = 'DeepSeek Harness'
    /** Longest reply line the banner carries before an ellipsis. */
    const REPLY_MAX_CHARS = 160

    const EN = {
      'body.completed': 'Turn complete. Click to open this conversation.',
      'body.attention': 'Waiting for your input. Click to open this conversation.',
    }

    const ZH = {
      'body.completed': '本轮已完成，点击打开这个会话。',
      'body.attention': '有操作等待你确认，点击打开这个会话。',
    }

    return {
      inject: ['sessions', 'uiSession', 'uiWorkspace', 'locale'],
      apply(ctx) {
        /** Translate one key in the language the page currently uses. */
        const say = key => ctx.locale.bind(NS)(key)

        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'completion-notifier: English dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'completion-notifier: Chinese dictionary')

        if (typeof globalThis.Notification !== 'function') return

        // Electron grants this for the application window; a plain browser asks
        // once, and it only accepts the request from a real gesture.
        ctx.effect(() => {
          if (Notification.permission !== 'default') return () => {}
          const ask = () => {
            try {
              void Notification.requestPermission().catch(() => {})
            } catch {}
          }
          window.addEventListener('pointerdown', ask, { once: true, capture: true })
          window.addEventListener('keydown', ask, { once: true, capture: true })
          return () => {
            window.removeEventListener('pointerdown', ask, true)
            window.removeEventListener('keydown', ask, true)
          }
        }, 'completion-notifier: permission request')

        /**
         * Read the assistant's latest reply for a conversation.
         * @param sessionId - conversation that just finished.
         * @returns the reply text, or an empty string when the Host cannot answer.
         */
        const readReply = async (sessionId) => {
          try {
            const response = await fetch(`completion-notifier/reply?session=${encodeURIComponent(sessionId)}`, {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            })
            if (!response.ok) return ''
            const payload = await response.json()
            const text = payload?.ok === true ? payload.value?.text : ''
            return typeof text === 'string' ? text : ''
          } catch {
            return ''
          }
        }

        /**
         * Reduce Markdown to the plain text a banner can show.
         * @param text - raw assistant text.
         * @returns text without fences, markers, links, or HTML tags.
         */
        const plainText = (text) => {
          let out = text.replace(/```[^\n]*\n?/g, '')
          out = out.replace(/`([^`\n]+)`/g, '$1')
          out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
          out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
          out = out.replace(/<[^>]+>/g, '')
          out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '')
          out = out.replace(/^\s{0,3}>\s?/gm, '')
          out = out.replace(/^\s{0,3}[-*+]\s+/gm, '')
          out = out.replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, '')
          out = out.replace(/\*\*([^*]+)\*\*/g, '$1')
          out = out.replace(/__([^_]+)__/g, '$1')
          out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
          out = out.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1$2')
          return out
        }

        /**
         * Fold a reply into one banner-sized line.
         * @param text - raw assistant text.
         * @returns single-line plain text with an ellipsis when it is too long.
         */
        const condense = (text) => {
          const line = plainText(text).replace(/\s+/g, ' ').trim()
          if (line.length <= REPLY_MAX_CHARS) return line
          return `${line.slice(0, REPLY_MAX_CHARS - 1).trimEnd()}…`
        }

        /** Last notification time per conversation, so one edge cannot double-fire. */
        const notifiedAt = new Map()

        /** Whether this conversation is the focused main view right now. */
        const isBeingRead = (sessionId) => {
          if (!document.hasFocus()) return false
          const row = ctx.sessions.list.getSnapshot().byId[sessionId]
          return (row?.retainedBy?.mainView ?? 0) > 0
        }

        /**
         * Raise one notification for a conversation that just stopped.
         * @param sessionId - conversation that finished.
         * @param status - the status row supplied by the completion edge.
         */
        const announce = async (sessionId, status) => {
          const now = Date.now()
          if (now - (notifiedAt.get(sessionId) ?? 0) < COOLDOWN_MS) return

          const row = ctx.sessions.list.getSnapshot().byId[sessionId]
          if (row === undefined) return
          // Child agents are work inside a conversation, not conversations.
          if (row.origin === 'subagent') return
          if (Notification.permission !== 'granted') return
          // Do not interrupt someone who is already reading this conversation.
          if (isBeingRead(sessionId)) return

          notifiedAt.set(sessionId, now)
          const attention = status.pendingInteraction !== undefined
          const reply = attention ? '' : condense(await readReply(sessionId))
          // Someone may have opened the conversation while the text loaded.
          if (isBeingRead(sessionId)) return

          const body = attention ? say('body.attention') : reply || say('body.completed')
          let notice
          try {
            notice = new Notification(APP_TITLE, { body, tag: `dsh-completion-${sessionId}` })
          } catch {
            notifiedAt.delete(sessionId)
            return
          }

          notice.onclick = () => {
            try {
              window.focus()
            } catch {}
            try {
              ctx.uiWorkspace.openSession(sessionId)
            } catch {}
            notice.close()
          }
        }

        // The page keeps one status map for every conversation: `undefined`
        // before a baseline, then the running flag the Host reports. Notify on
        // the exact true → false edge only.
        let previousRunning = new Map()
        ctx.effect(() => {
          const statuses = ctx.uiSession.sessionStatus
          const sync = () => {
            const next = statuses.getSnapshot()
            for (const [sessionId, status] of next) {
              if (previousRunning.get(sessionId) === true && status.running === false) {
                void announce(sessionId, status)
              }
            }
            const settled = new Map()
            for (const [sessionId, status] of next) settled.set(sessionId, status.running === true)
            previousRunning = settled
          }
          const dispose = statuses.subscribe(sync)
          sync()
          return dispose
        }, 'completion-notifier: turn completion')
      },
    }
  },
})
