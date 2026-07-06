/**
 * Keychain unit tests — a fake SafeStorageLike proves the class logic
 * (round-trip, encrypted-at-rest, atomicity, bearer-token idempotence). The
 * REAL Electron safeStorage path is exercised by
 * scripts/ci/electron-keychain-check.cjs, which runs the same class inside an
 * actual Electron main process.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Keychain,
  KeychainError,
  MCP_BEARER_TOKEN_SECRET,
  RUNNER_TOKEN_SECRET,
  apiKeySecretName,
  type SafeStorageLike
} from '../../src/main/models'

const MAGIC = Buffer.from('FAKEENCv1:')

/** Deterministic XOR "encryption" — enough to prove plaintext never lands on disk. */
const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => {
    const bytes = Buffer.from(plainText, 'utf8')
    for (let i = 0; i < bytes.length; i++) bytes[i] = bytes[i]! ^ 0x5a
    return Buffer.concat([MAGIC, bytes])
  },
  decryptString: (encrypted) => {
    if (!encrypted.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not encrypted by this fake')
    const bytes = Buffer.from(encrypted.subarray(MAGIC.length))
    for (let i = 0; i < bytes.length; i++) bytes[i] = bytes[i]! ^ 0x5a
    return bytes.toString('utf8')
  }
}

const PLAINTEXT_KEY = 'sk-ant-super-secret-canary-98765'

let dir: string
let filePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-keychain-'))
  filePath = join(dir, 'keychain.bin')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function openKeychain(): Keychain {
  return new Keychain({ filePath, safeStorage: fakeSafeStorage })
}

describe('keychain', () => {
  it('round-trips API keys through safeStorage, across instances', () => {
    const keychain = openKeychain()
    keychain.setApiKey('anthropic', PLAINTEXT_KEY)
    keychain.setSecret('apiKey.openai', 'sk-openai-other')
    expect(keychain.getApiKey('anthropic')).toBe(PLAINTEXT_KEY)

    // A brand-new instance reads the persisted, decrypted state.
    const reloaded = openKeychain()
    expect(reloaded.getApiKey('anthropic')).toBe(PLAINTEXT_KEY)
    expect(reloaded.getSecret('apiKey.openai')).toBe('sk-openai-other')
    expect(reloaded.listSecretNames()).toEqual(['apiKey.anthropic', 'apiKey.openai'])
  })

  it('never writes plaintext to disk — file bytes contain neither values nor names', () => {
    openKeychain().setApiKey('anthropic', PLAINTEXT_KEY)
    const raw = readFileSync(filePath)
    expect(raw.includes(PLAINTEXT_KEY)).toBe(false)
    expect(raw.includes('apiKey')).toBe(false) // secret NAMES are inside the blob too
    expect(raw.includes('anthropic')).toBe(false)
    // …and no stray tmp file remains from the atomic write.
    expect(readdirSync(dir)).toEqual(['keychain.bin'])
  })

  it('deletes secrets and persists the deletion', () => {
    const keychain = openKeychain()
    keychain.setApiKey('gemini', 'g-key')
    expect(keychain.deleteSecret(apiKeySecretName('gemini'))).toBe(true)
    expect(keychain.deleteSecret(apiKeySecretName('gemini'))).toBe(false)
    expect(openKeychain().getApiKey('gemini')).toBeUndefined()
  })

  it('generates the MCP bearer token once (§20: auto-generated on first run)', () => {
    const keychain = openKeychain()
    const token = keychain.ensureMcpBearerToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/) // 32 random bytes, base64url
    expect(keychain.ensureMcpBearerToken()).toBe(token)
    expect(openKeychain().ensureMcpBearerToken()).toBe(token)
    expect(openKeychain().getSecret(MCP_BEARER_TOKEN_SECRET)).toBe(token)
  })

  it('ensureRunnerToken is get-or-create and persists across instances (phase 14)', () => {
    const keychain = openKeychain()
    const token = keychain.ensureRunnerToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/) // 32 random bytes, base64url
    expect(keychain.ensureRunnerToken()).toBe(token)
    expect(openKeychain().ensureRunnerToken()).toBe(token)
    expect(openKeychain().getSecret(RUNNER_TOKEN_SECRET)).toBe(token)
    // Distinct token family: never the MCP bearer token, never the hook token.
    expect(token).not.toBe(keychain.ensureMcpBearerToken())
    expect(token).not.toBe(keychain.ensureSessionEndHookToken())
  })

  it('rotateRunnerToken UNCONDITIONALLY replaces the token — the old value is dead (P0.3/§10.1)', () => {
    const keychain = openKeychain()
    const original = keychain.ensureRunnerToken()
    const rotated = keychain.rotateRunnerToken()
    expect(rotated).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(rotated).not.toBe(original) // never read-existing
    // The rotation persisted: every reader now sees ONLY the new value.
    expect(keychain.ensureRunnerToken()).toBe(rotated)
    expect(openKeychain().ensureRunnerToken()).toBe(rotated)
    expect(openKeychain().getSecret(RUNNER_TOKEN_SECRET)).toBe(rotated)
    // Rotating again keeps rotating (each boot mints a fresh generation).
    const again = keychain.rotateRunnerToken()
    expect(again).not.toBe(rotated)
    expect(openKeychain().getSecret(RUNNER_TOKEN_SECRET)).toBe(again)
  })

  it('rotateRunnerToken works on a keychain that never had a runner token (first boot)', () => {
    const keychain = openKeychain()
    const token = keychain.rotateRunnerToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(openKeychain().ensureRunnerToken()).toBe(token)
  })

  it('refuses to operate when OS encryption is unavailable (no plaintext fallback)', () => {
    const unavailable: SafeStorageLike = { ...fakeSafeStorage, isEncryptionAvailable: () => false }
    expect(() => new Keychain({ filePath, safeStorage: unavailable })).toThrow(KeychainError)
    expect(readdirSync(dir)).toEqual([]) // nothing written
  })

  it('rejects empty names/values', () => {
    const keychain = openKeychain()
    expect(() => keychain.setSecret('', 'v')).toThrow(KeychainError)
    expect(() => keychain.setSecret('name', '')).toThrow(KeychainError)
  })

  it('fails loudly on an undecryptable keychain file instead of silently resetting', () => {
    writeFileSync(filePath, 'garbage that is not ciphertext')
    expect(() => openKeychain()).toThrow(/cannot be decrypted/)
  })

  it('treats a missing or empty file as an empty keychain', () => {
    expect(openKeychain().listSecretNames()).toEqual([])
    writeFileSync(filePath, Buffer.alloc(0))
    expect(openKeychain().listSecretNames()).toEqual([])
  })
})
