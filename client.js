/**
 * Completion notifier — browser half.
 *
 * Uses the Session UI status the page already maintains (`uiSession`): when a
 * conversation goes from running to stopped, this module raises one desktop
 * notification unless you are already reading that conversation. Clicking the
 * notification focuses the page and opens the conversation.
 *
 * Nothing is sent anywhere: the notification is the browser's own API, so it
 * appears as the Harness application, works while the window is in the
 * background, and disappears with the page.
 */

window.__ModuleLoader__.load({
  id: 'dsh-completion-notifier',
  factory() {
    /** Locale namespace this package registers and binds. */
    const NS = 'completionNotifier'
    /** Do not repeat a notification for the same conversation inside this window. */
    const COOLDOWN_MS = 4000

    const EN = {
      'body.completed': 'Turn complete. Click to open this conversation.',
      'body.attention': 'Waiting for your input. Click to open this conversation.',
      'title.fallback': 'Conversation',
    }

    const ZH = {
      'body.completed': '本轮已完成，点击打开这个会话。',
      'body.attention': '有操作等待你确认，点击打开这个会话。',
      'title.fallback': '会话',
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

        /** Last notification time per conversation, so one edge cannot double-fire. */
        const notifiedAt = new Map()

        /**
         * Raise one notification for a conversation that just stopped.
         * @param sessionId - conversation that finished.
         * @param status - the status row supplied by the completion edge.
         */
        const announce = (sessionId, status) => {
          const now = Date.now()
          if (now - (notifiedAt.get(sessionId) ?? 0) < COOLDOWN_MS) return

          const row = ctx.sessions.list.getSnapshot().byId[sessionId]
          if (row === undefined) return
          // Child agents are work inside a conversation, not conversations.
          if (row.origin === 'subagent') return
          if (Notification.permission !== 'granted') return
          // Do not interrupt someone who is already reading this conversation.
          if (document.hasFocus() && (row.retainedBy?.mainView ?? 0) > 0) return

          notifiedAt.set(sessionId, now)
          const body = say(status.pendingInteraction === undefined ? 'body.completed' : 'body.attention')
          let notice
          try {
            notice = new Notification(row.displayTitle || say('title.fallback'), {
              body,
              tag: `dsh-completion-${sessionId}`,
            })
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
                announce(sessionId, status)
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
