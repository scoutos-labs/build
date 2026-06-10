import { describe, expect, it } from 'vitest'
import { appInit, appUpdate, createStore, type AppEffect } from './store'
import type { SelectedPreviewElement } from './preview-inspector'

const validSettings = { provider: 'openrouter' as const, apiKey: ' key ', ollamaUrl: ' http://ollama/ ', model: ' model ', settingsOpen: false, connectionStatus: '' }

const element: SelectedPreviewElement = { tagName: 'BUTTON', id: 'save', classes: ['primary'], textContent: 'Save', outerHTML: '<button>Save</button>', boundingRect: { x: 0, y: 0, width: 1, height: 1 }, computedStyles: {} }
const readyWebcontainer = { ...appInit().webcontainer, bootPhase: { phase: 'ready' as const } }

function effectTypes(effects: AppEffect[]) {
  return effects.map(effect => `${effect.domain}:${effect.payload.type}`)
}

function callAgentEffect(effects: AppEffect[]) {
  const effect = effects.find((candidate): candidate is Extract<AppEffect, { domain: 'agent' }> => candidate.domain === 'agent' && candidate.payload.type === 'call_agent')
  if (!effect || effect.payload.type !== 'call_agent') throw new Error('call_agent effect missing')
  return effect.payload
}

describe('app store update composition', () => {
  it('validates prompt settings and does not start agent when missing model', () => {
    const state = { ...appInit(), chat: { ...appInit().chat, prompt: 'hi' } }
    const [next, effects] = appUpdate(state, { type: 'submit_prompt', now: 1, requestId: 'r1' })
    expect(next.settings.settingsOpen).toBe(true)
    expect(next.agent.lifecycle.status).toBe('idle')
    expect(effects).toEqual([])
  })

  it('submit_prompt appends user message, starts agent, persists settings, and carries snapshots', () => {
    const state = { ...appInit(), settings: validSettings, webcontainer: readyWebcontainer, chat: { ...appInit().chat, prompt: 'Build CRM', messages: [{ role: 'assistant' as const, content: 'old' }] } }
    const [next, effects] = appUpdate(state, { type: 'submit_prompt', now: 100, requestId: 'r1' })
    expect(next.chat.prompt).toBe('')
    expect(next.chat.messages.at(-1)).toEqual({ role: 'user', content: 'Build CRM' })
    expect(next.agent.lifecycle).toEqual({ status: 'running', requestId: 'r1', startedAt: 100 })
    expect(effectTypes(effects)).toEqual(['settings:persist_settings', 'agent:start_elapsed_timer', 'agent:call_agent'])
    const call = callAgentEffect(effects)
    expect(call).toMatchObject({ requestId: 'r1', userPrompt: 'Build CRM', apiKey: 'key', model: 'model' })
    expect(call.messages).toEqual([{ role: 'assistant', content: 'old' }])
  })

  it('improve_selected_element formats selected-element chat and agent effect', () => {
    const state = { ...appInit(), settings: validSettings, webcontainer: readyWebcontainer, preview: { ...appInit().preview, selectedElement: element, elementComment: 'make it red' } }
    const [next, effects] = appUpdate(state, { type: 'improve_selected_element', now: 100, requestId: 'r2' })
    expect(next.chat.messages.at(-1)?.content).toBe('Selected button#save.primary: make it red')
    const call = callAgentEffect(effects)
    expect(call).toMatchObject({ requestId: 'r2', userPrompt: 'Improve the selected preview element based on the user comment.', selectedElement: element, elementComment: 'make it red' })
  })

  it('agent success appends assistant, applies patches before package install, and schedules save when hydrated', () => {
    const running = { ...appInit(), settings: validSettings, chat: { ...appInit().chat, prompt: 'go' }, webcontainer: { ...readyWebcontainer, hydrated: true } }
    const [started] = appUpdate(running, { type: 'submit_prompt', now: 100, requestId: 'r1' })
    const [next, effects] = appUpdate(started, { type: 'agent', msg: { type: 'agent_request_succeeded', requestId: 'r1', reply: 'done', patches: [{ path: 'src/App.tsx', content: 'x' }, { path: 'package.json', content: '{}' }] } })
    expect(next.chat.messages.at(-1)).toEqual({ role: 'assistant', content: 'done' })
    expect(next.project.files.find(file => file.path === 'src/App.tsx')?.content).toBe('x')
    expect(effectTypes(effects)).toEqual(['agent:stop_elapsed_timer', 'project:write_file_to_container', 'project:write_file_to_container', 'agent:install_if_needed', 'project:schedule_save'])
  })

  it('store notifies subscribers once synchronously per dispatch', () => {
    const store = createStore()
    let calls = 0
    store.subscribe(() => { calls += 1 })
    store.dispatch({ type: 'chat', msg: { type: 'prompt_changed', value: 'x' } })
    expect(calls).toBe(1)
    expect(store.getState().chat.prompt).toBe('x')
  })
})
