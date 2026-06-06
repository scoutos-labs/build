export type Role = 'user' | 'assistant' | 'tool'

export type ChatMessage = {
  id: string
  role: Role
  content: string
}

export type ToolResult = {
  id: string
  tool_name: string
  input_data: Record<string, unknown>
  result: unknown
}

export type AtomEvent =
  | {
      atom_type: 'text_delta'
      data: { id: string; text: string }
    }
  | {
      atom_type: 'tool_intent'
      data: {
        id: string
        tool_name: string
        input_data: Record<string, unknown>
        reason?: string
      }
    }
  | {
      atom_type: 'final_answer'
      data: { id: string; text: string }
    }

export const ATOM_SCHEMAS = {
  text_delta: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['id', 'text'],
  },
  tool_intent: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      tool_name: { type: 'string' },
      input_data: { type: 'object' },
      reason: { type: 'string' },
    },
    required: ['id', 'tool_name', 'input_data'],
  },
  final_answer: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['id', 'text'],
  },
} as const
