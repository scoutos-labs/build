import type { ChatMessage } from './agent'
import type { ProjectFile } from './templates'

export type BuildLogEntry = {
  at: number
  prompt: string
  reply: string
  paths: string[]
}

export type SavedProject = {
  id: string
  name: string
  files: ProjectFile[]
  messages: ChatMessage[]
  selectedPath: string
  createdAt: string
  updatedAt: string
  /** One entry per successful agent turn; absent on projects saved before
   * the Build Story feature. Prompts/replies are stored truncated. */
  buildLog?: BuildLogEntry[]
}

const DB_NAME = 'build-db'
const DB_VERSION = 1
const PROJECTS_STORE = 'projects'
const META_STORE = 'meta'
const CURRENT_PROJECT_ID_KEY = 'current-project-id'

type MetaRecord = { key: string; value: string | null }

let dbPromise: Promise<IDBDatabase> | undefined

export function openBuildDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PROJECTS_STORE)) db.createObjectStore(PROJECTS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' })
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'))
  })
  return dbPromise
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

export async function listProjects(): Promise<SavedProject[]> {
  const db = await openBuildDb()
  const transaction = db.transaction(PROJECTS_STORE, 'readonly')
  const projects = await requestToPromise<SavedProject[]>(transaction.objectStore(PROJECTS_STORE).getAll())
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getProject(id: string): Promise<SavedProject | undefined> {
  const db = await openBuildDb()
  const transaction = db.transaction(PROJECTS_STORE, 'readonly')
  return requestToPromise<SavedProject | undefined>(transaction.objectStore(PROJECTS_STORE).get(id))
}

export async function saveProject(project: SavedProject): Promise<SavedProject> {
  const db = await openBuildDb()
  const transaction = db.transaction(PROJECTS_STORE, 'readwrite')
  transaction.objectStore(PROJECTS_STORE).put(project)
  await transactionDone(transaction)
  return project
}

export async function createProject(args: Partial<Pick<SavedProject, 'name' | 'files' | 'messages' | 'selectedPath'>> = {}): Promise<SavedProject> {
  const now = new Date().toISOString()
  const project: SavedProject = {
    id: crypto.randomUUID(),
    name: args.name?.trim() || 'Untitled Project',
    files: args.files ?? [],
    messages: args.messages ?? [],
    selectedPath: args.selectedPath ?? '',
    createdAt: now,
    updatedAt: now,
  }
  return saveProject(project)
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openBuildDb()
  const transaction = db.transaction(PROJECTS_STORE, 'readwrite')
  transaction.objectStore(PROJECTS_STORE).delete(id)
  await transactionDone(transaction)
}

export async function getCurrentProjectId(): Promise<string | null> {
  const db = await openBuildDb()
  const transaction = db.transaction(META_STORE, 'readonly')
  const record = await requestToPromise<MetaRecord | undefined>(transaction.objectStore(META_STORE).get(CURRENT_PROJECT_ID_KEY))
  return record?.value ?? null
}

export async function setCurrentProjectId(id: string | null): Promise<void> {
  const db = await openBuildDb()
  const transaction = db.transaction(META_STORE, 'readwrite')
  const store = transaction.objectStore(META_STORE)
  if (id) store.put({ key: CURRENT_PROJECT_ID_KEY, value: id } satisfies MetaRecord)
  else store.delete(CURRENT_PROJECT_ID_KEY)
  await transactionDone(transaction)
}

export function formatUpdatedAt(value: string): string {
  const date = new Date(value)
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (deltaSeconds < 60) return 'just now'
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`
  if (deltaSeconds < 86400) return `${Math.floor(deltaSeconds / 3600)}h ago`
  return date.toLocaleDateString()
}
