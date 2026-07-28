/**
 * The workspace: files that belong to the *user*, not to their app.
 *
 * Skills, agent personas, and workflows all live here rather than in
 * `project.files`, and the reason is structural. Anything in `project.files` is:
 *
 *   1. sent as prompt context every turn (eating the context budget),
 *   2. **published to scoutos.live** — `/api/publish` receives
 *      `app.project.files` and `publish-files.ts` only ever *adds*,
 *   3. exported in the ZIP,
 *   4. mounted into the WebContainer, where the running app can read it.
 *
 * All four are wrong for a skill or a persona. `BRAIN.md` is the cautionary
 * precedent — it already pays (1) and (2) today.
 *
 * The agent reaches these through a **virtual namespace**: any `fs_*` path
 * beginning `.build/` resolves here instead of the project. That means no new
 * tools, progressive disclosure for free (the model `fs_read`s a skill body only
 * when it wants one), and structural exclusion from publish, ZIP, and context.
 *
 * Scoping: `__global` for account-level things that should survive project
 * switches; a project id for project-scoped ones. Skills are global — a skill
 * you taught Build once should not evaporate when you start a new app.
 */

/** Everything under this prefix lives in the workspace, never in project.files. */
export const WORKSPACE_PREFIX = '.build/'

export const GLOBAL_SCOPE = '__global'

export type WorkspaceFile = {
  /** `${scope}:${path}` — the store's key path. */
  id: string
  scope: string
  path: string
  content: string
  updatedAt: string
}

import { WORKSPACE_STORE, openBuildDb } from './projects'

/**
 * The store is created by `openBuildDb` in `src/projects.ts`, which owns the
 * `build-db` schema and its version. Opening the same database at a second
 * version from here would throw on whichever handle opened second.
 */
export const openWorkspaceDb = openBuildDb

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

export function isWorkspacePath(path: string): boolean {
  return path.startsWith(WORKSPACE_PREFIX)
}

function keyFor(scope: string, path: string): string {
  return `${scope}:${path}`
}

export async function readWorkspaceFile(
  path: string,
  scope = GLOBAL_SCOPE,
): Promise<string | undefined> {
  const db = await openWorkspaceDb()
  const store = db.transaction(WORKSPACE_STORE, 'readonly').objectStore(WORKSPACE_STORE)
  const record = await promisify<WorkspaceFile | undefined>(store.get(keyFor(scope, path)))
  return record?.content
}

export async function writeWorkspaceFile(
  path: string,
  content: string,
  scope = GLOBAL_SCOPE,
): Promise<void> {
  const db = await openWorkspaceDb()
  const store = db.transaction(WORKSPACE_STORE, 'readwrite').objectStore(WORKSPACE_STORE)
  await promisify(
    store.put({ id: keyFor(scope, path), scope, path, content, updatedAt: new Date().toISOString() }),
  )
}

export async function deleteWorkspaceFile(path: string, scope = GLOBAL_SCOPE): Promise<void> {
  const db = await openWorkspaceDb()
  const store = db.transaction(WORKSPACE_STORE, 'readwrite').objectStore(WORKSPACE_STORE)
  await promisify(store.delete(keyFor(scope, path)))
}

export async function listWorkspaceFiles(
  prefix = '',
  scope = GLOBAL_SCOPE,
): Promise<{ path: string; bytes: number }[]> {
  const db = await openWorkspaceDb()
  const store = db.transaction(WORKSPACE_STORE, 'readonly').objectStore(WORKSPACE_STORE)
  const all = await promisify<WorkspaceFile[]>(store.getAll())
  return all
    .filter(file => file.scope === scope && file.path.startsWith(prefix))
    .map(file => ({ path: file.path, bytes: file.content.length }))
    .sort((a, b) => a.path.localeCompare(b.path))
}
