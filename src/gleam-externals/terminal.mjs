import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

class BuildTerminal extends HTMLElement {
  connectedCallback() {
    if (this.terminal) return
    this.classList.add('build-terminal')
    this.mount = document.createElement('div')
    this.mount.style.height = '100%'
    this.replaceChildren(this.mount)

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"PT Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      theme: { background: '#050915', foreground: '#c5d2ee' },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(this.mount)
    this.addEventListener('click', () => this.terminal?.focus())
    terminal.focus()
    fit.fit()
    terminal.writeln('Build terminal')
    terminal.writeln('WebContainer logs appear here. Interactive shell starts after boot.\r\n')
    this.terminal = terminal
    this.fit = fit
    this.renderLogs(this.getAttribute('logs') ?? '')
    this.resize = () => this.fit?.fit()
    window.addEventListener('resize', this.resize)
    // Re-fit on element resize, not just window resize: when the code panel is
    // revealed the terminal goes from display:none (0 height) to its real size,
    // and xterm needs a fit so the shell gets correct cols/rows. Guard on a
    // non-zero height so fitting while hidden doesn't compute bad dimensions.
    this.resizeObserver = new ResizeObserver(() => {
      if (this.offsetHeight > 0) this.fit?.fit()
    })
    this.resizeObserver.observe(this)
    this.maybeConnectShell()
  }

  disconnectedCallback() {
    this.disposed = true
    this.dataDisposable?.dispose()
    if (this.resize) window.removeEventListener('resize', this.resize)
    this.resizeObserver?.disconnect()
    this.terminal?.dispose()
    this.terminal = undefined
    this.fit = undefined
  }

  static get observedAttributes() { return ['logs', 'enabled'] }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'logs' && oldValue !== newValue) this.renderLogs(newValue ?? '')
    if (name === 'enabled' && oldValue !== newValue) this.maybeConnectShell()
  }

  renderLogs(logs) {
    if (!this.terminal) return
    const lines = logs ? String(logs).split('\n') : []
    for (const line of lines.slice(this.logIndex ?? 0)) this.terminal.write(line)
    this.logIndex = lines.length
  }

  async maybeConnectShell() {
    if (this.shellConnecting || this.shellConnected || this.getAttribute('enabled') !== 'true' || !this.terminal || !this.fit) return
    this.shellConnecting = true
    try {
      const startShell = globalThis.__buildGleamStartShell
      if (!startShell) throw new Error('WebContainer runtime is not ready yet')
      this.fit.fit()
      const controller = await startShell(chunk => this.terminal?.write(chunk), { cols: this.terminal.cols, rows: this.terminal.rows })
      if (this.disposed) return
      this.shellConnected = true
      this.terminal.writeln('\r\nInteractive shell ready. Try: npm install lucide-react\r\n')
      this.terminal.focus()
      this.dataDisposable = this.terminal.onData(data => { void controller.write(data) })
      this.terminal.onResize(size => controller.resize(size.cols, size.rows))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('runtime is not ready')) {
        setTimeout(() => this.maybeConnectShell(), 1000)
      } else {
        this.terminal?.writeln(`\r\nFailed to start shell: ${message}\r\n`)
      }
    } finally {
      this.shellConnecting = false
    }
  }

  write(line) { this.terminal?.writeln(line) }
  clear() { this.terminal?.clear(); this.logIndex = 0 }
}

export function registerBuildTerminal() {
  if (!customElements.get('build-terminal')) customElements.define('build-terminal', BuildTerminal)
}
