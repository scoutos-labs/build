import { createTarGz } from './tar.js'
import type { ProjectFile } from './prompt.js'

/** Mirror of scout-live's RESERVED_SUBDOMAINS (src/lib/auth.ts) so the UI can
 * reject names before any network call; the platform stays authoritative. */
export const RESERVED_SUBDOMAINS = new Set([
  'api', 'auth', 'admin', 'dashboard', 'docs', 'ports', 'apps', 'adapters', 'api-keys',
  'www', 'scoutos', 'scout', 'scout-live', 'scoutlive',
  'mail', 'smtp', 'pop', 'imap', 'ftp', 'sftp', 'ns1', 'ns2', 'ns3', 'ns4', 'localhost', 'local',
  'status', 'health', 'metrics', 'grafana', 'prometheus', 'internal', 'staging', 'production',
  'registry', 'cdn', 'static', 'assets', 'blog', 'support', 'billing', 'account', 'login',
  'signup', 'oauth', 'sso', 'webhook', 'webhooks', 'proxy', 'gateway', 'console', 'panel',
])

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export type SubdomainCheck =
  | { ok: true; subdomain: string }
  | { ok: false; reason: 'invalid' | 'reserved' }

export function checkSubdomain(raw: string): SubdomainCheck {
  const subdomain = raw.trim().toLowerCase()
  if (!SUBDOMAIN_RE.test(subdomain)) return { ok: false, reason: 'invalid' }
  if (RESERVED_SUBDOMAINS.has(subdomain)) return { ok: false, reason: 'reserved' }
  return { ok: true, subdomain }
}

/**
 * Injected when the project lacks one. npm install (not ci): project file
 * maps from the WebContainer carry no package-lock.json. USER is a numeric
 * UID because the pod securityContext enforces runAsNonRoot, which K8s can
 * only verify for numeric users.
 */
export const PUBLISH_DOCKERFILE = `FROM node:20-alpine
WORKDIR /app
COPY --chown=1000:1000 package.json ./
RUN npm install --no-audit --no-fund
COPY --chown=1000:1000 . .
RUN npm run build
RUN mkdir -p .zepto && chown -R 1000:1000 .zepto
ENV NODE_ENV=production
ENV HOME=/home/node
EXPOSE 3000
USER 1000
CMD ["node", "server.js"]
`

export const PUBLISH_DOCKERIGNORE = `node_modules
dist
.zepto
.git
`

/** Package the project file map as the tar.gz body POST /api/build expects,
 * adding Dockerfile and .dockerignore unless the project ships its own. */
export function packageProject(files: ProjectFile[]): Buffer {
  const entries = files.map(file => ({ path: file.path.replace(/^\/+/, ''), content: file.content }))
  const has = (path: string) => entries.some(entry => entry.path === path)
  if (!has('Dockerfile')) entries.push({ path: 'Dockerfile', content: PUBLISH_DOCKERFILE })
  if (!has('.dockerignore')) entries.push({ path: '.dockerignore', content: PUBLISH_DOCKERIGNORE })
  return createTarGz(entries)
}
