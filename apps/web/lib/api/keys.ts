import crypto from 'node:crypto'

const PREFIX = 'agora_'

/**
 * Generate a new raw API key.
 * Format: agora_<43 base64url chars> (32 bytes of entropy)
 * The raw key is returned ONCE and must never be stored.
 */
export function generateRawKey(): string {
  const bytes = crypto.randomBytes(32)
  const body  = bytes.toString('base64url') // URL-safe, no padding, 43 chars
  return `${PREFIX}${body}`
}

/**
 * Hash a raw key for storage or lookup.
 * Uses SHA-256 — fast enough for a per-request lookup, not brute-forceable
 * as a KDF because the key has 256 bits of entropy regardless.
 */
export function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex')
}

/**
 * Extract the display prefix (first 8 chars of the body, after "agora_").
 * Used to let consumers identify their key without exposing the secret.
 * e.g. "agora_Xk3mN8pQ..." → prefix stored = "Xk3mN8pQ"
 */
export function extractPrefix(rawKey: string): string {
  return rawKey.slice(PREFIX.length, PREFIX.length + 8)
}

/**
 * Validate the shape of an incoming key string without hitting the database.
 * Returns false for obviously malformed values, reducing unnecessary DB lookups.
 */
export function isWellFormed(rawKey: string): boolean {
  return (
    typeof rawKey === 'string' &&
    rawKey.startsWith(PREFIX) &&
    rawKey.length === PREFIX.length + 43 // 32 bytes → 43 base64url chars
  )
}
