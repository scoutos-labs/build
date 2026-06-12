import { starterFiles, upsertFile, type ProjectFile } from './templates'

/**
 * Projects created before the production-template update (or whose
 * package.json the agent rewrote) may lack the publish infrastructure the
 * injected Dockerfile depends on: zepto-bridge.js, server.js, the
 * build/start scripts, and the hyper-zepto dependency. Merge the missing
 * pieces in at publish time without touching anything the project already
 * defines.
 */
const INFRA_FILES = ['zepto-bridge.js', 'server.js']

export function preparePublishFiles(files: ProjectFile[]): ProjectFile[] {
  let prepared = files
  for (const path of INFRA_FILES) {
    if (!prepared.some(file => file.path === path)) {
      const template = starterFiles.find(file => file.path === path)
      if (template) prepared = upsertFile(prepared, path, template.content)
    }
  }
  return patchPackageJson(prepared)
}

function patchPackageJson(files: ProjectFile[]): ProjectFile[] {
  const pkg = files.find(file => file.path === 'package.json')
  if (!pkg) return files // nothing sensible to add; the build will fail loudly
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(pkg.content)
  } catch {
    return files // broken JSON would fail npm install anyway; keep logs honest
  }

  const scripts = { ...((parsed.scripts as Record<string, string>) ?? {}) }
  const dependencies = { ...((parsed.dependencies as Record<string, string>) ?? {}) }
  const devDependencies = (parsed.devDependencies as Record<string, string>) ?? {}

  let changed = false
  if (!scripts['build']) {
    scripts['build'] = 'vite build'
    changed = true
  }
  if (!scripts['start']) {
    scripts['start'] = 'node server.js'
    changed = true
  }
  for (const dep of ['hyper-zepto', 'vite']) {
    if (!dependencies[dep] && !devDependencies[dep]) {
      const template = JSON.parse(
        starterFiles.find(file => file.path === 'package.json')!.content,
      ) as { dependencies: Record<string, string> }
      dependencies[dep] = template.dependencies[dep]
      changed = true
    }
  }

  if (!changed) return files
  const next = { ...parsed, scripts, dependencies }
  return upsertFile(files, 'package.json', JSON.stringify(next, null, 2))
}
