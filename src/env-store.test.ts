import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { envToDotEnv } from './env-store'

/**
 * These run against real IndexedDB semantics (fake-indexeddb), not a stub.
 * The previous version of this file replaced `indexedDB` with a hand-rolled
 * object whose `open()` ignored the version argument entirely — so it could
 * not have caught `env-store` opening `build-db` at version 1 while
 * `projects.ts` owned it at 2, which is precisely the bug that shipped.
 */

// Both modules memoize their connection, so each test needs a fresh registry.
async function freshModules() {
  vi.resetModules()
  const projects = await import('./projects')
  const envStore = await import('./env-store')
  return { ...projects, ...envStore }
}

describe('env-store persistence', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `project-${Math.random()}`) })
  })

  it('round-trips env vars through the shared database', async () => {
    const { setEnvVars, getEnvVars } = await freshModules()
    await setEnvVars('proj-1', { API_KEY: 'abc', PORT: '3000' })
    expect(await getEnvVars('proj-1')).toEqual({ API_KEY: 'abc', PORT: '3000' })
  })

  it('returns an empty map for a project with nothing stored', async () => {
    const { getEnvVars } = await freshModules()
    expect(await getEnvVars('never-seen')).toEqual({})
  })

  it('upserts and deletes individual keys', async () => {
    const { setEnvVars, upsertEnvVar, deleteEnvVar, getEnvVars } = await freshModules()
    await setEnvVars('proj-1', { A: '1' })
    await upsertEnvVar('proj-1', 'B', '2')
    expect(await getEnvVars('proj-1')).toEqual({ A: '1', B: '2' })
    await deleteEnvVar('proj-1', 'A')
    expect(await getEnvVars('proj-1')).toEqual({ B: '2' })
  })

  it('keeps env vars separated per project', async () => {
    const { setEnvVars, getEnvVars } = await freshModules()
    await setEnvVars('proj-1', { SHARED: 'one' })
    await setEnvVars('proj-2', { SHARED: 'two' })
    expect(await getEnvVars('proj-1')).toEqual({ SHARED: 'one' })
    expect(await getEnvVars('proj-2')).toEqual({ SHARED: 'two' })
  })
})

describe('build-db has a single schema owner', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `project-${Math.random()}`) })
  })

  // The regression: projects.ts upgrading first used to leave env-store's own
  // open() requesting a lower version, which throws VersionError.
  it('works when projects.ts opens the database first', async () => {
    const { createProject, setEnvVars, getEnvVars } = await freshModules()
    const project = await createProject()
    await setEnvVars(project.id, { TOKEN: 'xyz' })
    expect(await getEnvVars(project.id)).toEqual({ TOKEN: 'xyz' })
  })

  it('works when env-store touches the database first', async () => {
    const { setEnvVars, getEnvVars, createProject, listProjects } = await freshModules()
    await setEnvVars('proj-1', { TOKEN: 'xyz' })
    const project = await createProject()
    expect(await getEnvVars('proj-1')).toEqual({ TOKEN: 'xyz' })
    expect((await listProjects()).map(p => p.id)).toContain(project.id)
  })

  it('opens every store at one version', async () => {
    const { openBuildDb } = await freshModules()
    const db = await openBuildDb()
    expect(db.version).toBe(3)
    expect([...db.objectStoreNames].sort()).toEqual(['env-store', 'meta', 'projects', 'workspace'])
  })
})

describe('upgrading an existing database', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `project-${Math.random()}`) })
  })

  /** Seed the shape a real v2 user has on disk today, with data in it. */
  async function seedV2WithData() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('build-db', 2)
      request.onupgradeneeded = () => {
        const d = request.result
        d.createObjectStore('projects', { keyPath: 'id' })
        d.createObjectStore('meta', { keyPath: 'key' })
        d.createObjectStore('workspace', { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['projects', 'meta'], 'readwrite')
      tx.objectStore('projects').put({ id: 'kept-1', name: 'Important Work', files: [], messages: [] })
      tx.objectStore('meta').put({ key: 'current-project-id', value: 'kept-1' })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    // Leave no connection open, or the version bump would block.
    db.close()
  }

  it('upgrades v2 to v3 without losing existing projects', async () => {
    await seedV2WithData()
    const { openBuildDb, listProjects, getCurrentProjectId } = await freshModules()

    const db = await openBuildDb()
    expect(db.version).toBe(3)
    expect([...db.objectStoreNames]).toContain('env-store')

    const projects = await listProjects()
    expect(projects.map(p => p.id)).toEqual(['kept-1'])
    expect(projects[0].name).toBe('Important Work')
    expect(await getCurrentProjectId()).toBe('kept-1')
  })

  it('makes the new env-store usable on an upgraded database', async () => {
    await seedV2WithData()
    const { setEnvVars, getEnvVars } = await freshModules()
    await setEnvVars('kept-1', { AFTER_UPGRADE: 'yes' })
    expect(await getEnvVars('kept-1')).toEqual({ AFTER_UPGRADE: 'yes' })
  })

  /**
   * The oldest shape still in the wild: created before the `workspace` store
   * existed. It has to gain two stores in one upgrade, not one.
   */
  it('upgrades a v1 {meta, projects} database straight to v3', async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('build-db', 1)
      request.onupgradeneeded = () => {
        const d = request.result
        d.createObjectStore('projects', { keyPath: 'id' })
        d.createObjectStore('meta', { keyPath: 'key' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('projects', 'readwrite')
      tx.objectStore('projects').put({ id: 'ancient-1', name: 'From v1', files: [], messages: [] })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()

    const { openBuildDb, listProjects, setEnvVars, getEnvVars } = await freshModules()
    const upgraded = await openBuildDb()
    expect(upgraded.version).toBe(3)
    expect([...upgraded.objectStoreNames].sort()).toEqual(['env-store', 'meta', 'projects', 'workspace'])
    expect((await listProjects()).map(p => p.name)).toEqual(['From v1'])

    await setEnvVars('ancient-1', { OK: '1' })
    expect(await getEnvVars('ancient-1')).toEqual({ OK: '1' })
  })

  /** An env-store-first v1 database: the store the old code would have made. */
  it('upgrades a v1 database that only has env-store', async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('build-db', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('env-store', { keyPath: 'projectId' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()

    const { openBuildDb, createProject, listProjects } = await freshModules()
    const upgraded = await openBuildDb()
    expect(upgraded.version).toBe(3)
    expect([...upgraded.objectStoreNames].sort()).toEqual(['env-store', 'meta', 'projects', 'workspace'])

    const project = await createProject()
    expect((await listProjects()).map(p => p.id)).toContain(project.id)
  })
})

describe('envToDotEnv', () => {
  it('serializes env vars to .env format correctly', () => {
    expect(envToDotEnv({ API_KEY: 'secret123', PORT: '3000', EMPTY: '' }))
      .toEqual('API_KEY="secret123"\nPORT="3000"\nEMPTY=')
  })

  it('escapes special characters in values', () => {
    expect(envToDotEnv({ URL: 'https://example.com?key=$val' }))
      .toContain('$val') // dollar sign should be escaped
  })

  it('handles empty env vars', () => {
    expect(envToDotEnv({})).toBe('')
  })
})
