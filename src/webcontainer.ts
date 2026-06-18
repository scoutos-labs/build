import { WebContainer, type WebContainerProcess } from '@webcontainer/api'
import { filesToTree, type ProjectFile } from './templates'

let instance: Promise<WebContainer> | undefined

export function bootWebContainer() {
  instance ??= WebContainer.boot()
  return instance
}

export async function mountProject(files: ProjectFile[]) {
  const wc = await bootWebContainer()
  await wc.mount(filesToTree(files))
  return wc
}

export async function writeProjectFile(path: string, content: string) {
  const wc = await bootWebContainer()
  const parts = path.split('/').filter(Boolean)
  if (parts.length > 1) await wc.fs.mkdir(parts.slice(0, -1).join('/'), { recursive: true })
  await wc.fs.writeFile(path, content)
}

export async function readProjectFile(path: string): Promise<string | undefined> {
  const wc = await bootWebContainer()
  try {
    return await wc.fs.readFile(path, 'utf-8')
  } catch {
    return undefined
  }
}

const IGNORED_SYNC_DIRS = new Set(['node_modules', 'dist', '.git', '.cache', '.next', '.vite', 'coverage'])
const TEXT_FILE_PATTERN = /\.(css|html|js|jsx|json|md|mjs|cjs|ts|tsx|txt|yml|yaml)$/i
const TEXT_FILE_NAMES = new Set(['package-lock.json', 'package.json', 'vite.config.ts', 'tsconfig.json', 'README.md'])

export async function readProjectFilesFromWebContainer(): Promise<ProjectFile[]> {
  const wc = await bootWebContainer()

  async function walk(dir = ''): Promise<ProjectFile[]> {
    const entries = await wc.fs.readdir(dir || '.', { withFileTypes: true })
    const files: ProjectFile[] = []

    for (const entry of entries) {
      const path = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (IGNORED_SYNC_DIRS.has(entry.name)) continue
        files.push(...await walk(path))
      } else if (entry.isFile() && isSyncableTextFile(path)) {
        const content = await readProjectFile(path)
        if (content !== undefined) files.push({ path, content })
      }
    }

    return files
  }

  return (await walk()).sort((a, b) => a.path.localeCompare(b.path))
}

function isSyncableTextFile(path: string) {
  const name = path.split('/').at(-1) ?? path
  return TEXT_FILE_NAMES.has(name) || TEXT_FILE_PATTERN.test(path)
}

export async function runInstall(onLog: (line: string) => void) {
  const wc = await bootWebContainer()
  const proc = await wc.spawn('npm', ['install'])
  pipeOutput(proc, onLog)
  return proc.exit
}

let devProcess: WebContainerProcess | undefined

export async function startDevServer(onLog: (line: string) => void, onUrl: (url: string) => void) {
  const wc = await bootWebContainer()
  if (devProcess) return
  wc.on('server-ready', (_port, url) => onUrl(url))
  devProcess = await wc.spawn('npm', ['run', 'dev'])
  pipeOutput(devProcess, onLog)
}

let shellProcess: WebContainerProcess | undefined
let shellWriter: WritableStreamDefaultWriter<string> | undefined

export async function startShell(onOutput: (chunk: string) => void, terminal: { cols: number; rows: number } = { cols: 80, rows: 24 }) {
  const wc = await bootWebContainer()
  if (shellProcess && shellWriter) return { write: (data: string) => shellWriter?.write(data), resize: (_cols: number, _rows: number) => undefined }
  shellProcess = await wc.spawn('jsh', [], { terminal })
  shellWriter = shellProcess.input.getWriter()
  pipeOutput(shellProcess, onOutput)
  shellProcess.exit.finally(() => {
    shellProcess = undefined
    shellWriter = undefined
  })
  return {
    write: (data: string) => shellWriter?.write(data),
    resize: (cols: number, rows: number) => shellProcess?.resize?.({ cols, rows }),
  }
}

function pipeOutput(proc: WebContainerProcess, onLog: (line: string) => void) {
  proc.output.pipeTo(new WritableStream({ write: chunk => onLog(String(chunk)) }))
}
