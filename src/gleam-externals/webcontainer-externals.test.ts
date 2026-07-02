// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// Pins the install-skip optimization and preview reload debounce in
// webcontainer.mjs: which paths arm/disarm lastInstalledPackageJson, and
// when the explicit iframe reload is suppressed.

const h = vi.hoisted(() => ({
  mountProject: vi.fn(async (_files: unknown) => {}),
  runInstall: vi.fn(async (_onLog: (line: string) => void): Promise<number | undefined> => 0),
  readProjectFile: vi.fn(async (_path: string): Promise<string | undefined> => undefined),
  logs: [] as string[],
}))

vi.mock('./runtime_bridge.mjs', () => ({
  dispatchPreviewUrlChanged: vi.fn(),
  dispatchProjectFilesUpdated: vi.fn(),
  dispatchProjectSaveStatus: vi.fn(),
  dispatchWebContainerBootFailed: vi.fn(),
  dispatchWebContainerBootStarted: vi.fn(),
  dispatchWebContainerBootSucceeded: vi.fn(),
  dispatchWebContainerInstalling: vi.fn(),
  dispatchWebContainerStartingDevServer: vi.fn(),
  dispatchWebContainerLog: vi.fn((line: string) => h.logs.push(line)),
  dispatchWebContainerRemountFinished: vi.fn(),
}))

vi.mock('../webcontainer', () => ({
  mountProject: (files: unknown) => h.mountProject(files),
  runInstall: (onLog: (line: string) => void) => h.runInstall(onLog),
  startDevServer: vi.fn(async (_onLog: unknown, onUrl: (url: string) => void) => onUrl('http://preview.local')),
  readProjectFilesFromWebContainer: vi.fn(async () => []),
  writeProjectFile: vi.fn(async () => {}),
  readProjectFile: (path: string) => h.readProjectFile(path),
  startShell: vi.fn(),
}))

vi.mock('../templates', () => ({
  starterFiles: [{ path: 'package.json', content: '{"starter":true}' }],
}))

const PKG_A = '{"dependencies":{"react":"1"}}'
const PKG_B = '{"dependencies":{"react":"2"}}'
const project = (pkg: string) => [
  { path: 'package.json', content: pkg },
  { path: 'src/main.tsx', content: 'export {}' },
]

type WebContainerExternals = {
  bootContainer: (files: unknown) => Promise<void>
  mountAndInstall: (files?: unknown) => Promise<void>
  runNpmInstall: () => Promise<void>
}

async function loadModule(): Promise<WebContainerExternals> {
  // the ambient '*.mjs' declaration in vite-env.d.ts only models main.mjs
  return await import('./webcontainer.mjs') as unknown as WebContainerExternals
}

describe('webcontainer externals install-skip', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    h.logs.length = 0
    h.mountProject.mockImplementation(async () => {})
    h.runInstall.mockResolvedValue(0)
    h.readProjectFile.mockResolvedValue(undefined)
    document.body.innerHTML = ''
  })

  it('skips reinstall on remount when package.json is unchanged', async () => {
    const wc = await loadModule()
    await wc.bootContainer(project(PKG_A))
    expect(h.runInstall).toHaveBeenCalledTimes(1)

    await wc.mountAndInstall(project(PKG_A))
    expect(h.runInstall).toHaveBeenCalledTimes(1)
    expect(h.logs).toContain('Dependencies unchanged — skipping install.')
  })

  it('reinstalls on remount when package.json changed', async () => {
    const wc = await loadModule()
    await wc.bootContainer(project(PKG_A))
    await wc.mountAndInstall(project(PKG_B))
    expect(h.runInstall).toHaveBeenCalledTimes(2)
  })

  it('does not arm the skip when the boot install fails', async () => {
    const wc = await loadModule()
    h.runInstall.mockResolvedValueOnce(1)
    await wc.bootContainer(project(PKG_A))

    await wc.mountAndInstall(project(PKG_A))
    // boot install failed, so the remount must retry rather than skip
    expect(h.runInstall).toHaveBeenCalledTimes(2)
  })

  it('disarms the skip when a remount install fails, then retries', async () => {
    const wc = await loadModule()
    await wc.bootContainer(project(PKG_A))
    h.runInstall.mockResolvedValueOnce(1)
    await wc.mountAndInstall(project(PKG_B))
    expect(h.logs).toContain('npm install failed — will retry on next project switch.')

    await wc.mountAndInstall(project(PKG_B))
    expect(h.runInstall).toHaveBeenCalledTimes(3)
  })

  it('runNpmInstall records the container package.json so the next remount can skip', async () => {
    const wc = await loadModule()
    // agent patches write package.json into the container without updating
    // the last-mounted snapshot, so the marker must come from the container
    h.readProjectFile.mockResolvedValue(PKG_B)
    await wc.runNpmInstall()
    expect(h.runInstall).toHaveBeenCalledTimes(1)

    await wc.mountAndInstall(project(PKG_B))
    expect(h.runInstall).toHaveBeenCalledTimes(1)
  })

  it('runNpmInstall does not arm the skip when the install fails', async () => {
    const wc = await loadModule()
    h.runInstall.mockResolvedValueOnce(1)
    h.readProjectFile.mockResolvedValue(PKG_B)
    await wc.runNpmInstall()

    await wc.mountAndInstall(project(PKG_B))
    expect(h.runInstall).toHaveBeenCalledTimes(2)
  })

  it('serializes overlapping remounts so installs cannot race', async () => {
    const wc = await loadModule()
    const events: string[] = []
    h.mountProject.mockImplementation(async (files: unknown) => {
      const pkg = (files as { path: string; content: string }[]).find(f => f.path === 'package.json')?.content
      events.push(`start ${pkg}`)
      await new Promise(resolve => setTimeout(resolve, 10))
      events.push(`end ${pkg}`)
    })

    await Promise.all([wc.mountAndInstall(project(PKG_A)), wc.mountAndInstall(project(PKG_B))])
    expect(events).toEqual([`start ${PKG_A}`, `end ${PKG_A}`, `start ${PKG_B}`, `end ${PKG_B}`])
  })
})

