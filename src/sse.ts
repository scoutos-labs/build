type SseEvent = {
  event: string
  data: string
}

export async function readSseStream(
  response: Response,
  onEvent: (event: SseEvent) => void,
) {
  if (!response.body) {
    throw new Error('Response did not include a stream body.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      const event = parseSseEvent(part)
      if (event) onEvent(event)
    }
  }

  const finalEvent = parseSseEvent(buffer)
  if (finalEvent) onEvent(finalEvent)
}

export function parseSseEvent(raw: string): SseEvent | null {
  const lines = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  let event = 'message'
  const data: string[] = []

  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
    if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart())
  }

  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}
