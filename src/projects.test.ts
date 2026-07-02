import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function freshProjectsModule() {
  vi.resetModules()
  return import('./projects')
}

describe('IndexedDB project storage', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `project-${Date.now()}-${Math.random()}`) })
  })

  it('creates projects with defaults', async () => {
    const { createProject } = await freshProjectsModule()
    const project = await createProject()

    expect(project.name).toBe('Untitled Project')
    expect(project.files).toEqual([])
    expect(project.messages).toEqual([])
    expect(project.id).toBeTruthy()
    expect(project.createdAt).toBeTruthy()
    expect(project.updatedAt).toBeTruthy()
  })

  it('saves and retrieves a project', async () => {
    const { createProject, getProject, saveProject } = await freshProjectsModule()
    const project = await createProject({ name: 'CRM', files: [{ path: 'src/main.tsx', content: 'hello' }], selectedPath: 'src/main.tsx' })
    await saveProject({ ...project, name: 'CRM v2', messages: [{ role: 'user', content: 'hi' }] })

    await expect(getProject(project.id)).resolves.toMatchObject({
      id: project.id,
      name: 'CRM v2',
      selectedPath: 'src/main.tsx',
      files: [{ path: 'src/main.tsx', content: 'hello' }],
      messages: [{ role: 'user', content: 'hi' }],
    })
  })

  it('lists projects by updated date descending', async () => {
    const { createProject, listProjects, saveProject } = await freshProjectsModule()
    const older = await createProject({ name: 'Older' })
    const newer = await createProject({ name: 'Newer' })
    await saveProject({ ...older, updatedAt: '2024-01-01T00:00:00.000Z' })
    await saveProject({ ...newer, updatedAt: '2025-01-01T00:00:00.000Z' })

    await expect(listProjects()).resolves.toMatchObject([{ name: 'Newer' }, { name: 'Older' }])
  })

  it('deletes projects', async () => {
    const { createProject, deleteProject, getProject } = await freshProjectsModule()
    const project = await createProject({ name: 'Delete me' })
    await deleteProject(project.id)

    await expect(getProject(project.id)).resolves.toBeUndefined()
  })

  it('gets, sets, and clears current project id', async () => {
    const { getCurrentProjectId, setCurrentProjectId } = await freshProjectsModule()

    await expect(getCurrentProjectId()).resolves.toBeNull()
    await setCurrentProjectId('project-1')
    await expect(getCurrentProjectId()).resolves.toBe('project-1')
    await setCurrentProjectId(null)
    await expect(getCurrentProjectId()).resolves.toBeNull()
  })

  it('round-trips the buildLog and tolerates projects saved without one', async () => {
    const { createProject, getProject, saveProject } = await freshProjectsModule()

    const legacy = await createProject({ name: 'Legacy' })
    const project = await createProject({ name: 'Storied' })
    const buildLog = [
      { at: 1720000000000, prompt: 'make a todo app', reply: 'Done', paths: ['src/main.tsx'] },
      { at: 1720000100000, prompt: 'make it blue', reply: 'Styled', paths: ['src/style.css'] },
    ]
    await saveProject({ ...project, buildLog })

    const loaded = await getProject(project.id)
    expect(loaded?.buildLog).toEqual(buildLog)
    // projects saved before the Build Story feature simply have no buildLog
    const legacyLoaded = await getProject(legacy.id)
    expect(legacyLoaded?.buildLog).toBeUndefined()
  })

  it('returns undefined for missing projects', async () => {
    const { getProject } = await freshProjectsModule()
    await expect(getProject('missing')).resolves.toBeUndefined()
  })
})
