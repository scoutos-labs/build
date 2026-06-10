import { runAgent } from '../agent'
import { createProject, deleteProject, formatUpdatedAt, getCurrentProjectId, getProject, listProjects, saveProject, setCurrentProjectId } from '../projects'
import { mountProject, readProjectFilesFromWebContainer, runInstall, startDevServer, writeProjectFile } from '../webcontainer'
import type { AppEffect, AppMsg, AppState } from '../store'
import { starterFiles } from '../templates'

export type Dispatch = (msg: AppMsg) => void
export type GetState = () => AppState

export type RuntimeAdapters = {
  previewWindow?: () => Window | null | undefined
  storage?: Pick<Storage, 'setItem'>
  fetch?: typeof fetch
  locationOrigin?: string
}

let activeController: AbortController | null = null
let activeRequestId: string | null = null
let activeTimeout: number | ReturnType<typeof setTimeout> | null = null
let elapsedTimer: number | ReturnType<typeof setInterval> | null = null
let saveTimer: number | ReturnType<typeof setTimeout> | null = null

function clearActiveRequest(requestId?: string) {
  if (requestId && activeRequestId !== requestId) return
  if (activeTimeout) clearTimeout(activeTimeout)
  activeTimeout = null
  activeController = null
  activeRequestId = null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function appendAndRunInstall(dispatch: Dispatch) {
  dispatch({ type: 'webcontainer', msg: { type: 'log_appended', line: 'package.json changed; running npm install...' } })
  await runInstall(line => dispatch({ type: 'webcontainer', msg: { type: 'log_appended', line } }))
}

export async function interpretEffect(effect: AppEffect, dispatch: Dispatch, getState: GetState, adapters: RuntimeAdapters = {}): Promise<void> {
  switch (effect.domain) {
    case 'settings': {
      switch (effect.payload.type) {
        case 'persist_settings': {
          const storage = adapters.storage ?? localStorage
          storage.setItem('agent-provider', effect.payload.provider)
          storage.setItem('openrouter-key', effect.payload.apiKey.trim())
          storage.setItem('ollama-url', effect.payload.ollamaUrl.trim())
          storage.setItem('agent-model', effect.payload.model.trim())
          return
        }
        case 'test_ollama_connection': {
          try {
            const baseUrl = effect.payload.url.trim().replace(/\/$/, '')
            const response = await (adapters.fetch ?? fetch)(`${baseUrl}/api/tags`)
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
            const data = await response.json()
            const names = data.models?.map((m: { name: string }) => m.name).join(', ') || 'no models listed'
            dispatch({ type: 'settings', msg: { type: 'connection_status_changed', status: `Ollama reachable. Models: ${names}` } })
          } catch (error) {
            const detail = errorMessage(error)
            const origin = adapters.locationOrigin ?? location.origin
            dispatch({ type: 'settings', msg: { type: 'connection_status_changed', status: `Could not reach Ollama. If Ollama is running, this is likely CORS. Try: OLLAMA_ORIGINS=${origin} ollama serve. Details: ${detail}` } })
          }
          return
        }
      }
      break
    }
    case 'project': {
      switch (effect.payload.type) {
        case 'load_initial_project': {
          try {
            const projects = await listProjects()
            dispatch({ type: 'project', msg: { type: 'project_list_refreshed', projects } })
            const id = await getCurrentProjectId()
            const project = id ? await getProject(id) : undefined
            if (project) {
              dispatch({ type: 'project', msg: { type: 'project_loaded', id: project.id, name: project.name, files: project.files.length ? project.files : starterFiles, selectedPath: project.selectedPath || starterFiles[2].path, updatedAt: project.updatedAt } })
              dispatch({ type: 'chat', msg: { type: 'messages_replaced', messages: project.messages } })
            }
          } catch (error) {
            dispatch({ type: 'webcontainer', msg: { type: 'log_appended', line: errorMessage(error) } })
          } finally {
            dispatch({ type: 'project', msg: { type: 'project_ready' } })
          }
          return
        }
        case 'save_current_project': {
          const name = effect.payload.name.trim() || 'Untitled Project'
          const now = new Date().toISOString()
          const existing = effect.payload.currentProjectId ? await getProject(effect.payload.currentProjectId) : undefined
          const project = existing
            ? { ...existing, name, files: effect.payload.files, messages: effect.payload.messages, selectedPath: effect.payload.selectedPath, updatedAt: now }
            : await createProject({ name, files: effect.payload.files, messages: effect.payload.messages, selectedPath: effect.payload.selectedPath })
          const saved = existing ? await saveProject(project) : project
          dispatch({ type: 'project', msg: { type: 'project_loaded', id: saved.id, name: saved.name, files: saved.files, selectedPath: saved.selectedPath, updatedAt: saved.updatedAt } })
          dispatch({ type: 'project', msg: { type: 'save_status_changed', status: effect.payload.silent ? `Auto-saved ${formatUpdatedAt(saved.updatedAt)}` : 'Saved just now' } })
          await setCurrentProjectId(saved.id)
          const projects = await listProjects()
          dispatch({ type: 'project', msg: { type: 'project_list_refreshed', projects } })
          return
        }
        case 'create_project': {
          const created = await createProject(effect.payload)
          await setCurrentProjectId(created.id)
          dispatch({ type: 'project', msg: { type: 'project_created', id: created.id, name: created.name, files: created.files, selectedPath: created.selectedPath } })
          dispatch({ type: 'chat', msg: { type: 'chat_cleared' } })
          dispatch({ type: 'webcontainer', msg: { type: 'remount_requested', files: created.files } })
          dispatch({ type: 'project', msg: { type: 'project_list_refreshed', projects: await listProjects() } })
          return
        }
        case 'open_project': {
          const project = await getProject(effect.payload.id)
          if (!project) return
          await setCurrentProjectId(project.id)
          dispatch({ type: 'project', msg: { type: 'project_loaded', id: project.id, name: project.name, files: project.files, selectedPath: project.selectedPath || project.files[0]?.path || starterFiles[2].path, updatedAt: project.updatedAt } })
          dispatch({ type: 'chat', msg: { type: 'messages_replaced', messages: project.messages } })
          dispatch({ type: 'project', msg: { type: 'projects_dialog_closed' } })
          dispatch({ type: 'webcontainer', msg: { type: 'remount_requested', files: project.files } })
          return
        }
        case 'delete_project': {
          await deleteProject(effect.payload.id)
          const current = getState().project.currentProjectId
          if (effect.payload.id === current) {
            await setCurrentProjectId(null)
            dispatch({ type: 'project', msg: { type: 'project_loaded', id: null, name: 'Untitled Project', files: starterFiles, selectedPath: starterFiles[2].path } })
            dispatch({ type: 'project', msg: { type: 'save_status_changed', status: 'Not saved' } })
            dispatch({ type: 'chat', msg: { type: 'chat_cleared' } })
            dispatch({ type: 'webcontainer', msg: { type: 'remount_requested', files: starterFiles } })
          }
          dispatch({ type: 'project', msg: { type: 'project_list_refreshed', projects: await listProjects() } })
          return
        }
        case 'refresh_project_list':
          dispatch({ type: 'project', msg: { type: 'project_list_refreshed', projects: await listProjects() } })
          return
        case 'persist_current_project_id':
          await setCurrentProjectId(effect.payload.id)
          return
        case 'write_file_to_container':
          await writeProjectFile(effect.payload.path, effect.payload.content)
          return
        case 'remount_project':
          dispatch({ type: 'webcontainer', msg: { type: 'remount_requested', files: effect.payload.files } })
          return
        case 'schedule_save': {
          if (saveTimer) clearTimeout(saveTimer)
          saveTimer = setTimeout(() => {
            saveTimer = null
            dispatch({ type: 'save_project', silent: true })
          }, effect.payload.delay)
          return
        }
      }
      break
    }
    case 'agent': {
      switch (effect.payload.type) {
        case 'start_elapsed_timer':
          if (elapsedTimer) clearInterval(elapsedTimer)
          elapsedTimer = setInterval(() => {
            const lifecycle = getState().agent.lifecycle
            if (lifecycle.status === 'running') dispatch({ type: 'agent', msg: { type: 'agent_elapsed_tick', now: Date.now() } })
          }, 500)
          return
        case 'stop_elapsed_timer':
          if (elapsedTimer) clearInterval(elapsedTimer)
          elapsedTimer = null
          return
        case 'abort_agent':
          activeController?.abort()
          clearActiveRequest()
          return
        case 'install_if_needed':
          if (effect.payload.patches.some(patch => patch.path === 'package.json')) await appendAndRunInstall(dispatch)
          return
        case 'call_agent': {
          const controller = new AbortController()
          activeController = controller
          activeRequestId = effect.payload.requestId
          activeTimeout = setTimeout(() => controller.abort(), 300_000)
          try {
            const result = await runAgent({ provider: effect.payload.provider, apiKey: effect.payload.apiKey, ollamaUrl: effect.payload.ollamaUrl, model: effect.payload.model, userPrompt: effect.payload.userPrompt, files: effect.payload.files, messages: effect.payload.messages, selectedElement: effect.payload.selectedElement, elementComment: effect.payload.elementComment, signal: controller.signal })
            dispatch({ type: 'agent', msg: { type: 'agent_request_succeeded', requestId: effect.payload.requestId, reply: result.reply, patches: result.patches } })
          } catch (error) {
            const raw = error instanceof DOMException && error.name === 'AbortError' ? 'Request canceled or timed out after 5 minutes.' : errorMessage(error)
            const message = effect.payload.provider === 'ollama' && /fetch|network|failed/i.test(raw)
              ? `${raw}\n\nOllama troubleshooting: make sure Ollama is running at ${effect.payload.ollamaUrl}. If it is running, restart it with CORS enabled: OLLAMA_ORIGINS=${adapters.locationOrigin ?? location.origin} ollama serve`
              : raw
            dispatch({ type: 'agent', msg: { type: 'agent_request_failed', requestId: effect.payload.requestId, message } })
            dispatch({ type: 'webcontainer', msg: { type: 'log_appended', line: message } })
          } finally {
            clearActiveRequest(effect.payload.requestId)
          }
          return
        }
      }
      break
    }
    case 'preview': {
      switch (effect.payload.type) {
        case 'post_inspector_message':
          adapters.previewWindow?.()?.postMessage({ type: effect.payload.message }, '*')
          return
      }
      break
    }
    case 'webcontainer': {
      switch (effect.payload.type) {
        case 'boot_container': {
          dispatch({ type: 'webcontainer', msg: { type: 'boot_started' } })
          try {
            dispatch({ type: 'webcontainer', msg: { type: 'log_appended', line: 'Booting WebContainer...' } })
            await mountProject(effect.payload.files)
            dispatch({ type: 'webcontainer', msg: { type: 'phase_changed', phase: { phase: 'installing' } } })
            dispatch({ type: 'webcontainer', msg: { type: 'log_appended', line: 'Installing dependencies...' } })
            await runInstall(line => dispatch({ type: 'webcontainer', msg: { type: 'log_appended', line } }))
            dispatch({ type: 'webcontainer', msg: { type: 'phase_changed', phase: { phase: 'starting_dev_server' } } })
            dispatch({ type: 'webcontainer', msg: { type: 'log_appended', line: 'Starting preview server...' } })
            await startDevServer(line => dispatch({ type: 'webcontainer', msg: { type: 'log_appended', line } }), url => dispatch({ type: 'preview', msg: { type: 'preview_url_changed', url } }))
            dispatch({ type: 'webcontainer', msg: { type: 'boot_succeeded' } })
          } catch (error) {
            dispatch({ type: 'webcontainer', msg: { type: 'boot_failed', message: errorMessage(error) } })
          }
          return
        }
        case 'mount_and_install':
          try {
            await mountProject(effect.payload.files)
            dispatch({ type: 'webcontainer', msg: { type: 'log_appended', line: 'Installing project dependencies...' } })
            await runInstall(line => dispatch({ type: 'webcontainer', msg: { type: 'log_appended', line } }))
          } finally {
            dispatch({ type: 'webcontainer', msg: { type: 'remount_finished' } })
          }
          return
        case 'start_dev_server':
          await startDevServer(line => dispatch({ type: 'webcontainer', msg: { type: 'log_appended', line } }), url => dispatch({ type: 'preview', msg: { type: 'preview_url_changed', url } }))
          return
        case 'run_npm_install':
          await appendAndRunInstall(dispatch)
          return
        case 'read_files_from_container': {
          const files = await readProjectFilesFromWebContainer()
          if (files.length) dispatch({ type: 'project', msg: { type: 'files_updated', files, status: `Synced ${files.length} files from terminal` } })
          else dispatch({ type: 'project', msg: { type: 'save_status_changed', status: 'No files found to sync' } })
          return
        }
      }
    }
  }
}
