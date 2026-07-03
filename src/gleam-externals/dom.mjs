export function scrollMessagesToBottom() {
  if (typeof document === 'undefined') return
  setTimeout(() => {
    const messages = document.querySelector('.messages')
    if (messages) messages.scrollTop = messages.scrollHeight
  }, 0)
}

export function postInspectorMessage(message) {
  if (typeof document === 'undefined') return
  const payload = { type: message }
  let attempts = 0
  const send = () => {
    const iframe = document.querySelector('iframe[title="preview"]')
    iframe?.contentWindow?.postMessage(payload, '*')
    attempts += 1
    if (attempts < 12) setTimeout(send, 250)
  }
  send()
}

export function focusLayoutSegment() {
  // after Lustre re-renders: the newly active segment is the tab stop
  requestAnimationFrame(() => document.querySelector('.layoutSwitch .layoutSegment.active')?.focus())
}
