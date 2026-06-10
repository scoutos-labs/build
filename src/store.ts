import type { AgentProvider, ChatMessage } from './agent'
import { summarizeSelectedElement } from './preview-inspector'
import type { ProjectFile } from './templates'
import { starterFiles } from './templates'
import * as agentActor from './actors/agent'
import * as chatActor from './actors/chat'
import * as previewActor from './actors/preview'
import * as projectActor from './actors/project'
import * as settingsActor from './actors/settings'
import * as wcActor from './actors/webcontainer'
import { interpretEffect, type RuntimeAdapters } from './runtime'

export type AppState = {
  readonly settings: settingsActor.SettingsState
  readonly project: projectActor.ProjectState
  readonly chat: chatActor.ChatState
  readonly agent: agentActor.AgentState
  readonly preview: previewActor.PreviewState
  readonly webcontainer: wcActor.WebContainerState
}

export type AppMsg =
  | { type: 'init_app' }
  | { type: 'save_settings' }
  | { type: 'submit_prompt'; now?: number; requestId?: string }
  | { type: 'improve_selected_element'; now?: number; requestId?: string }
  | { type: 'cancel_agent' }
  | { type: 'reset_project' }
  | { type: 'new_project' }
  | { type: 'open_project'; id: string }
  | { type: 'remove_project'; id: string }
  | { type: 'save_project'; silent?: boolean }
  | { type: 'sync_files_from_terminal' }
  | { type: 'settings'; msg: settingsActor.SettingsMsg }
  | { type: 'project'; msg: projectActor.ProjectMsg }
  | { type: 'chat'; msg: chatActor.ChatMsg }
  | { type: 'agent'; msg: agentActor.AgentMsg }
  | { type: 'preview'; msg: previewActor.PreviewMsg }
  | { type: 'webcontainer'; msg: wcActor.WebContainerMsg }

export type AppEffect =
  | { domain: 'settings'; payload: settingsActor.SettingsEffect }
  | { domain: 'project'; payload: projectActor.ProjectEffect }
  | { domain: 'agent'; payload: agentActor.AgentEffect }
  | { domain: 'preview'; payload: previewActor.PreviewEffect }
  | { domain: 'webcontainer'; payload: wcActor.WebContainerEffect }

const projectEffects = (effects: projectActor.ProjectEffect[]): AppEffect[] => effects.map(payload => ({ domain: 'project', payload }))
const chatMessages = (state: AppState) => [...state.chat.messages]
const projectFiles = (state: AppState) => [...state.project.files]

export function appInit(): AppState {
  return {
    settings: settingsActor.init(),
    project: projectActor.init(),
    chat: chatActor.init(),
    agent: agentActor.init(),
    preview: previewActor.init(),
    webcontainer: wcActor.init(),
  }
}

function requestId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function isBusy(state: AppState): boolean {
  return agentActor.isRunning(state.agent) || wcActor.isBusy(state.webcontainer)
}

function autoSaveEffects(state: AppState): AppEffect[] {
  if (!state.webcontainer.hydrated || state.webcontainer.suppressAutoSave) return []
  return [
    { domain: 'project', payload: { type: 'schedule_save', delay: 900 } },
  ]
}

function withAutoSave(state: AppState, effects: AppEffect[]): [AppState, AppEffect[]] {
  if (!state.webcontainer.hydrated || state.webcontainer.suppressAutoSave) return [state, effects]
  return [{ ...state, project: { ...state.project, saveStatus: 'Saving...' } }, [...effects, ...autoSaveEffects(state)]]
}

