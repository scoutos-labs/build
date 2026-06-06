import { describe, expect, it, vi, beforeEach } from 'vitest'
import { executeBuildTool, BUILD_TOOL_SCHEMAS } from './build-tools'

describe('BUILD_TOOL_SCHEMAS', () => {
  it('exports five tools', () => {
    const names = BUILD_TOOL_SCHEMAS.map(s => s.name)
    expect(names).toEqual(['write_file', 'read_file', 'run_command', 'list_files', 'install_package'])
  })
})

describe('executeBuildTool', () => {
  const mockApi = {
    writeProjectFile: vi.fn(),
    readProjectFile: vi.fn(),
    runCommand: vi.fn(),
    listFiles: vi.fn(),
    installPackage: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── write_file ───────────────────────────────────────────────

  it('writes a file and returns success', async () => {
    mockApi.writeProjectFile.mockResolvedValue(undefined)

    const result = await executeBuildTool('write_file', { path: 'src/App.tsx', content: 'export default {}' }, mockApi)

    expect(mockApi.writeProjectFile).toHaveBeenCalledWith('src/App.tsx', 'export default {}')
    expect(result).toEqual({ ok: true, data: { path: 'src/App.tsx', written: true } })
  })

  it('returns error when path is missing for write_file', async () => {
    const result = await executeBuildTool('write_file', { path: '', content: 'hi' }, mockApi)
    expect(result).toEqual({ ok: false, error: 'Missing required parameter: path' })
    expect(mockApi.writeProjectFile).not.toHaveBeenCalled()
  })

  it('returns error when writeProjectFile throws', async () => {
    mockApi.writeProjectFile.mockRejectedValue(new Error('disk full'))
    const result = await executeBuildTool('write_file', { path: 'x', content: 'y' }, mockApi)
    expect(result).toEqual({ ok: false, error: 'disk full' })
  })

  // ── read_file ──────────────────────────────────────────────────

  it('reads a file and returns content', async () => {
    mockApi.readProjectFile.mockResolvedValue('hello world')

    const result = await executeBuildTool('read_file', { path: 'README.md' }, mockApi)

    expect(mockApi.readProjectFile).toHaveBeenCalledWith('README.md')
    expect(result).toEqual({ ok: true, data: { path: 'README.md', content: 'hello world' } })
  })

  it('returns error for missing file', async () => {
    mockApi.readProjectFile.mockResolvedValue(undefined)

    const result = await executeBuildTool('read_file', { path: 'missing.txt' }, mockApi)

    expect(result).toEqual({ ok: false, error: 'File not found: missing.txt' })
  })

  it('returns error when path is missing for read_file', async () => {
    const result = await executeBuildTool('read_file', { path: '' }, mockApi)
    expect(result).toEqual({ ok: false, error: 'Missing required parameter: path' })
  })

  // ── run_command ────────────────────────────────────────────────

  it('runs a command and returns output + exit code', async () => {
    mockApi.runCommand.mockResolvedValue({ exitCode: 0, output: 'done\n' })

    const result = await executeBuildTool('run_command', { command: 'echo hello' }, mockApi)

    expect(mockApi.runCommand).toHaveBeenCalledWith('echo hello', undefined)
    expect(result).toEqual({ ok: true, data: { exitCode: 0, output: 'done\n' } })
  })

  it('passes timeout to runCommand', async () => {
    mockApi.runCommand.mockResolvedValue({ exitCode: 0, output: '' })

    await executeBuildTool('run_command', { command: 'sleep 1', timeout: 5000 }, mockApi)

    expect(mockApi.runCommand).toHaveBeenCalledWith('sleep 1', 5000)
  })

  it('returns error when command is missing', async () => {
    const result = await executeBuildTool('run_command', { command: '' }, mockApi)
    expect(result).toEqual({ ok: false, error: 'Missing required parameter: command' })
  })

  it('returns error when runCommand throws', async () => {
    mockApi.runCommand.mockRejectedValue(new Error('timeout'))
    const result = await executeBuildTool('run_command', { command: 'bad' }, mockApi)
    expect(result).toEqual({ ok: false, error: 'timeout' })
  })

  // ── list_files ─────────────────────────────────────────────────

  it('lists files with explicit path', async () => {
    mockApi.listFiles.mockResolvedValue(['index.html', 'src'])

    const result = await executeBuildTool('list_files', { path: '.' }, mockApi)

    expect(mockApi.listFiles).toHaveBeenCalledWith('.')
    expect(result).toEqual({ ok: true, data: { path: '.', entries: ['index.html', 'src'] } })
  })

  it('lists files with default path', async () => {
    mockApi.listFiles.mockResolvedValue([])

    const result = await executeBuildTool('list_files', {}, mockApi)

    expect(mockApi.listFiles).toHaveBeenCalledWith('.')
    expect(result).toEqual({ ok: true, data: { path: '.', entries: [] } })
  })

  it('returns error when listFiles throws', async () => {
    mockApi.listFiles.mockRejectedValue(new Error('ENOTDIR'))
    const result = await executeBuildTool('list_files', { path: 'not-a-dir' }, mockApi)
    expect(result).toEqual({ ok: false, error: 'ENOTDIR' })
  })

  // ── install_package ─────────────────────────────────────────────

  it('installs a package and returns result', async () => {
    mockApi.installPackage.mockResolvedValue({ exitCode: 0, output: '+ lucide-react@0.x\n' })

    const result = await executeBuildTool('install_package', { package: 'lucide-react' }, mockApi)

    expect(mockApi.installPackage).toHaveBeenCalledWith('lucide-react')
    expect(result).toEqual({ ok: true, data: { exitCode: 0, output: '+ lucide-react@0.x\n' } })
  })

  it('returns error when package is missing', async () => {
    const result = await executeBuildTool('install_package', { package: '' }, mockApi)
    expect(result).toEqual({ ok: false, error: 'Missing required parameter: package' })
  })

  it('returns error when installPackage throws', async () => {
    mockApi.installPackage.mockRejectedValue(new Error('network error'))
    const result = await executeBuildTool('install_package', { package: 'x' }, mockApi)
    expect(result).toEqual({ ok: false, error: 'network error' })
  })
})
