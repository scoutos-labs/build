import { ATOM_SCHEMAS, type AtomEvent, type ChatMessage, type ToolResult } from './atoms-protocol'
import { readSseStream } from './sse'

export type ToolIntent = {
  id: string
  tool_name: string
  input_data: Record<string, unknown>
  reason?: string
}

export type ScoutosAtomsResult = {
  reply: string
  toolIntents: ToolIntent[]
  finalAnswer?: string
}

export type ScoutosFollowUpResult = {
  reply: string
  finalAnswer?: string
}

export type ScoutosAtomsRequestArgs = {
  baseUrl: string
  apiKey: string
  instructions: string
  context: { messages: ChatMessage[]; metadata?: Record<string, unknown> }
  model?: string
  tools?: string[]
  signal?: AbortSignal
}

export type ScoutosFollowUpArgs = {
  baseUrl: string
  apiKey: string
  instructions: string
  context: { messages: ChatMessage[]; tool_results?: ToolResult[]; metadata?: Record<string, unknown> }
  toolResults: ToolResult[]
  model?: string
  tools?: string[]
  signal?: AbortSignal
}

export async function scoutosAtomsRequest(
  args: ScoutosAtomsRequestArgs,
): Promise<ScoutosAtomsResult | Error> {
  const body = buildBody(args)

  let response: Response
  try {
    response = await fetch(`${args.baseUrl.replace(/\/$/, '')}/atoms`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${args.apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: args.signal,
    })
  } catch (networkError) {
    return new Error(
      `Network error: ${networkError instanceof Error ? networkError.message : String(networkError)}`,
    )
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return new Error(`ScoutOS Atoms API error ${response.status}: ${text || response.statusText}`)
  }

  return parseAtomsStream(response)
}

export async function followUpWithToolResults(
  args: ScoutosFollowUpArgs,
): Promise<ScoutosFollowUpResult | Error> {
  const body = buildBody(args)
  body.tool_results = args.toolResults

  let response: Response
  try {
    response = await fetch(`${args.baseUrl.replace(/\/$/, '')}/atoms`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${args.apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: args.signal,
    })
  } catch (networkError) {
    return new Error(
      `Network error: ${networkError instanceof Error ? networkError.message : String(networkError)}`,
    )
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return new Error(`ScoutOS Atoms API error ${response.status}: ${text || response.statusText}`)
  }

  return parseFollowUpStream(response)
}

function buildBody(args: ScoutosAtomsRequestArgs): Record<string, unknown>
function buildBody(args: ScoutosFollowUpArgs): Record<string, unknown>
function buildBody(
  args: ScoutosAtomsRequestArgs | ScoutosFollowUpArgs,
): Record<string, unknown> {
  const agent: Record<string, unknown> = {
    tools: args.tools ?? [],
  }
  if (args.model) agent.model = args.model

  const body: Record<string, unknown> = {
    atoms: ATOM_SCHEMAS,
    instructions: args.instructions,
    context: args.context,
    cache: { read: false, write: false },
    agent,
  }

  // Include empty tool_results on initial request (follow-up will overwrite with actual results)
  if ('toolResults' in args) {
    body.tool_results = args.toolResults
  }

  return body
}

async function parseAtomsStream(
  response: Response,
): Promise<ScoutosAtomsResult | Error> {
  const textParts: string[] = []
  const toolIntents: ToolIntent[] = []
  let finalAnswer: string | undefined

  try {
    await readSseStream(response, (sseEvent) => {
      if (sseEvent.event !== 'message' && sseEvent.event !== 'atom') return
      let atom: AtomEvent | undefined
      try {
        atom = JSON.parse(sseEvent.data) as AtomEvent
      } catch {
        return
      }

      if (!atom || typeof atom.atom_type !== 'string') return

      if (atom.atom_type === 'text_delta' && atom.data?.text) {
        textParts.push(atom.data.text)
      } else if (atom.atom_type === 'tool_intent' && atom.data?.tool_name) {
        toolIntents.push({
          id: atom.data.id ?? '',
          tool_name: atom.data.tool_name,
          input_data: atom.data.input_data ?? {},
          reason: atom.data.reason,
        })
      } else if (atom.atom_type === 'final_answer' && atom.data?.text) {
        finalAnswer = atom.data.text
      }
    })
  } catch (parseError) {
    return new Error(
      `Failed to parse SSE stream: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
    )
  }

  return {
    reply: textParts.join('') || finalAnswer || '',
    toolIntents,
    finalAnswer,
  }
}

async function parseFollowUpStream(
  response: Response,
): Promise<ScoutosFollowUpResult | Error> {
  const textParts: string[] = []
  let finalAnswer: string | undefined

  try {
    await readSseStream(response, (sseEvent) => {
      if (sseEvent.event !== 'message' && sseEvent.event !== 'atom') return
      let atom: AtomEvent | undefined
      try {
        atom = JSON.parse(sseEvent.data) as AtomEvent
      } catch {
        return
      }

      if (!atom || typeof atom.atom_type !== 'string') return

      if (atom.atom_type === 'text_delta' && atom.data?.text) {
        textParts.push(atom.data.text)
      } else if (atom.atom_type === 'final_answer' && atom.data?.text) {
        finalAnswer = atom.data.text
      }
    })
  } catch (parseError) {
    return new Error(
      `Failed to parse SSE stream: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
    )
  }

  return {
    reply: textParts.join('') || finalAnswer || '',
    finalAnswer,
  }
}
