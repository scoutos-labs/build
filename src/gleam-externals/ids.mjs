let counter = 0

export function newRequestId() {
  counter += 1
  const unique = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `req-${counter}-${unique}`
}

export function nowMs() {
  return Date.now()
}
