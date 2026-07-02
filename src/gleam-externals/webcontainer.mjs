import { dispatchPreviewUrlChanged, dispatchProjectFilesUpdated, dispatchProjectSaveStatus, dispatchWebContainerBootFailed, dispatchWebContainerBootStarted, dispatchWebContainerBootSucceeded, dispatchWebContainerLog, dispatchWebContainerRemountFinished } from './runtime_bridge.mjs'

const fallbackStarterFiles = [
  { path: 'package.json', content: '{}' },
  { path: 'index.html', content: '<div id="root"></div>' },
  { path: 'src/main.tsx', content: 'console.log("Build")' },
]
let lastFiles = fallbackStarterFiles
// Tracks the package.json content most recently installed into the
// WebContainer. Project switches between apps that share the same
// dependencies (the common case — they all start from the same template)
// skip `npm install` entirely, which keeps the running dev server alive
// and avoids the preview reload storm that caused the switch flicker.
let lastInstalledPackageJson = null
const scheduledFileWrites = new Map()

async function modules() {
  try {
    const wc = await import('../webcontainer')
    const templates = await import('../templates')
    return { ...wc, starterFiles: templates.starterFiles }
  } catch {
    return {
      starterFiles: fallbackStarterFiles,
      mountProject: async files => { lastFiles = files },
      runInstall: async onLog => onLog('Install skipped outside browser WebContainer.'),
      startDevServer: async (_onLog, onUrl) => onUrl(''),
      readProjectFilesFromWebContainer: async () => lastFiles,
      writeProjectFile: async (path, content) => {
        lastFiles = lastFiles.map(file => file.path === path ? { path, content } : file)
      },
    }
  }
}

function message(error) { return error instanceof Error ? error.message : String(error) }

// Vite watches the WebContainer filesystem and usually reloads the preview on
// its own after a remount. Hard-reloading the iframe on top of that produces
// a second blank flash. We track the last time the iframe fired `load` and,
// after a remount, defer the explicit reload briefly — if vite already
// reloaded since THIS mount began, we skip it. (Loads from a previous mount
// or the initial boot must not suppress the reload, so the comparison is
// against the mount start, not a trailing window.)
let lastPreviewLoadAt = 0
function ensurePreviewLoadWatch() {
  const iframe = typeof document === 'undefined' ? null : document.querySelector('iframe[title="preview"]')
  if (!iframe || iframe.dataset.flickerWatch) return
  iframe.dataset.flickerWatch = '1'
  iframe.addEventListener('load', () => { lastPreviewLoadAt = Date.now() })
}
function schedulePreviewReloadAfterMount(mountStartedAt) {
  if (typeof document === 'undefined') return
  ensurePreviewLoadWatch()
  setTimeout(() => {
    if (lastPreviewLoadAt > mountStartedAt) return
    // re-query: the UI may have replaced the iframe since the mount started
    const iframe = document.querySelector('iframe[title="preview"]')
    if (iframe?.src) iframe.src = iframe.src
  }, 600)
}
// npm exits nonzero on a failed install; the no-op fallback returns undefined.
function installSucceeded(exitCode) { return exitCode === undefined || exitCode === 0 }
function gleamListToArray(list) { return typeof list?.toArray === 'function' ? list.toArray() : [] }
function packageJsonOf(files) {
  return files.find(file => file.path === 'package.json')?.content ?? null
}
function normalizeFiles(files) {
  if (!files) return lastFiles
  if (Array.isArray(files)) return files
  return gleamListToArray(files).map(file => ({ path: file.path, content: file.content }))
}

export async function bootContainer(files) {
  const m = await modules()
  setLastFiles(normalizeFiles(files).length ? normalizeFiles(files) : m.starterFiles)
  dispatchWebContainerBootStarted()
  try {
    dispatchWebContainerLog('Booting WebContainer...')
    await m.mountProject(lastFiles)
    dispatchWebContainerLog('Installing dependencies...')
    const exitCode = await m.runInstall(line => dispatchWebContainerLog(line))
    // Only a successful install may arm the skip-install optimization —
    // recording a failed install would skip the retry on every later remount.
    if (installSucceeded(exitCode)) lastInstalledPackageJson = packageJsonOf(lastFiles)
    dispatchWebContainerLog('Starting preview server...')
    await m.startDevServer(line => dispatchWebContainerLog(line), url => dispatchPreviewUrlChanged(url))
    dispatchWebContainerBootSucceeded()
  } catch (error) {
    dispatchWebContainerBootFailed(message(error))
  }
}

