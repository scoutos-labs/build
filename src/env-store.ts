import { ENV_STORE, openBuildDb } from './projects'

/**
 * The store is created by `openBuildDb` in `src/projects.ts`, which owns the
 * `build-db` schema and its version. Opening the same database at a second
 * version from here would throw on whichever handle opened second — which is
 * exactly what this module used to do.
 */
const openDb = openBuildDb

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('IndexedDB request failed'))
  })
}

export type EnvVars = Record<string, string>

export async function getEnvVars(projectId: string): Promise<EnvVars> {
  const db = await openDb()
  const record = await requestToPromise<{ projectId: string; vars: EnvVars } | undefined>(
    db.transaction(ENV_STORE, 'readonly').objectStore(ENV_STORE).get(projectId),
  )
  return record?.vars ?? {}
}

export async function setEnvVars(projectId: string, vars: EnvVars): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ENV_STORE, 'readwrite')
    tx.objectStore(ENV_STORE).put({ projectId, vars })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(new Error('Failed to save env vars'))
  })
}

export async function upsertEnvVar(projectId: string, key: string, value: string): Promise<void> {
  const vars = await getEnvVars(projectId)
  vars[key] = value
  await setEnvVars(projectId, vars)
}

export async function deleteEnvVar(projectId: string, key: string): Promise<void> {
  const vars = await getEnvVars(projectId)
  delete vars[key]
  await setEnvVars(projectId, vars)
}

/** Serialize env vars to a .env file string. */
export function envToDotEnv(vars: EnvVars): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(vars)) {
    if (value === '') {
      lines.push(`${key}=`)
    } else {
      // Escape quotes, newlines, and dollar signs to keep .env valid
      const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/\n/g, '\\n')
      lines.push(`${key}="${escaped}"`)
    }
  }
  return lines.join('\n')
}
