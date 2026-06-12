export type UserRow = {
  clerk_user_id: string
  or_key_hash: string
  or_key_enc: Buffer
  tier: string
  model: string
  disabled: boolean
  created_at: Date
}

/**
 * Minimal query surface — PGlite satisfies this directly. Kept narrow so the
 * store could swap back to pg.Pool (same shape) without touching callers.
 */
export type Queryable = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

export type Db = {
  getUser(clerkUserId: string): Promise<UserRow | null>
  insertUser(row: {
    clerkUserId: string
    orKeyHash: string
    orKeyEnc: Buffer
    tier: string
    model: string
  }): Promise<UserRow>
  setDisabled(clerkUserId: string, disabled: boolean): Promise<void>
  deleteUser(clerkUserId: string): Promise<void>
  updateTier(clerkUserId: string, tier: string, model: string): Promise<void>
  /** User-supplied provider keys (e.g. ScoutOS), encrypted at rest. Write-only:
   * stored ciphertext is decrypted only inside the publish handler. */
  upsertCredential(clerkUserId: string, provider: string, keyEnc: Buffer): Promise<void>
  getCredential(clerkUserId: string, provider: string): Promise<Buffer | null>
  deleteCredential(clerkUserId: string, provider: string): Promise<void>
}

// One statement per entry: PGlite's query() rejects multi-statement strings.
export const MIGRATION_STATEMENTS = [
  `create table if not exists users (
  clerk_user_id text primary key,
  or_key_hash   text not null,
  or_key_enc    bytea not null,
  tier          text not null default 'free',
  model         text not null,
  disabled      boolean not null default false,
  created_at    timestamptz not null default now()
)`,
  `create table if not exists user_credentials (
  clerk_user_id text not null,
  provider      text not null,
  key_enc       bytea not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (clerk_user_id, provider)
)`,
]

export async function migrate(queryable: Queryable): Promise<void> {
  for (const statement of MIGRATION_STATEMENTS) {
    await queryable.query(statement)
  }
}

type RawUserRow = Omit<UserRow, 'or_key_enc'> & { or_key_enc: Uint8Array }

// bytea comes back as Uint8Array from PGlite; normalize to Buffer for crypto.
function toUserRow(raw: RawUserRow): UserRow {
  return { ...raw, or_key_enc: Buffer.from(raw.or_key_enc) }
}

export function createDb(queryable: Queryable): Db {
  return {
    async getUser(clerkUserId) {
      const result = await queryable.query<RawUserRow>(
        'select * from users where clerk_user_id = $1',
        [clerkUserId],
      )
      const raw = result.rows[0]
      return raw ? toUserRow(raw) : null
    },

    async insertUser({ clerkUserId, orKeyHash, orKeyEnc, tier, model }) {
      // Idempotent for webhook redelivery and webhook/lazy-provision races:
      // the first writer wins, later writers get the existing row back.
      const result = await queryable.query<RawUserRow>(
        `insert into users (clerk_user_id, or_key_hash, or_key_enc, tier, model)
         values ($1, $2, $3, $4, $5)
         on conflict (clerk_user_id) do nothing
         returning *`,
        [clerkUserId, orKeyHash, orKeyEnc, tier, model],
      )
      if (result.rows[0]) return toUserRow(result.rows[0])
      const existing = await queryable.query<RawUserRow>(
        'select * from users where clerk_user_id = $1',
        [clerkUserId],
      )
      const raw = existing.rows[0]
      if (!raw) throw new Error(`User ${clerkUserId} vanished during insert`)
      return toUserRow(raw)
    },

    async setDisabled(clerkUserId, disabled) {
      await queryable.query('update users set disabled = $2 where clerk_user_id = $1', [
        clerkUserId,
        disabled,
      ])
    },

    async deleteUser(clerkUserId) {
      await queryable.query('delete from users where clerk_user_id = $1', [clerkUserId])
    },

    async updateTier(clerkUserId, tier, model) {
      await queryable.query('update users set tier = $2, model = $3 where clerk_user_id = $1', [
        clerkUserId,
        tier,
        model,
      ])
    },

    async upsertCredential(clerkUserId, provider, keyEnc) {
      await queryable.query(
        `insert into user_credentials (clerk_user_id, provider, key_enc)
         values ($1, $2, $3)
         on conflict (clerk_user_id, provider)
         do update set key_enc = excluded.key_enc, updated_at = now()`,
        [clerkUserId, provider, keyEnc],
      )
    },

    async getCredential(clerkUserId, provider) {
      const result = await queryable.query<{ key_enc: Uint8Array }>(
        'select key_enc from user_credentials where clerk_user_id = $1 and provider = $2',
        [clerkUserId, provider],
      )
      const raw = result.rows[0]
      return raw ? Buffer.from(raw.key_enc) : null
    },

    async deleteCredential(clerkUserId, provider) {
      await queryable.query(
        'delete from user_credentials where clerk_user_id = $1 and provider = $2',
        [clerkUserId, provider],
      )
    },
  }
}
