const DB_NAME = 'build-db'
const DB_VERSION = 1
const ENV_STORE = 'env-store'

let dbPromise: Promise<IDBDatabase> | undefined

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(ENV_STORE)) {
        db.createObjectStore(ENV_STORE, { keyPath: 'projectId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('Failed to open env store'))
  })
  return dbPromise
}

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
