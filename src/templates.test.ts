import { describe, expect, it } from 'vitest'
import { ensureVerifiable, filesToTree, starterFiles, upsertFile } from './templates'

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
    // The onboarding interview lives in Build's chat panel now; the starter
    // is a calm placeholder the agent replaces on the first build.
    expect(starterFiles.find(file => file.path === 'src/main.tsx')?.content).toContain('Welcome to Build')
    expect(starterFiles.find(file => file.path === 'src/main.tsx')?.content).not.toContain('BUILD_APP_FROM_PLAN')
    expect(starterFiles.find(file => file.path === 'src/build-inspector.ts')?.content).toContain('BUILD_ELEMENT_SELECTED')
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

describe('the starter can actually be verified', () => {
  // The agent is told to run `npx tsc --noEmit` (see the built-in verify skill
  // in src/skills.ts). A live run showed that command printing tsc's help text
  // and exiting 1 on every turn, because none of the three pieces below were
  // there. They look like boilerplate; they are the difference between the
  // agent checking its work and burning a step pretending to.
  const byPath = new Map(starterFiles.map(file => [file.path, file.content]))

  it('ships a tsconfig.json, without which tsc does not typecheck at all', () => {
    const raw = byPath.get('tsconfig.json')
    expect(raw, 'no tsconfig.json — `tsc --noEmit` will just print its help').toBeDefined()
    const config = JSON.parse(raw!)
    expect(config.include).toContain('src')
    // Declares `*.css`, or a side-effect style import reads as TS2882.
    expect(config.compilerOptions.types).toContain('vite/client')
    expect(config.compilerOptions.jsx).toBe('react-jsx')
  })

  it('ships React type declarations, without which real errors drown in noise', () => {
    const pkg = JSON.parse(byPath.get('package.json')!)
    expect(pkg.devDependencies['@types/react']).toBeDefined()
    expect(pkg.devDependencies['@types/react-dom']).toBeDefined()
  })

  it('pins typescript instead of tracking latest', () => {
    // `latest` silently became TypeScript 7, the native rewrite — a major
    // version change under existing projects with no signal.
    const pkg = JSON.parse(byPath.get('package.json')!)
    expect(pkg.dependencies.typescript).not.toBe('latest')
    expect(pkg.dependencies.typescript).toMatch(/^\^?\d/)
  })
})

describe('ensureVerifiable — existing projects, not just new ones', () => {
  const pkg = (over: object = {}) =>
    JSON.stringify({ dependencies: { react: '^18.3.1' }, devDependencies: { postcss: '^8' }, ...over }, null, 2)

  it('returns the SAME array when nothing is missing, so nothing is re-saved', () => {
    const files = ensureVerifiable([
      { path: 'tsconfig.json', content: '{}' },
      { path: 'package.json', content: pkg({ devDependencies: { '@types/react': '^18', '@types/react-dom': '^18' } }) },
    ])
    const again = ensureVerifiable(files)
    expect(again).toBe(files)
  })

  it('adds a tsconfig.json to a project that predates it', () => {
    const out = ensureVerifiable([{ path: 'src/main.tsx', content: 'x' }])
    const added = out.find(f => f.path === 'tsconfig.json')
    expect(added, 'an old project would keep failing every verify step').toBeDefined()
    expect(JSON.parse(added!.content).include).toContain('src')
  })

  it('adds the React types without disturbing the rest of package.json', () => {
    const out = ensureVerifiable([{ path: 'package.json', content: pkg() }])
    const parsed = JSON.parse(out.find(f => f.path === 'package.json')!.content)
    expect(parsed.devDependencies['@types/react']).toBeDefined()
    expect(parsed.devDependencies['@types/react-dom']).toBeDefined()
    expect(parsed.devDependencies.postcss).toBe('^8')
    expect(parsed.dependencies.react).toBe('^18.3.1')
  })

  it('does not repin typescript — an open should not force a reinstall', () => {
    const out = ensureVerifiable([
      { path: 'package.json', content: pkg({ dependencies: { typescript: 'latest' } }) },
    ])
    const parsed = JSON.parse(out.find(f => f.path === 'package.json')!.content)
    expect(parsed.dependencies.typescript).toBe('latest')
  })

  it('respects types already declared as regular dependencies', () => {
    const out = ensureVerifiable([
      { path: 'package.json', content: pkg({ dependencies: { '@types/react': '^17', '@types/react-dom': '^17' } }) },
    ])
    const parsed = JSON.parse(out.find(f => f.path === 'package.json')!.content)
    expect(parsed.devDependencies['@types/react']).toBeUndefined()
    expect(parsed.dependencies['@types/react']).toBe('^17')
  })

  it('leaves an unparseable package.json alone rather than clobbering it', () => {
    const broken = [{ path: 'package.json', content: '{ not json' }]
    expect(ensureVerifiable(broken).find(f => f.path === 'package.json')!.content).toBe('{ not json')
  })

  it('leaves an empty project alone — it is about to be seeded', () => {
    expect(ensureVerifiable([])).toEqual([])
  })
})