export function appUpdate(state: AppState, msg: AppMsg): [AppState, AppEffect[]] {
  switch (msg.type) {
    case 'init_app':
      return [state, [{ domain: 'project', payload: { type: 'load_initial_project' } }]]
    case 'save_settings':
      return [{ ...state, settings: { ...state.settings, settingsOpen: false } }, [{ domain: 'settings', payload: settingsActor.persistEffect(state.settings) }]]
    case 'submit_prompt': {
      const userPrompt = state.chat.prompt.trim()
      if (!userPrompt || isBusy(state)) return [state, []]
      if (!state.settings.model.trim() || (state.settings.provider === 'openrouter' && !state.settings.apiKey.trim())) {
        return [{ ...state, settings: { ...state.settings, settingsOpen: true } }, []]
      }
      const id = msg.requestId ?? requestId()
      const now = msg.now ?? Date.now()
      const previousMessages = chatMessages(state)
      const [chat] = chatActor.update(state.chat, { type: 'user_sent_message', content: userPrompt })
      const [agent, agentEffects] = agentActor.update(state.agent, { type: 'agent_request_started', requestId: id, startedAt: now })
      return [
        { ...state, chat, agent },
        [
          { domain: 'settings', payload: settingsActor.persistEffect(state.settings) },
          ...agentEffects.map(payload => ({ domain: 'agent' as const, payload })),
          { domain: 'agent', payload: { type: 'call_agent', requestId: id, provider: state.settings.provider, apiKey: state.settings.apiKey.trim(), ollamaUrl: state.settings.ollamaUrl.trim(), model: state.settings.model.trim(), userPrompt, files: projectFiles(state), messages: previousMessages } },
        ],
      ]
    }
    case 'improve_selected_element': {
      if (!state.preview.selectedElement || !state.preview.elementComment.trim() || isBusy(state)) return [state, []]
      if (!state.settings.model.trim() || (state.settings.provider === 'openrouter' && !state.settings.apiKey.trim())) {
        return [{ ...state, settings: { ...state.settings, settingsOpen: true } }, []]
      }
      const id = msg.requestId ?? requestId()
      const now = msg.now ?? Date.now()
      const comment = state.preview.elementComment.trim()
      const selectedElement = state.preview.selectedElement
      const previousMessages = chatMessages(state)
      const [chat] = chatActor.update(state.chat, { type: 'user_sent_message', content: `Selected ${summarizeSelectedElement(selectedElement)}: ${comment}` })
      const [agent, agentEffects] = agentActor.update(state.agent, { type: 'agent_request_started', requestId: id, startedAt: now })
      return [
        { ...state, chat, agent },
        [
          { domain: 'settings', payload: settingsActor.persistEffect(state.settings) },
          ...agentEffects.map(payload => ({ domain: 'agent' as const, payload })),
          { domain: 'agent', payload: { type: 'call_agent', requestId: id, provider: state.settings.provider, apiKey: state.settings.apiKey.trim(), ollamaUrl: state.settings.ollamaUrl.trim(), model: state.settings.model.trim(), userPrompt: 'Improve the selected preview element based on the user comment.', files: projectFiles(state), messages: previousMessages, selectedElement, elementComment: comment } },
        ],
      ]
    }
    case 'cancel_agent': {
      const [agent, effects] = agentActor.update(state.agent, { type: 'agent_request_canceled' })
      return [{ ...state, agent }, effects.map(payload => ({ domain: 'agent' as const, payload }))]
    }
    case 'reset_project': {
      const [agent, agentEffects] = agentActor.update(state.agent, { type: 'agent_request_canceled' })
      const [chat] = chatActor.update(state.chat, { type: 'chat_cleared' })
      const [project, effects] = projectActor.update(state.project, { type: 'reset_to_starter' })
      return [{ ...state, agent, chat, project }, [...agentEffects.map(payload => ({ domain: 'agent' as const, payload })), { domain: 'webcontainer', payload: { type: 'mount_and_install', files: starterFiles } }, ...projectEffects(effects.filter(e => e.type !== 'remount_project'))]]
    }
    case 'new_project': {
      const [agent, agentEffects] = agentActor.update(state.agent, { type: 'agent_request_canceled' })
      return [{ ...state, agent }, [...agentEffects.map(payload => ({ domain: 'agent' as const, payload })), { domain: 'project', payload: { type: 'create_project', name: 'Untitled Project', files: starterFiles, messages: [], selectedPath: starterFiles[2].path } }]]
    }
    case 'open_project': {
      const [agent, agentEffects] = agentActor.update(state.agent, { type: 'agent_request_canceled' })
      return [{ ...state, agent }, [...agentEffects.map(payload => ({ domain: 'agent' as const, payload })), { domain: 'project', payload: { type: 'open_project', id: msg.id } }]]
    }
    case 'remove_project':
      return [state, [{ domain: 'project', payload: { type: 'delete_project', id: msg.id } }]]
    case 'save_project':
      return [state, [{ domain: 'project', payload: { type: 'save_current_project', silent: msg.silent, name: state.project.projectName, files: projectFiles(state), messages: chatMessages(state), selectedPath: state.project.selectedPath, currentProjectId: state.project.currentProjectId } }]]
    case 'sync_files_from_terminal':
      return [state, [{ domain: 'webcontainer', payload: { type: 'read_files_from_container' } }]]
    case 'settings': {
      const [settings, effects] = settingsActor.update(state.settings, msg.msg)
      return [{ ...state, settings }, effects.map(payload => ({ domain: 'settings' as const, payload }))]
    }
    case 'chat': {
      const [chat] = chatActor.update(state.chat, msg.msg)
      const project = msg.msg.type === 'chat_cleared' ? { ...state.project, saveStatus: 'Unsaved changes' } : state.project
      const next: AppState = { ...state, chat, project }
      return msg.msg.type === 'prompt_changed' || msg.msg.type === 'message_toggled' ? [next, []] : withAutoSave(next, [])
    }
    case 'project': {
      const [project, effects] = projectActor.update(state.project, msg.msg)
      const next: AppState = { ...state, project }
      const mapped = projectEffects(effects)
      if (['project_name_changed', 'file_applied', 'files_updated', 'selected_path_changed', 'reset_to_starter'].includes(msg.msg.type)) return withAutoSave(next, mapped)
      if (msg.msg.type === 'project_ready') return [next, [{ domain: 'webcontainer', payload: { type: 'boot_container', files: projectFiles(next) } }]]
      return [next, mapped]
    }
    case 'agent': {
      const wasRunning = state.agent.lifecycle.status === 'running' && state.agent.lifecycle.requestId === ('requestId' in msg.msg ? msg.msg.requestId : undefined)
      const [agent, agentEffects] = agentActor.update(state.agent, msg.msg)
      let next: AppState = { ...state, agent }
      const stopEffects = agentEffects.filter(effect => effect.type !== 'install_if_needed')
      const installEffects = agentEffects.filter(effect => effect.type === 'install_if_needed')
      const effects: AppEffect[] = stopEffects.map(payload => ({ domain: 'agent' as const, payload }))
      if (msg.msg.type === 'agent_request_succeeded' && wasRunning) {
        const [chat] = chatActor.update(next.chat, { type: 'assistant_replied', content: msg.msg.reply })
        let project = next.project
        const writeEffects: AppEffect[] = []
        for (const patch of msg.msg.patches) {
          const [p, e] = projectActor.update(project, { type: 'file_applied', path: patch.path, content: patch.content })
          project = p
          writeEffects.push(...projectEffects(e))
        }
        next = { ...next, chat, project: { ...project, saveStatus: 'Unsaved changes' } }
        effects.push(...writeEffects, ...installEffects.map(payload => ({ domain: 'agent' as const, payload })))
        return withAutoSave(next, effects)
      } else if (msg.msg.type === 'agent_request_failed' && wasRunning) {
        const [chat] = chatActor.update(next.chat, { type: 'assistant_error', message: msg.msg.message })
        next = { ...next, chat }
        return withAutoSave(next, effects)
      }
      return [next, effects]
    }
    case 'preview': {
      const [preview, effects] = previewActor.update(state.preview, msg.msg)
      return [{ ...state, preview }, effects.map(payload => ({ domain: 'preview' as const, payload }))]
    }
    case 'webcontainer': {
      const [webcontainer, effects] = wcActor.update(state.webcontainer, msg.msg)
      return [{ ...state, webcontainer }, effects.map(payload => ({ domain: 'webcontainer' as const, payload }))]
    }
    default: {
      const _exhaustive: never = msg
      return [state, []]
    }
  }
}

type Listener = () => void

export function createStore(adapters?: RuntimeAdapters) {
  let state = appInit()
  const listeners = new Set<Listener>()

  function getState() { return state }
  function subscribe(listener: Listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  function emit() { listeners.forEach(listener => listener()) }
  function dispatch(msg: AppMsg) {
    const [nextState, effects] = appUpdate(state, msg)
    state = nextState
    emit()
    void runEffects(effects)
  }
  async function runEffects(effects: AppEffect[]) {
    for (const effect of effects) await interpretEffect(effect, dispatch, getState, adapters)
  }
  function setState(next: AppState) { state = next; emit() }

  return { getState, subscribe, dispatch, runEffects, setState }
}

export const store = createStore()

export function providerLabel(provider: AgentProvider) { return provider }
