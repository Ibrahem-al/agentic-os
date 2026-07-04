/**
 * Keychain — API keys + the MCP bearer token behind Electron `safeStorage`
 * (§14, §21 rule 7: secrets only via safeStorage, never plaintext on disk,
 * never in logs or traces).
 *
 * On-disk shape: `keychain.bin` in userData holds ONLY ciphertext — the
 * secrets map is JSON-serialized in memory, encrypted as one blob via
 * safeStorage (DPAPI / Keychain / kwallet+libsecret), and written with the
 * raw encrypted bytes. Secret *names* live inside the encrypted blob too, so
 * nothing about the contents is readable at rest. Writes are atomic
 * (tmp + rename) so a crash can never leave a torn (or half-plaintext) file.
 *
 * `SafeStorageLike` is injected: the Electron main process passes the real
 * `safeStorage`; unit tests pass a fake. The module itself never imports
 * `electron`, so it loads under plain-node vitest.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { CloudProvider } from '../config'

/** The subset of Electron's safeStorage the keychain uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** Well-known secret names (free-form names are also allowed). */
export type KnownSecretName = `apiKey.${CloudProvider}` | 'mcp.bearerToken'

export const MCP_BEARER_TOKEN_SECRET = 'mcp.bearerToken'

export function apiKeySecretName(provider: CloudProvider): KnownSecretName {
  return `apiKey.${provider}`
}

export const KEYCHAIN_FILENAME = 'keychain.bin'

export function keychainPath(userDataDir: string): string {
  return join(userDataDir, KEYCHAIN_FILENAME)
}

export class KeychainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeychainError'
  }
}

interface KeychainOptions {
  filePath: string
  safeStorage: SafeStorageLike
}

export class Keychain {
  private readonly filePath: string
  private readonly safeStorage: SafeStorageLike
  private secrets: Record<string, string>

  constructor(options: KeychainOptions) {
    this.filePath = options.filePath
    this.safeStorage = options.safeStorage
    if (!this.safeStorage.isEncryptionAvailable()) {
      // Never fall back to plaintext (§21 rule 7) — refuse to operate instead.
      throw new KeychainError(
        'OS-level encryption is unavailable (Electron safeStorage) — refusing to store secrets without it'
      )
    }
    this.secrets = this.load()
  }

  /** Secret names only — safe to show in the dashboard; values never leave via this. */
  listSecretNames(): string[] {
    return Object.keys(this.secrets).sort()
  }

  hasSecret(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.secrets, name)
  }

  getSecret(name: string): string | undefined {
    return this.secrets[name]
  }

  setSecret(name: string, value: string): void {
    if (!name) throw new KeychainError('secret name must be non-empty')
    if (!value) throw new KeychainError('secret value must be non-empty (use deleteSecret to remove)')
    this.secrets[name] = value
    this.persist()
  }

  deleteSecret(name: string): boolean {
    if (!this.hasSecret(name)) return false
    delete this.secrets[name]
    this.persist()
    return true
  }

  getApiKey(provider: CloudProvider): string | undefined {
    return this.getSecret(apiKeySecretName(provider))
  }

  setApiKey(provider: CloudProvider, key: string): void {
    this.setSecret(apiKeySecretName(provider), key)
  }

  /**
   * The MCP bearer token, auto-generated on first run (§20) — created here,
   * consumed by the MCP server in phase 05. Idempotent.
   */
  ensureMcpBearerToken(): string {
    const existing = this.getSecret(MCP_BEARER_TOKEN_SECRET)
    if (existing) return existing
    const token = randomBytes(32).toString('base64url')
    this.setSecret(MCP_BEARER_TOKEN_SECRET, token)
    return token
  }

  private load(): Record<string, string> {
    let encrypted: Buffer
    try {
      encrypted = readFileSync(this.filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw err
    }
    if (encrypted.length === 0) return {}
    let plaintext: string
    try {
      plaintext = this.safeStorage.decryptString(encrypted)
    } catch (err) {
      throw new KeychainError(
        `keychain at ${this.filePath} cannot be decrypted (corrupt file, or encrypted under a different OS user) — ` +
          `move it aside and re-enter API keys. Underlying error: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    const parsed: unknown = JSON.parse(plaintext)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new KeychainError(`keychain at ${this.filePath} decrypted to an unexpected shape`)
    }
    for (const value of Object.values(parsed)) {
      if (typeof value !== 'string') throw new KeychainError(`keychain at ${this.filePath} decrypted to an unexpected shape`)
    }
    return parsed as Record<string, string>
  }

  private persist(): void {
    const encrypted = this.safeStorage.encryptString(JSON.stringify(this.secrets))
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmpPath = `${this.filePath}.tmp`
    try {
      writeFileSync(tmpPath, encrypted)
      renameSync(tmpPath, this.filePath)
    } catch (err) {
      rmSync(tmpPath, { force: true })
      throw err
    }
  }
}
