// Phase 0 smoke test (docs/scoutos-live-prd.md): a minimal hyper-zepto app
// deployed to Scout Live, exercising the data port through the platform's
// ports sidecar via hyper-zepto's remote adapters.
//
// Env mapping under test: the platform injects
//   SCOUT_PORTS_URL=http://127.0.0.1:3101/_ports
// but hyper-zepto's remote adapters append /_ports themselves, so the
// trailing /_ports must be stripped before use as baseUrl. The sidecar
// injects auth; no token is set.
import { createServer } from 'node:http'
import { createPorts } from 'hyper-zepto'

const port = Number(process.env.PORT || 3000)
const rawPortsUrl = process.env.SCOUT_PORTS_URL || ''
const baseUrl = rawPortsUrl.replace(/\/_ports\/?$/, '')
const ports = baseUrl
  ? createPorts({ mode: 'remote', baseUrl })
  : createPorts({ mode: 'local', dir: '.zepto' })

async function verify() {
  const collection = 'phase0_smoke'
  const steps = []
  const run = async (name, fn) => {
    const result = await fn()
    steps.push({ name, result })
    return result
  }

  const created = await run('create', () =>
    ports.data.create(collection, { title: 'phase0', done: false }))
  if (typeof created.id !== 'string') throw new Error('create returned no id')

  const fetched = await run('get', () => ports.data.get(collection, created.id))
  if (!fetched.found) throw new Error('get did not find the created document')

  const found = await run('find', () =>
    ports.data.find(collection, { filter: { title: 'phase0' }, limit: 5 }))
  if (!found.documents.some(d => d._id === created.id)) {
    throw new Error('find did not return the created document')
  }

  await run('update', () =>
    ports.data.update(collection, created.id, { $set: { done: true } }))
  const updated = await run('get-after-update', () => ports.data.get(collection, created.id))
  if (!updated.found || updated.document.done !== true) {
    throw new Error('update was not applied')
  }

  const counted = await run('count', () => ports.data.count(collection, { done: true }))
  if (typeof counted.count !== 'number' || counted.count < 1) {
    throw new Error('count did not see the updated document')
  }

  await run('delete', () => ports.data.delete(collection, created.id))
  const gone = await run('get-after-delete', () => ports.data.get(collection, created.id))
  if (gone.found) throw new Error('delete did not remove the document')

  return steps
}

const server = createServer(async (req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body, null, 2))
  }
  const path = (req.url ?? '').split('?')[0]

  if (path === '/health') return json(200, { ok: true, mode: ports.mode, hasPortsUrl: Boolean(rawPortsUrl) })
  if (path === '/verify' && req.method === 'POST') {
    try {
      return json(200, { ok: true, mode: ports.mode, steps: await verify() })
    } catch (error) {
      return json(500, { ok: false, mode: ports.mode, error: String(error?.message ?? error), code: error?.code })
    }
  }
  if (path === '/') {
    return json(200, {
      ok: true,
      app: 'phase0-live-ports',
      mode: ports.mode,
      portsBaseUrl: baseUrl || null,
      verifyEndpoint: 'POST /verify',
    })
  }
  return json(404, { ok: false, error: 'Not found' })
})

server.listen(port, () => console.log(`phase0-live-ports listening on ${port} (mode=${ports.mode})`))
