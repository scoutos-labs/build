import { dispatchChatCleared, dispatchChatMessagesReplaced, dispatchProjectCreated, dispatchProjectListRefreshed, dispatchProjectLoaded, dispatchProjectReady, dispatchProjectsDialogClosed, dispatchProjectSaveStatus, dispatchWebContainerLog, dispatchWebContainerRemountRequested } from './runtime_bridge.mjs'

let saveTimer = null
let lastSavePayload = null
let fallbackProjects = []
const fallbackStarterFiles = [
  { path: 'package.json', content: '{}' },
  { path: 'index.html', content: '<div id="root"></div>' },
  { path: 'src/main.tsx', content: 'console.log("Build")' },
]

async function modules() {
  try {
    const projects = await import('../projects')
    const templates = await import('../templates')
    return { ...projects, starterFiles: templates.starterFiles }
  } catch {
    return {
      starterFiles: fallbackStarterFiles,
      formatUpdatedAt: value => value,
      listProjects: async () => fallbackProjects,
      getCurrentProjectId: async () => globalThis.localStorage?.getItem('current-project-id') ?? null,
      setCurrentProjectId: async id => id ? globalThis.localStorage?.setItem('current-project-id', id) : globalThis.localStorage?.removeItem('current-project-id'),
      getProject: async id => fallbackProjects.find(project => project.id === id),
      createProject: async payload => {
        const project = { id: crypto.randomUUID?.() ?? String(Date.now()), updatedAt: new Date().toISOString(), ...payload }
        fallbackProjects = [project, ...fallbackProjects]
        return project
      },
      saveProject: async project => {
        fallbackProjects = fallbackProjects.map(p => p.id === project.id ? project : p)
        return project
      },
      deleteProject: async id => { fallbackProjects = fallbackProjects.filter(p => p.id !== id) },
    }
  }
}

export async function loadInitialProject() {
  const m = await modules()
  try {
    const projects = await m.listProjects()
    dispatchProjectListRefreshed(projects)
    const id = await m.getCurrentProjectId()
    const project = id ? await m.getProject(id) : undefined
    if (project) {
      dispatchProjectLoaded({ ...project, files: project.files.length ? project.files : m.starterFiles, selectedPath: project.selectedPath || m.starterFiles[2].path })
      dispatchChatMessagesReplaced(project.messages)
    }
  } catch (error) {
    dispatchWebContainerLog(error instanceof Error ? error.message : String(error))
  } finally {
    dispatchProjectReady()
  }
}

function gleamListToArray(list) { return typeof list?.toArray === 'function' ? list.toArray() : [] }
function normalizeFiles(files) { return gleamListToArray(files).map(file => ({ path: file.path, content: file.content })) }
function normalizeMessages(messages) { return gleamListToArray(messages).map(message => ({ role: message.role.constructor.name === 'User' ? 'user' : 'assistant', content: message.content })) }
function normalizeBuildLog(buildLog) {
  return gleamListToArray(buildLog).map(entry => ({
    at: entry.at,
    prompt: entry.prompt,
    reply: entry.reply,
    paths: gleamListToArray(entry.paths),
  }))
}

export async function saveCurrentProject(name, filesArg, messagesArg, buildLogArg, selectedPath, currentProjectId, silent) {
  const m = await modules()
  lastSavePayload = { name, filesArg, messagesArg, buildLogArg, selectedPath, currentProjectId, silent }
  const cleanName = String(name || '').trim() || 'Untitled Project'
  const files = normalizeFiles(filesArg)
  const messages = normalizeMessages(messagesArg)
  const buildLog = normalizeBuildLog(buildLogArg)
  const now = new Date().toISOString()
  const existing = currentProjectId ? await m.getProject(currentProjectId) : undefined
  const project = existing
    ? { ...existing, name: cleanName, files, messages, buildLog, selectedPath, updatedAt: now }
    : await m.createProject({ name: cleanName, files, messages, buildLog, selectedPath })
  const saved = existing ? await m.saveProject(project) : project
  await dispatchProjectLoaded(saved)
  await dispatchProjectSaveStatus(silent ? `Auto-saved ${m.formatUpdatedAt(saved.updatedAt)}` : 'Saved just now')
  await m.setCurrentProjectId(saved.id)
  await dispatchProjectListRefreshed(await m.listProjects())
}

export async function createProject(name, filesArg, messagesArg, selectedPath) {
  const m = await modules()
  const files = normalizeFiles(filesArg)
  const messages = normalizeMessages(messagesArg)
  const created = await m.createProject({ name, files: files.length ? files : m.starterFiles, messages, selectedPath: selectedPath || m.starterFiles[2].path })
  await m.setCurrentProjectId(created.id)
  dispatchProjectCreated(created)
  dispatchChatCleared()
  dispatchWebContainerRemountRequested(created.files)
  dispatchProjectListRefreshed(await m.listProjects())
}

export async function openProject(id) {
  const m = await modules()
  const project = await m.getProject(id)
  if (!project) return
  await m.setCurrentProjectId(project.id)
  dispatchProjectLoaded({ ...project, selectedPath: project.selectedPath || project.files[0]?.path || m.starterFiles[2].path })
  dispatchChatMessagesReplaced(project.messages)
  dispatchProjectsDialogClosed()
  dispatchWebContainerRemountRequested(project.files)
}

export async function deleteProject(id) {
  const m = await modules()
  await m.deleteProject(id)
  dispatchProjectListRefreshed(await m.listProjects())
}

export async function refreshProjectList() {
  const m = await modules()
  dispatchProjectListRefreshed(await m.listProjects())
}

export async function persistCurrentProjectId(id) {
  const m = await modules()
  await m.setCurrentProjectId(id || null)
}

export function scheduleSave(delay, name, filesArg, messagesArg, buildLogArg, selectedPath, currentProjectId) {
  lastSavePayload = { name, filesArg, messagesArg, buildLogArg, selectedPath, currentProjectId, silent: true }
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (lastSavePayload) void saveCurrentProject(lastSavePayload.name, lastSavePayload.filesArg, lastSavePayload.messagesArg, lastSavePayload.buildLogArg, lastSavePayload.selectedPath, lastSavePayload.currentProjectId, true)
  }, delay)
}
