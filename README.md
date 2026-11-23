# dsh-completion-notifier

Raise one desktop notification when a conversation finishes a turn, so leaving
the Harness window in the background does not mean losing the end of a long
task.

## Install

DeepSeek Harness → **Plugins** → **Add plugin**, then give it this repository:

```
https://github.com/kzhw615/dsh-completion-notifier
```

The bundle needs `dsh >= 0.2.2-rc.2`. It registers one Host row plus one Web
Client module; no build step, no dependencies, no network access.

## Behavior

- The page already tracks every conversation's running state (`uiSession`).
  This plugin watches the exact `running: true → false` edge and raises the
  browser's own `Notification` for that conversation.
- The banner title is the application name, **DeepSeek Harness**; the body is
  the assistant's reply for that turn. The Host half keeps the latest reply per
  Session, because a background conversation has no history in the page, and
  the Client reads it through the package's private route. When the same edge
  waits for your input, the body asks for that confirmation instead.
- Clicking the notification focuses the Harness page and opens that
  conversation.
- Nothing interrupts you while you read: a conversation that is the current
  main view of a focused window is skipped. Child agent sessions are skipped
  too, and one conversation cannot notify twice within four seconds.

To try it, switch to another application or another conversation and let a turn
finish; a notification for the conversation you were watching is intentionally
suppressed.

## Limitations

- Notifications come from the open page. Closing the window (or quitting the
  app) ends them; the Host half registers no service and works only while a
  Client is connected.
- Desktop grants notification permission to the application window. In a plain
  browser the page asks once, and the browser only accepts that request from a
  real click or key press; until it is granted no notification appears.
- The OS decides presentation: Focus modes, Do Not Disturb, and the
  application's notification settings can suppress the banner.

## Development

```sh
npm test    # node --test test/client.test.mjs
npm run check
```

The browser half is plain JavaScript loaded by the Client module table
(`window.__ModuleLoader__`); it reads `ctx.sessions.list` and
`ctx.uiSession.sessionStatus`, and calls `ctx.uiWorkspace.openSession` on click.
