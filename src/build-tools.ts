import type { WebContainer } from '@webcontainer/api'
import { writeProjectFile, readProjectFile } from './webcontainer'

// ── Tool Schemas ────────────────────────────────────────────────

export const BUILD_TOOL_SCHEMAS = [
  {
    name: 'write_file',
    description: 'Write (or overwrite) a text file inside the WebContainer.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative file path (e.g. src/App.tsx)' },
        content: { type: 'string', description: 'Full file contents' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the WebContainer.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative file path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command inside the WebContainer.',
    parameters: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: { type: 'number', description: 'Optional timeout in ms (default 30_000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'list_files',
    description: 'List directory entries inside the WebContainer.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory path (default ".")' },
      },
    },
  },
  {
    name: 'install_package',
    description: 'Install an npm package inside the WebContainer.',
    parameters: {
      type: 'object' as const,
      properties: {
        package: { type: 'string', description: 'Package name (e.g. "lucide-react")' },
      },
      required: ['package'],
    },
  },
] as const

export type BuildToolName = (typeof BUILD_TOOL_SCHEMAS)[number]['name']

export type BuildToolInput = {
  write_file: { path: string; content: string }
  read_file: { path: string }
  run_command: { command: string; timeout?: number }
  list_files: { path?: string }
  install_package: { package: string }
}

export type BuildToolResult = { ok: true; data: unknown } | { ok: false; error: string }

// ── Executor ────────────────────────────────────────────────────

export async function executeBuildTool<N extends BuildToolName>(
  toolName: N,
  input: BuildToolInput[N],
  webcontainerApi: {
    writeProjectFile: (path: string, content: string) => Promise<void>
    readProjectFile: (path: string) => Promise<string | undefined>
    runCommand: (command: string, timeout?: number) => Promise<{ exitCode: number; output: string }>
    listFiles: (path?: string) => Promise<string[]>
    installPackage: (pkg: string) => Promise<{ exitCode: number; output: string }>
  },
): Promise<BuildToolResult> {
  try {
    switch (toolName) {
      case 'write_file': {
        const { path, content } = input as BuildToolInput['write_file']
        if (!path) return { ok: false, error: 'Missing required parameter: path' }
        await webcontainerApi.writeProjectFile(path, content)
        return { ok: true, data: { path, written: true } }
      }
      case 'read_file': {
        const { path } = input as BuildToolInput['read_file']
        if (!path) return { ok: false, error: 'Missing required parameter: path' }
        const content = await webcontainerApi.readProjectFile(path)
        if (content === undefined) return { ok: false, error: `File not found: ${path}` }
        return { ok: true, data: { path, content } }
      }
      case 'run_command': {
        const { command, timeout } = input as BuildToolInput['run_command']
        if (!command) return { ok: false, error: 'Missing required parameter: command' }
        const result = await webcontainerApi.runCommand(command, timeout)
        return { ok: true, data: result }
      }
      case 'list_files': {
        const { path = '.' } = input as BuildToolInput['list_files']
        const entries = await webcontainerApi.listFiles(path)
        return { ok: true, data: { path, entries } }
      }
      case 'install_package': {
        const { package: pkg } = input as BuildToolInput['install_package']
        if (!pkg) return { ok: false, error: 'Missing required parameter: package' }
        const result = await webcontainerApi.installPackage(pkg)
        return { ok: true, data: result }
      }
      default: {
        const _exhaustive: never = toolName
        return { ok: false, error: `Unknown tool: ${toolName}` }
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
