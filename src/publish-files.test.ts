import { describe, expect, it } from 'vitest'
import { preparePublishFiles } from './publish-files'
import { starterFiles } from './templates'

// A project saved before the production-template update: dev script only,
// no server.js / zepto-bridge.js.
const legacyPackageJson = JSON.stringify(
  {
    scripts: { dev: 'vite --host 0.0.0.0' },
    dependencies: {
      '@vitejs/plugin-react': '^4.3.4',
      'hyper-zepto': '^0.1.0',
      vite: '^7.3.2',
      react: '^18.3.1',
      'react-dom': '^18.3.1',
    },
    type: 'module',
  },
  null,
  2,
)

const legacyProject = [
  { path: 'package.json', content: legacyPackageJson },
  { path: 'index.html', content: '<div id="root"></div>' },
  { path: 'src/main.tsx', content: 'render()' },
  { path: 'src/db.ts', content: 'export const db = {}' },
]

describe('preparePublishFiles', () => {
  it('backfills server.js, zepto-bridge.js, and the build/start scripts for legacy projects', () => {
    const prepared = preparePublishFiles(legacyProject)
    const paths = prepared.map(file => file.path)

    expect(paths).toContain('server.js')
    expect(paths).toContain('zepto-bridge.js')
    expect(prepared.find(file => file.path === 'server.js')?.content).toBe(
      starterFiles.find(file => file.path === 'server.js')?.content,
    )

    const pkg = JSON.parse(prepared.find(file => file.path === 'package.json')!.content)
    expect(pkg.scripts).toEqual({
      dev: 'vite --host 0.0.0.0',
      build: 'vite build',
      start: 'node server.js',
    })
    // Agent-added dependencies stay untouched.
    expect(pkg.dependencies.react).toBe('^18.3.1')
    expect(pkg.type).toBe('module')
  })

  it('adds missing hyper-zepto/vite dependencies from the template versions', () => {
    const bare = [
      { path: 'package.json', content: '{"scripts":{"dev":"vite"},"dependencies":{"react":"^18.3.1"}}' },
    ]
    const pkg = JSON.parse(
      preparePublishFiles(bare).find(file => file.path === 'package.json')!.content,
    )
    const template = JSON.parse(starterFiles.find(file => file.path === 'package.json')!.content)
    expect(pkg.dependencies['hyper-zepto']).toBe(template.dependencies['hyper-zepto'])
    expect(pkg.dependencies.vite).toBe(template.dependencies.vite)
  })

  it('leaves current-template projects byte-for-byte unchanged', () => {
    expect(preparePublishFiles(starterFiles)).toBe(starterFiles)
  })

  it('never overrides files or scripts the project already defines', () => {
    const custom = [
      {
        path: 'package.json',
        content: '{"scripts":{"build":"tsc && vite build","start":"node custom.js"},"dependencies":{"hyper-zepto":"0.0.9","vite":"^7.0.0"}}',
      },
      { path: 'server.js', content: '// my own server' },
      { path: 'zepto-bridge.js', content: '// my own bridge' },
    ]
    const prepared = preparePublishFiles(custom)
    expect(prepared).toBe(custom)
  })

  it('tolerates missing or unparseable package.json', () => {
    const noPkg = [{ path: 'src/main.tsx', content: 'render()' }]
    expect(preparePublishFiles(noPkg).map(f => f.path)).toContain('server.js')

    const broken = [{ path: 'package.json', content: 'not json' }]
    const prepared = preparePublishFiles(broken)
    expect(prepared.find(f => f.path === 'package.json')?.content).toBe('not json')
    expect(prepared.map(f => f.path)).toContain('server.js')
  })
})

describe('.build/ never ships', () => {
  it('publish never carries a workspace file', () => {
    // The entire reason skills and personas live in the workspace store rather
    // than project.files: /api/publish receives app.project.files verbatim and
    // preparePublishFiles only ever ADDS. A skill reaching this array would be
    // deployed to scoutos.live under the user's name.
    const prepared = preparePublishFiles([
      { path: 'package.json', content: '{}' },
      { path: 'index.html', content: '<div id="root"></div>' },
    ])
    expect(prepared.some(file => file.path.startsWith('.build/'))).toBe(false)
  })

  it('would surface a workspace file if one ever leaked into project.files', () => {
    // Guard on the guard: if a future change routes .build/ writes through
    // FileApplied, this fails and says so, rather than silently publishing.
    const leaked = preparePublishFiles([
      { path: 'package.json', content: '{}' },
      { path: '.build/skills/verify/SKILL.md', content: 'secret notes' },
    ])
    const workspaceFiles = leaked.filter(file => file.path.startsWith('.build/'))
    expect(
      workspaceFiles,
      '.build/ files must never reach project.files — they are published verbatim',
    ).toHaveLength(1)
  })
})
