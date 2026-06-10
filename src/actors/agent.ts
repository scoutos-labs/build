import type { AgentProvider, ChatMessage } from '../agent'
import type { SelectedPreviewElement } from '../preview-inspector'
import type { ProjectFile } from '../templates'

export type Patch = Readonly<{ path: string; content: string }>

export type AgentLifecycle =
  | { readonly status: 'idle' }
  | { readonly status: 'running'; readonly requestId: string; readonly startedAt: number }
  | { readonly status: 'timed_out'; readonly requestId: string }

export type AgentState = {
  readonly lifecycle: AgentLifecycle
  readonly elapsedSeconds: number
}

export type AgentMsg =
  | { type: 'agent_request_started'; requestId: string; startedAt: number }
  | { type: 'agent_elapsed_tick'; now: number }
  | { type: 'agent_request_succeeded'; requestId: string; reply: string; patches: readonly Patch[] }
  | { type: 'agent_request_failed'; requestId: string; message: string }
  | { type: 'agent_request_canceled' }
  | { type: 'agent_timeout_reached'; requestId: string }

export type AgentEffect =
  | { type: 'call_agent'; requestId: string; provider: AgentProvider; apiKey: string; ollamaUrl: string; model: string; userPrompt: string; files: ProjectFile[]; messages: ChatMessage[]; selectedElement?: SelectedPreviewElement; elementComment?: string }
  | { type: 'start_elapsed_timer' }
  | { type: 'stop_elapsed_timer' }
  | { type: 'abort_agent' }
  | { type: 'install_if_needed'; patches: readonly Patch[] }

export function init(): AgentState {
  return { lifecycle: { status: 'idle' }, elapsedSeconds: 0 }
}

export function isRunning(state: AgentState): boolean {
  return state.lifecycle.status === 'running'
}

export function update(state: AgentState, msg: AgentMsg): [AgentState, AgentEffect[]] {
  switch (msg.type) {
    case 'agent_request_started':
      return [{ lifecycle: { status: 'running', requestId: msg.requestId, startedAt: msg.startedAt }, elapsedSeconds: 0 }, [{ type: 'start_elapsed_timer' }]]
    case 'agent_elapsed_tick':
      return state.lifecycle.status === 'running'
        ? [{ ...state, elapsedSeconds: Math.floor((msg.now - state.lifecycle.startedAt) / 1000) }, []]
        : [state, []]
    case 'agent_request_succeeded':
      if (state.lifecycle.status !== 'running' || state.lifecycle.requestId !== msg.requestId) return [state, []]
      return [{ lifecycle: { status: 'idle' }, elapsedSeconds: 0 }, [{ type: 'stop_elapsed_timer' }, { type: 'install_if_needed', patches: msg.patches }]]
    case 'agent_request_failed':
      if (state.lifecycle.status !== 'running' || state.lifecycle.requestId !== msg.requestId) return [state, []]
      return [{ lifecycle: { status: 'idle' }, elapsedSeconds: 0 }, [{ type: 'stop_elapsed_timer' }]]
    case 'agent_request_canceled':
      return state.lifecycle.status === 'running'
        ? [{ lifecycle: { status: 'idle' }, elapsedSeconds: 0 }, [{ type: 'stop_elapsed_timer' }, { type: 'abort_agent' }]]
        : [state, []]
    case 'agent_timeout_reached':
      if (state.lifecycle.status !== 'running' || state.lifecycle.requestId !== msg.requestId) return [state, []]
      return [{ lifecycle: { status: 'timed_out', requestId: msg.requestId }, elapsedSeconds: state.elapsedSeconds }, [{ type: 'stop_elapsed_timer' }, { type: 'abort_agent' }]]
    default: {
      const _exhaustive: never = msg
      return [state, []]
    }
  }
}
