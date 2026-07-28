import { clearToolLog } from './agent.mjs'
import { dispatchChatCleared, dispatchChatMessagesReplaced, dispatchLandingIdea, dispatchProjectCreated, dispatchProjectListRefreshed, dispatchProjectLoaded, dispatchProjectReady, dispatchProjectsDialogClosed, dispatchProjectSaveStatus, dispatchWebContainerLog, dispatchWebContainerRemountRequested } from './runtime_bridge.mjs'

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
    return { ...projects, starterFiles: templates.starterFiles, ensureVerifiable: templates.ensureVerifiable }
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

/**
 * The file the editor opens on for a project that has no saved selection.
 *
 * This was `starterFiles[2].path` in three places — "the third starter file",
 * which meant src/main.tsx only by accident of ordering. Adding tsconfig.json
 * ahead of it silently retargeted all three to index.html. Name what you mean.
 */
function defaultSelectedPath(m) {
  return m.starterFiles.find(file => file.path === 'src/main.tsx')?.path ?? m.starterFiles[0].path
}

export async function loadInitialProject() {
  const m = await modules()
  try {
    const projects = await m.listProjects()
    dispatchProjectListRefreshed(projects)
    const id = await m.getCurrentProjectId()
    const project = id ? await m.getProject(id) : undefined
    if (project) {
      const files = project.files.length ? m.ensureVerifiable(project.files) : m.starterFiles
      dispatchProjectLoaded({ ...project, files, selectedPath: project.selectedPath || defaultSelectedPath(m) })
      dispatchChatMessagesReplaced(project.messages)
    }
  } catch (error) {
    dispatchWebContainerLog(error instanceof Error ? error.message : String(error))
  } finally {
    dispatchProjectReady()
    // One-shot landing seed (key written by src/landing.ts pre-auth):
    // consumed strictly after ProjectReady, so interview eligibility has
    // already been decided when the idea arrives. Same key both sides.
    try {
      const idea = globalThis.sessionStorage?.getItem('build.landing-prompt') ?? ''
      globalThis.sessionStorage?.removeItem('build.landing-prompt')
      if (idea.trim()) dispatchLandingIdea(idea)
    } catch { /* storage unavailable (tests, privacy modes) — no seed */ }
  }
}

function gleamListToArray(list) { return typeof list?.toArray === 'function' ? list.toArray() : [] }
function normalizeFiles(files) { return gleamListToArray(files).map(file => ({ path: file.path, content: file.content })) }
function normalizeMessages(messages) { return gleamListToArray(messages).map(message => ({ role: message.role.constructor.name === 'User' ? 'user' : 'assistant', content: message.content, paths: gleamListToArray(message.paths) })) }
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
  const created = await m.createProject({ name, files: files.length ? files : m.starterFiles, messages, selectedPath: selectedPath || defaultSelectedPath(m) })
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
  // A failed command from the project being left has no business being readable
  // in the one being opened.
  clearToolLog()
  const files = m.ensureVerifiable(project.files)
  dispatchProjectLoaded({ ...project, files, selectedPath: project.selectedPath || files[0]?.path || defaultSelectedPath(m) })
  dispatchChatMessagesReplaced(project.messages)
  dispatchProjectsDialogClosed()
  dispatchWebContainerRemountRequested(files)
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

/**
 * Publish the current file set for the agent's tool executors.
 *
 * `project.files` is the source of truth; the WebContainer FS is a replica that
 * `isSyncableTextFile` silently filters. So `fs_read` and `fs_list` must read
 * this snapshot rather than the disk, or the agent reasons about a file set the
 * app does not have. Sourced from Gleam on every save path, which is every path
 * that can change a file.
 */
export function publishProjectFiles(files) {
  globalThis.__buildProjectFiles = normalizeFiles(files)
}

/** Publish an already-plain `[{path, content}]` list (JS-side callers). */
export function publishProjectFileList(files) {
  globalThis.__buildProjectFiles = (files ?? []).map(file => ({
    path: file.path,
    content: file.content,
  }))
}

/** Drop one file from the snapshot. */
export function unpublishProjectFile(path) {
  globalThis.__buildProjectFiles = (globalThis.__buildProjectFiles ?? []).filter(
    file => file.path !== path,
  )
}

/** Upsert one file into the snapshot. Fires on every applied write, so the
 * snapshot never depends on an autosave having happened. */
export function publishProjectFile(path, content) {
  const current = globalThis.__buildProjectFiles ?? []
  const index = current.findIndex(file => file.path === path)
  globalThis.__buildProjectFiles =
    index === -1
      ? [...current, { path, content }]
      : current.map((file, i) => (i === index ? { path, content } : file))
}

export function scheduleSave(delay, name, filesArg, messagesArg, buildLogArg, selectedPath, currentProjectId) {
  lastSavePayload = { name, filesArg, messagesArg, buildLogArg, selectedPath, currentProjectId, silent: true }
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (lastSavePayload) void saveCurrentProject(lastSavePayload.name, lastSavePayload.filesArg, lastSavePayload.messagesArg, lastSavePayload.buildLogArg, lastSavePayload.selectedPath, lastSavePayload.currentProjectId, true)
  }, delay)
}
