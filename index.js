/**
 * Completion notifier — Host half.
 *
 * Everything visible happens in the browser: the Web Client half watches the
 * Session UI status the page already maintains and raises a desktop
 * notification when a conversation stops running. This Host row exists so the
 * bundle owns a plugin entry (and a localized inventory row); it registers no
 * service, tool, or prompt section.
 */
export function apply() {}
