import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockMount = vi.fn()
const mockMkdir = vi.fn()
const mockWriteFile = vi.fn()
const mockReadFile = vi.fn()
const mockReaddir = vi.fn()
const mockSpawn = vi.fn()
const mockOn = vi.fn()

vi.mock('@webcontainer/api', () => ({
  WebContainer: {
    boot: vi.fn(async () => ({
      mount: mockMount,
      fs: { mkdir: mockMkdir, writeFile: mockWriteFile, readFile: mockReadFile, readdir: mockReaddir },
      spawn: mockSpawn,
      on: mockOn,
    })),
  },
}))

function mockProcess(exitCode = 0) {
  return {
    exit: Promise.resolve(exitCode),
    output: { pipeTo: vi.fn() },
    input: { getWriter: vi.fn(() => ({ write: vi.fn() })) },
    resize: vi.fn(),
  }
}

describe('webcontainer helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockSpawn.mockResolvedValue(mockProcess())
    mockReadFile.mockResolvedValue('file content')
    mockReaddir.mockResolvedValue([])
  })

  it('boots only once and mounts project files as a WebContainer tree', async () => {
    const { WebContainer } = await import('@webcontainer/api')
    const { bootWebContainer, mountProject } = await import('./webcontainer')

    await bootWebContainer()
    await bootWebContainer()
    await mountProject([{ path: 'src/main.tsx', content: 'hello' }])

    expect(WebContainer.boot).toHaveBeenCalledOnce()
    expect(mockMount).toHaveBeenCalledWith({ src: { directory: { 'main.tsx': { file: { contents: 'hello' } } } } })
  })

  it('creates parent directories before writing nested files', async () => {
    const { writeProjectFile } = await import('./webcontainer')

    await writeProjectFile('src/components/App.tsx', 'content')

    expect(mockMkdir).toHaveBeenCalledWith('src/components', { recursive: true })
    expect(mockWriteFile).toHaveBeenCalledWith('src/components/App.tsx', 'content')
  })

  it('reads project files from the WebContainer filesystem', async () => {
    const { readProjectFile } = await import('./webcontainer')

    await expect(readProjectFile('package.json')).resolves.toBe('file content')
    expect(mockReadFile).toHaveBeenCalledWith('package.json', 'utf-8')
  })

  it('returns undefined for missing project files', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('missing'))
    const { readProjectFile } = await import('./webcontainer')

    await expect(readProjectFile('missing.json')).resolves.toBeUndefined()
  })

  it('recursively syncs text project files and ignores generated directories', async () => {
    const dir = (name: string) => ({ name, isDirectory: () => true, isFile: () => false })
    const file = (name: string) => ({ name, isDirectory: () => false, isFile: () => true })
    mockReaddir.mockImplementation(async (path: string) => {
      if (path === '.') return [file('package.json'), file('image.png'), dir('src'), dir('node_modules'), dir('dist')]
      if (path === 'src') return [file('main.tsx'), file('style.css')]
      throw new Error(`Unexpected readdir ${path}`)
    })
    mockReadFile.mockImplementation(async (path: string) => `content:${path}`)
    const { readProjectFilesFromWebContainer } = await import('./webcontainer')

    await expect(readProjectFilesFromWebContainer()).resolves.toEqual([
      { path: 'package.json', content: 'content:package.json' },
      { path: 'src/main.tsx', content: 'content:src/main.tsx' },
      { path: 'src/style.css', content: 'content:src/style.css' },
    ])
    expect(mockReaddir).not.toHaveBeenCalledWith('node_modules', expect.anything())
    expect(mockReaddir).not.toHaveBeenCalledWith('dist', expect.anything())
    expect(mockReadFile).not.toHaveBeenCalledWith('image.png', 'utf-8')
  })

  it('runs npm install and pipes process output', async () => {
    const proc = mockProcess(0)
    mockSpawn.mockResolvedValue(proc)
    const onLog = vi.fn()
    const { runInstall } = await import('./webcontainer')

    await expect(runInstall(onLog)).resolves.toBe(0)

    expect(mockSpawn).toHaveBeenCalledWith('npm', ['install'])
    expect(proc.output.pipeTo).toHaveBeenCalledOnce()
  })

  it('starts the dev server and registers server-ready callback once', async () => {
    const { startDevServer } = await import('./webcontainer')

    // Prevent auto-restart: make the process exit never resolve
    mockSpawn.mockResolvedValue({
      exit: new Promise<number>(() => undefined),
      output: { pipeTo: vi.fn() },
      input: { getWriter: vi.fn(() => ({ write: vi.fn() })) },
      resize: vi.fn(),
    })

    await startDevServer(vi.fn(), vi.fn())
    await startDevServer(vi.fn(), vi.fn())

    expect(mockOn).toHaveBeenCalledWith('server-ready', expect.any(Function))
    expect(mockSpawn).toHaveBeenCalledOnce()
    expect(mockSpawn).toHaveBeenCalledWith('npm', ['run', 'dev'])
  })

  it('starts an interactive jsh shell with terminal dimensions', async () => {
    const proc = { ...mockProcess(0), exit: new Promise<number>(() => undefined) }
    mockSpawn.mockResolvedValue(proc)
    const { startShell } = await import('./webcontainer')

    const controller = await startShell(vi.fn(), { cols: 120, rows: 30 })
    await controller.write('npm install lucide-react\r')
    controller.resize(100, 24)

    expect(mockSpawn).toHaveBeenCalledWith('jsh', [], { terminal: { cols: 120, rows: 30 } })
    expect(proc.input.getWriter).toHaveBeenCalledOnce()
    expect(proc.output.pipeTo).toHaveBeenCalledOnce()
    expect(proc.resize).toHaveBeenCalledWith({ cols: 100, rows: 24 })
  })
})
