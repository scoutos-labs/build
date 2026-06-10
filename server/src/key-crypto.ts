import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const IV_LENGTH = 12
const TAG_LENGTH = 16

export type KeyCrypto = {
  encrypt(plaintext: string): Buffer
  decrypt(ciphertext: Buffer): string
}

/**
 * AES-256-GCM for OpenRouter keys at rest. Layout: iv (12) | auth tag (16) | ciphertext.
 * The 256-bit key is derived from KEY_ENCRYPTION_SECRET so the env var can be
 * any high-entropy string rather than exactly 32 bytes.
 */
export function createKeyCrypto(secret: string): KeyCrypto {
  if (!secret) throw new Error('KEY_ENCRYPTION_SECRET must not be empty')
  const key = createHash('sha256').update(secret).digest()
  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_LENGTH)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    decrypt(ciphertext) {
      const iv = ciphertext.subarray(0, IV_LENGTH)
      const tag = ciphertext.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
      const encrypted = ciphertext.subarray(IV_LENGTH + TAG_LENGTH)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    },
  }
}
