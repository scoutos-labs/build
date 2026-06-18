// One-off: re-point existing user rows at their tier's current model.
// Stop the server first (PGlite holds an exclusive lock on the data dir).
// Usage: npx tsx scripts/set-user-model.ts
import { PGlite } from '@electric-sql/pglite'
import { tierConfig } from '../src/tiers'

const pglite = new PGlite(process.env.PGLITE_DATA_DIR ?? '.data')
const users = await pglite.query<{ clerk_user_id: string; tier: string; model: string }>(
  'select clerk_user_id, tier, model from users',
)
for (const user of users.rows) {
  const target = tierConfig(user.tier).model
  if (user.model !== target) {
    await pglite.query('update users set model = $2 where clerk_user_id = $1', [
      user.clerk_user_id,
      target,
    ])
    console.log(`${user.clerk_user_id}: ${user.model} -> ${target}`)
  }
}
await pglite.close()