describe('webcontainer externals boot gate', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    h.logs.length = 0
    h.mountProject.mockImplementation(async () => {})
    h.runInstall.mockResolvedValue(0)
    h.readProjectFile.mockResolvedValue(undefined)
  })

  it('writes issued mid-boot land only after the boot mount', async () => {
    // chat works before the container is ready, so an agent patch can arrive
    // while bootContainer is still mounting its files snapshot — the write
    // must wait or the mount silently overwrites it
    const wc = await loadModule()
    const events: string[] = []
    let finishMount: () => void = () => {}
    h.mountProject.mockImplementation(async () => {
      events.push('mount')
      await new Promise<void>(resolve => { finishMount = resolve })
    })

    const boot = wc.bootContainer(project(PKG_A))
    await vi.waitFor(() => expect(events).toContain('mount'))

    const write = (wc as unknown as { writeFileToContainer: (p: string, c: string) => Promise<void> })
      .writeFileToContainer('src/main.tsx', 'patched')
      .then(() => events.push('write'))
    // give the write every chance to run early — it must not
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(events).toEqual(['mount'])

    finishMount()
    await boot
    await write
    expect(events).toEqual(['mount', 'write'])
  })

  it('writes proceed immediately when no boot is in flight', async () => {
    const wc = await loadModule()
    await (wc as unknown as { writeFileToContainer: (p: string, c: string) => Promise<void> })
      .writeFileToContainer('src/main.tsx', 'content')
    // no hang and the underlying write happened — the gate starts resolved
  })
})

describe('webcontainer externals preview reload debounce', () => {
  let srcSets: number

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    h.logs.length = 0
    h.mountProject.mockImplementation(async () => {})
    h.runInstall.mockResolvedValue(0)
    vi.useFakeTimers()

    document.body.innerHTML = '<iframe title="preview"></iframe>'
    const iframe = document.querySelector('iframe[title="preview"]') as HTMLIFrameElement
    srcSets = 0
    let srcValue = 'http://preview.local/'
    Object.defineProperty(iframe, 'src', {
      get: () => srcValue,
      set: value => { srcSets++; srcValue = value },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hard-reloads the preview when vite does not reload after a remount', async () => {
    const wc = await loadModule()
    await wc.mountAndInstall(project(PKG_A))

    await vi.advanceTimersByTimeAsync(600)
    expect(srcSets).toBe(1)
  })

  it('suppresses the hard reload when the iframe loaded after the mount started', async () => {
    const wc = await loadModule()
    await wc.mountAndInstall(project(PKG_A))

    await vi.advanceTimersByTimeAsync(100)
    document.querySelector('iframe[title="preview"]')!.dispatchEvent(new Event('load'))
    await vi.advanceTimersByTimeAsync(600)
    expect(srcSets).toBe(0)
  })

  it('does not suppress based on loads from before the mount started', async () => {
    const wc = await loadModule()
    // first remount attaches the load watcher and completes
    await wc.mountAndInstall(project(PKG_A))
    document.querySelector('iframe[title="preview"]')!.dispatchEvent(new Event('load'))
    await vi.advanceTimersByTimeAsync(600)
    const setsAfterFirst = srcSets

    // a later remount must not treat that old load as "vite already reloaded"
    await vi.advanceTimersByTimeAsync(2000)
    await wc.mountAndInstall(project(PKG_A))
    await vi.advanceTimersByTimeAsync(600)
    expect(srcSets).toBe(setsAfterFirst + 1)
  })
})