// Remounts are serialized: overlapping project switches would otherwise race
// their installs and leave lastInstalledPackageJson describing a package.json
// that is not the one actually in the container.
let mountChain = Promise.resolve()

export function mountAndInstall(files) {
  const run = mountChain.then(() => doMountAndInstall(files))
  mountChain = run.catch(() => {})
  return run
}

async function doMountAndInstall(files) {
  const m = await modules()
  const mountStartedAt = Date.now()
  if (files) setLastFiles(normalizeFiles(files))
  // Only reinstall when package.json actually changed. Reusing the existing
  // node_modules keeps the dev server process alive, so `server-ready` does
  // not re-fire and the preview iframe only reloads once (below) instead of
  // several times.
  const pkg = packageJsonOf(lastFiles)
  const needsInstall = pkg !== lastInstalledPackageJson
  try {
    await m.mountProject(lastFiles)
    if (needsInstall) {
      dispatchWebContainerLog('Installing project dependencies...')
      const exitCode = await m.runInstall(line => dispatchWebContainerLog(line))
      if (installSucceeded(exitCode)) {
        lastInstalledPackageJson = pkg
      } else {
        // Failed install leaves node_modules unreliable: disarm the skip so
        // the next remount retries instead of skipping forever.
        lastInstalledPackageJson = null
        dispatchWebContainerLog('npm install failed — will retry on next project switch.')
      }
    } else {
      dispatchWebContainerLog('Dependencies unchanged — skipping install.')
    }
  } finally {
    schedulePreviewReloadAfterMount(mountStartedAt)
    dispatchWebContainerRemountFinished()
  }
}

export async function startDevServer() {
  const m = await modules()
  await m.startDevServer(line => dispatchWebContainerLog(line), url => dispatchPreviewUrlChanged(url))
}

function appendRuntimeLog(line) {
  globalThis.__buildLastRuntimeLog = line
  document.querySelector('build-terminal')?.write?.(line)
  dispatchWebContainerLog(line)
}

export async function runNpmInstall() {
  const m = await modules()
  globalThis.__buildLastNpmInstall = true
  appendRuntimeLog('package.json changed; running npm install...')
  const exitCode = await m.runInstall(line => appendRuntimeLog(line))
  if (!installSucceeded(exitCode)) {
    lastInstalledPackageJson = null
    appendRuntimeLog('npm install failed — will retry on next project switch.')
    return
  }
  // Read package.json from the container itself — agent patches write there
  // directly without updating lastFiles, so lastFiles can be stale here.
  const containerPkg = m.readProjectFile ? await m.readProjectFile('package.json') : undefined
  lastInstalledPackageJson = containerPkg ?? packageJsonOf(lastFiles)
}

export async function readFilesFromContainer() {
  const m = await modules()
  const files = await m.readProjectFilesFromWebContainer()
  if (files.length) dispatchProjectFilesUpdated(files, `Synced ${files.length} files from terminal`)
  else dispatchProjectSaveStatus('No files found to sync')
}

export async function writeFileToContainer(path, content) {
  const m = await modules()
  await m.writeProjectFile(path, content)
}

export function scheduleWriteFileToContainer(delay, path, content) {
  const previous = scheduledFileWrites.get(path)
  if (previous) clearTimeout(previous)
  const timer = setTimeout(() => {
    scheduledFileWrites.delete(path)
    void writeFileToContainer(path, content)
  }, delay)
  scheduledFileWrites.set(path, timer)
}

export async function startShell(onOutput, terminal) {
  const m = await modules()
  return m.startShell(onOutput, terminal)
}

globalThis.__buildGleamStartShell = startShell

export function remountProject() { void mountAndInstall() }
export function setLastFiles(files) { lastFiles = files?.length ? files : fallbackStarterFiles }
