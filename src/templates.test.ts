import { describe, expect, it } from 'vitest'
import { filesToTree, starterFiles, upsertFile } from './templates'

describe('project templates', () => {
  it('includes a runnable React/hyper-zepto starter project', () => {
    expect(starterFiles.map(file => file.path)).toEqual(expect.arrayContaining([
      'package.json',
      'index.html',
      'vite.config.ts',
      'zepto-bridge.js',
      'server.js',
      'src/main.tsx',
      'src/db.ts',
      'src/build-inspector.ts',
      'src/style.css',
    ]))
    expect(starterFiles.find(file => file.path === 'package.json')?.content).toContain('hyper-zepto')
    expect(starterFiles.find(file => file.path === 'package.json')?.content).toContain('node server.js')
    expect(starterFiles.find(file => file.path === 'vite.config.ts')?.content).toContain('zepto-bridge.js')
    expect(starterFiles.find(file => file.path === 'src/db.ts')?.content).toContain('/api/db')
    expect(starterFiles.find(file => file.path === 'src/main.tsx')?.content).toContain("./build-inspector")
    expect(starterFiles.find(file => file.path === 'src/main.tsx')?.content).toContain('BUILD_APP_FROM_PLAN')
    expect(starterFiles.find(file => file.path === 'src/main.tsx')?.content).toContain('Welcome to Build')
    expect(starterFiles.find(file => file.path === 'src/build-inspector.ts')?.content).toContain('BUILD_ELEMENT_SELECTED')
  })

  it('defaults to Vite, Tailwind CSS, shadcn/ui in interview fallback plan', () => {
    const mainContent = starterFiles.find(f => f.path === 'src/main.tsx')?.content ?? ''
    // The fallback strings use compact() which falls back to the second arg
    // when the user leaves the field blank — these are the defaults for the plan summary
    expect(mainContent).toContain('Vite')
    expect(mainContent).toContain('Tailwind CSS')
    expect(mainContent).toContain('shadcn/ui')
  })

  it('pre-bakes Tailwind + shadcn cn() helper so the agent need not bootstrap styling', () => {
    const paths = starterFiles.map(file => file.path)
    expect(paths).toContain('tailwind.config.js')
    expect(paths).toContain('postcss.config.js')
    expect(paths).toContain('src/lib/utils.ts')

    const pkg = starterFiles.find(file => file.path === 'package.json')?.content ?? ''
    expect(pkg).toContain('"tailwindcss"')
    expect(pkg).toContain('"autoprefixer"')
    expect(pkg).toContain('"postcss"')
    expect(pkg).toContain('"clsx"')
    expect(pkg).toContain('"tailwind-merge"')
    expect(pkg).toContain('"class-variance-authority"')
    expect(pkg).toContain('"lucide-react"')

    const tailwindConfig = starterFiles.find(file => file.path === 'tailwind.config.js')?.content ?? ''
    expect(tailwindConfig).toContain('./src/**/*.{js,jsx,ts,tsx}')

    const utils = starterFiles.find(file => file.path === 'src/lib/utils.ts')?.content ?? ''
    expect(utils).toContain('export function cn')
    expect(utils).toContain('twMerge')

    const css = starterFiles.find(file => file.path === 'src/style.css')?.content ?? ''
    expect(css).toContain('@tailwind base')
    expect(css).toContain('@tailwind utilities')
  })

  it('matches the Gleam starter template byte-for-byte (drift guard)', async () => {
    // The starter template exists twice: here (used by the JS externals) and
    // in src/build/pure/templates.gleam (used by update.gleam for NewProject/
    // Reset). This test compares this copy against the COMPILED Gleam module,
    // so it is only as fresh as the last `gleam build` — run via `npm test`
    // (which builds first), not bare `vitest run`, when editing the Gleam side.
    // cast past the ambient '*.mjs' declaration in vite-env.d.ts
    const gleamTemplates = await import('../build/dev/javascript/build/build/pure/templates.mjs') as unknown as {
      starter_files: () => { toArray: () => { path: string; content: string }[] }
    }
    const gleamFiles = gleamTemplates.starter_files().toArray()

    const tsByPath = new Map(starterFiles.map(file => [file.path, file.content]))
    const gleamByPath = new Map(gleamFiles.map(file => [file.path, file.content]))

    expect([...gleamByPath.keys()].sort()).toEqual([...tsByPath.keys()].sort())
    for (const [path, content] of tsByPath) {
      expect(gleamByPath.get(path), `starter file drifted between TS and Gleam: ${path}`).toBe(content)
    }
  })

  it('ships a production server with the Scout Live env mapping in the shared bridge', () => {
    const bridge = starterFiles.find(file => file.path === 'zepto-bridge.js')?.content ?? ''
    const server = starterFiles.find(file => file.path === 'server.js')?.content ?? ''

    // The bridge is written once and mounted by both vite.config.ts and server.js.
    expect(server).toContain("from './zepto-bridge.js'")
    expect(starterFiles.find(file => file.path === 'vite.config.ts')?.content).toContain("from './zepto-bridge.js'")

    // Scout Live env mapping: SCOUT_PORTS_URL ends in /_ports, which the
    // bridge strips because hyper-zepto's remote adapters append it themselves.
    expect(bridge).toContain('SCOUT_PORTS_URL')
    expect(bridge).toContain('SCOUTOS_PORTS_URL')
    expect(bridge).toContain("'/_ports'")
    expect(bridge).toContain("createPorts({ mode: 'remote', baseUrl })")
    expect(bridge).toContain("createPorts({ mode: 'local', dir: '.zepto' })")

    // Production serving contract used by the publish Dockerfile.
    expect(server).toContain('dist')
    expect(server).toContain('/api/db')
    expect(server).toContain('process.env.PORT')
  })

  it('converts flat project files into a WebContainer file tree', () => {
    const tree = filesToTree([
      { path: 'package.json', content: '{}' },
      { path: 'src/main.tsx', content: 'console.log(1)' },
    ])

    expect(tree['package.json']).toEqual({ file: { contents: '{}' } })
    expect(tree.src).toEqual({ directory: { 'main.tsx': { file: { contents: 'console.log(1)' } } } })
  })

  it('upserts existing files without changing unrelated files', () => {
    const files = [
      { path: 'a.ts', content: 'old' },
      { path: 'b.ts', content: 'same' },
    ]

    expect(upsertFile(files, '/a.ts', 'new')).toEqual([
      { path: 'a.ts', content: 'new' },
      { path: 'b.ts', content: 'same' },
    ])
  })

  it('adds new files in sorted order', () => {
    expect(upsertFile([{ path: 'z.ts', content: 'z' }], 'a.ts', 'a')).toEqual([
      { path: 'a.ts', content: 'a' },
      { path: 'z.ts', content: 'z' },
    ])
  })
})
