import {
  dispatchPublishAccepted,
  dispatchPublishDeploymentLoaded,
  dispatchPublishKeyDeleted,
  dispatchPublishKeySaved,
  dispatchPublishKeySaveFailed,
  dispatchPublishKeyStatusLoaded,
  dispatchPublishPollDue,
  dispatchPublishRejected,
  dispatchPublishStatusPolled,
} from './runtime_bridge.mjs'

function gleamListToArray(list) {
  return Array.isArray(list) ? list : typeof list?.toArray === 'function' ? list.toArray() : []
}

async function authHeaders(extra = {}) {
  const token = await globalThis.__buildManagedAuth?.getToken?.()
  return token ? { Authorization: `Bearer ${token}`, ...extra } : { ...extra }
}

async function errorOf(response) {
  try {
    const body = await response.json()
    return {
      code: body?.error?.code ?? `http_${response.status}`,
      message: body?.error?.message ?? `Request failed (${response.status})`,
    }
  } catch {
    return { code: `http_${response.status}`, message: `Request failed (${response.status})` }
  }
}

export async function fetchKeyStatus() {
  try {
    const response = await fetch('/api/credentials', { headers: await authHeaders() })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    dispatchPublishKeyStatusLoaded(Boolean(body?.scoutos))
  } catch {
    dispatchPublishKeyStatusLoaded(false)
  }
}

export async function saveKey(key) {
  try {
    const response = await fetch('/api/credentials/scoutos', {
      method: 'PUT',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ key }),
    })
    if (!response.ok) {
      const { message } = await errorOf(response)
      dispatchPublishKeySaveFailed(message)
      return
    }
    dispatchPublishKeySaved()
  } catch {
    dispatchPublishKeySaveFailed('Could not reach the server')
  }
}

export async function deleteKey() {
  try {
    await fetch('/api/credentials/scoutos', { method: 'DELETE', headers: await authHeaders() })
  } finally {
    dispatchPublishKeyDeleted()
  }
}

export async function fetchDeployment(projectId) {
  try {
    const response = await fetch(`/api/deployments/${encodeURIComponent(projectId)}`, {
      headers: await authHeaders(),
    })
    if (response.ok) {
      const body = await response.json()
      dispatchPublishDeploymentLoaded(projectId, true, body?.subdomain ?? '')
      return
    }
  } catch {
    // Treat lookup failures as "not published yet" — the prompt still works.
  }
  dispatchPublishDeploymentLoaded(projectId, false, '')
}

export async function startPublish(projectId, subdomain, filesArg) {
  const files = gleamListToArray(filesArg).map(file => ({ path: file.path, content: file.content }))
  try {
    const response = await fetch('/api/publish', {
      method: 'POST',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ projectId, subdomain, files }),
    })
    if (!response.ok) {
      const { code, message } = await errorOf(response)
      dispatchPublishRejected(code, message)
      return
    }
    const body = await response.json()
    dispatchPublishAccepted(body.buildId, body.subdomain ?? subdomain)
  } catch {
    dispatchPublishRejected('network_error', 'Could not reach the server')
  }
}

export async function pollStatus(buildId) {
  try {
    const response = await fetch(`/api/publish/${encodeURIComponent(buildId)}`, {
      headers: await authHeaders(),
    })
    if (!response.ok) {
      const { message } = await errorOf(response)
      dispatchPublishStatusPolled(buildId, 'failed', '', message, '')
      return
    }
    const body = await response.json()
    dispatchPublishStatusPolled(
      buildId,
      String(body?.status ?? 'failed'),
      body?.url ?? '',
      body?.error ?? '',
      body?.logs ?? '',
    )
  } catch {
    // Transient network failure: report a non-terminal status so the actor
    // schedules another poll instead of giving up.
    dispatchPublishStatusPolled(buildId, 'running', '', '', '')
  }
}

export function schedulePoll(buildId, delay) {
  setTimeout(() => dispatchPublishPollDue(buildId), delay)
}
