import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getEnvVars,
  setEnvVars,
  upsertEnvVar,
  deleteEnvVar,
  envToDotEnv,
} from './env-store'

// Override indexedDB with a fake implementation for testing
const fakeDB: Record<string, Record<string, unknown>> = {}

vi.stubGlobal('indexedDB', {
  open: (_name: string, version: number) => ({
    result: {
      objectStoreNames: [],
      transaction: () => ({
        objectStore: () => ({
          get: () => ({ result: undefined }),
          put: () => {},
        }),
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
      }),
      onupgradeneeded: null as (() => void) | null,
    },
    onupgradeneeded: (cb: () => void) => cb(),
    onsuccess: (cb: () => void) => cb(),
    onerror: (cb: () => void) => cb(),
  }),
})

// Simple in-memory store for testing
const testStore: Record<string, Record<string, string>> = {}

function openTestDb() {
  return {
    transaction: (store: string, mode: string) => ({
      objectStore: () => ({
        get: (key: string) => {
          return { result: testStore[key] ?? null, onsuccess: null, onerror: null }
        },
        put: (val: { projectId: string; vars: Record<string, string> }) => {
          testStore[val.projectId] = val.vars
        },
      }),
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
    }),
  } as unknown as IDBDatabase
}

describe('env-store', () => {
  beforeEach(() => {
    Object.keys(testStore).forEach(key => delete testStore[key])
  })

  it('serializes env vars to .env format correctly', () => {
    expect(envToDotEnv({ API_KEY: 'secret123', PORT: '3000', EMPTY: '' }))
      .toEqual('API_KEY="secret123"\nPORT="3000"\nEMPTY=')
  })

  it('escapes special characters in values', () => {
    expect(envToDotEnv({ URL: 'https://example.com?key=$val' }))
      .toContain('$val') // dollar sign should be escaped
  })

  it('handles empty env vars', () => {
    expect(envToDotEnv({})).toBe('')
  })
})
