import { describe, expect, it } from 'vitest'
import { createKeyCrypto } from './key-crypto.js'

describe('createKeyCrypto', () => {
  it('round-trips an OpenRouter key', () => {
    const crypto = createKeyCrypto('test-secret')
    const key = 'sk-or-v1-abc123def456'
    expect(crypto.decrypt(crypto.encrypt(key))).toBe(key)
  })

  it('ciphertext does not contain the plaintext key', () => {
    const crypto = createKeyCrypto('test-secret')
    const encrypted = crypto.encrypt('sk-or-v1-abc123def456')
    expect(encrypted.toString('utf8')).not.toContain('sk-or-')
    expect(encrypted.toString('latin1')).not.toContain('sk-or-')
  })

  it('uses a fresh IV per encryption', () => {
    const crypto = createKeyCrypto('test-secret')
    const a = crypto.encrypt('sk-or-v1-same')
    const b = crypto.encrypt('sk-or-v1-same')
    expect(a.equals(b)).toBe(false)
  })

  it('fails to decrypt with a different secret', () => {
    const encrypted = createKeyCrypto('secret-a').encrypt('sk-or-v1-abc')
    expect(() => createKeyCrypto('secret-b').decrypt(encrypted)).toThrow()
  })

  it('fails to decrypt tampered ciphertext', () => {
    const crypto = createKeyCrypto('test-secret')
    const encrypted = crypto.encrypt('sk-or-v1-abc')
    encrypted[encrypted.length - 1] ^= 0xff
    expect(() => crypto.decrypt(encrypted)).toThrow()
  })

  it('rejects an empty secret', () => {
    expect(() => createKeyCrypto('')).toThrow()
  })
})
