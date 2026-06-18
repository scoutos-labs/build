import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb, migrate, type Db } from './db.js'
import { createKeyCrypto } from './key-crypto.js'

const keyCrypto = createKeyCrypto('test-secret')

let db: Db

beforeEach(async () => {
  const pglite = new PGlite() // in-memory
  await migrate(pglite)
  db = createDb(pglite)
})

const user = {
  clerkUserId: 'user_1',
  orKeyHash: 'hash-1',
  orKeyEnc: keyCrypto.encrypt('sk-or-v1-secret-key'),
  tier: 'free',
  model: 'anthropic/claude-3.5-haiku',
}

describe('createDb (against real PGlite)', () => {
  it('insert + get round-trips, and the encrypted key decrypts back', async () => {
    await db.insertUser(user)
    const row = await db.getUser('user_1')
    expect(row?.tier).toBe('free')
    expect(row?.or_key_hash).toBe('hash-1')
    expect(row?.disabled).toBe(false)
    expect(row?.created_at).toBeInstanceOf(Date)
    expect(keyCrypto.decrypt(row!.or_key_enc)).toBe('sk-or-v1-secret-key')
  })

  it('stored or_key_enc is not the plaintext key', async () => {
    await db.insertUser(user)
    const row = await db.getUser('user_1')
    expect(row!.or_key_enc.toString('latin1')).not.toContain('sk-or-')
  })

  it('insertUser is idempotent: second insert returns the existing row', async () => {
    const first = await db.insertUser(user)
    const second = await db.insertUser({
      ...user,
      orKeyHash: 'hash-other',
      orKeyEnc: keyCrypto.encrypt('sk-or-v1-other'),
    })
    expect(second.or_key_hash).toBe(first.or_key_hash)
    expect(keyCrypto.decrypt(second.or_key_enc)).toBe('sk-or-v1-secret-key')
  })

  it('getUser returns null for unknown users', async () => {
    expect(await db.getUser('nope')).toBeNull()
  })

  it('setDisabled, updateTier, and deleteUser mutate the row', async () => {
    await db.insertUser(user)

    await db.setDisabled('user_1', true)
    expect((await db.getUser('user_1'))?.disabled).toBe(true)

    await db.updateTier('user_1', 'pro', 'anthropic/claude-3.5-sonnet')
    const upgraded = await db.getUser('user_1')
    expect(upgraded?.tier).toBe('pro')
    expect(upgraded?.model).toBe('anthropic/claude-3.5-sonnet')

    await db.deleteUser('user_1')
    expect(await db.getUser('user_1')).toBeNull()
  })
})
