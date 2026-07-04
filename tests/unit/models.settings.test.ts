/**
 * Model-settings unit tests: defaults, round-trip, validation, and the
 * active-provider/model resolution the cloud tier uses (§4).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  activeCloudModel,
  defaultModelSettings,
  loadModelSettings,
  saveModelSettings,
  settingsPath
} from '../../src/main/models'

let dir: string
let filePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentic-os-settings-'))
  filePath = join(dir, 'settings.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('model settings', () => {
  it('defaults to anthropic with no overrides when the file is missing', () => {
    const settings = loadModelSettings(filePath)
    expect(settings).toEqual({ cloudProvider: 'anthropic', cloudModels: {} })
    expect(activeCloudModel(settings)).toBe('claude-opus-4-8')
  })

  it('round-trips through save/load', () => {
    const settings = defaultModelSettings()
    settings.cloudProvider = 'openrouter'
    settings.cloudModels = { openrouter: 'anthropic/claude-opus-4.8', gemini: 'gemini-2.5-flash' }
    settings.smallLlmModel = 'qwen3:8b'
    saveModelSettings(filePath, settings)
    expect(loadModelSettings(filePath)).toEqual(settings)
  })

  it('activeCloudModel prefers the per-provider override, else the config default', () => {
    const settings = defaultModelSettings()
    settings.cloudProvider = 'gemini'
    expect(activeCloudModel(settings)).toBe('gemini-2.5-pro')
    settings.cloudModels = { gemini: 'gemini-2.5-flash' }
    expect(activeCloudModel(settings)).toBe('gemini-2.5-flash')
  })

  it('rejects unknown providers and malformed shapes loudly', () => {
    writeFileSync(filePath, JSON.stringify({ cloudProvider: 'skynet' }))
    expect(() => loadModelSettings(filePath)).toThrow(/unknown cloudProvider 'skynet'/)
    writeFileSync(filePath, JSON.stringify({ cloudModels: { skynet: 'model' } }))
    expect(() => loadModelSettings(filePath)).toThrow(/invalid entry 'skynet'/)
    writeFileSync(filePath, '[]')
    expect(() => loadModelSettings(filePath)).toThrow(/not a JSON object/)
  })

  it('API keys have no home here — the file is plain JSON settings only', () => {
    saveModelSettings(filePath, defaultModelSettings())
    const raw = readFileSync(filePath, 'utf8')
    expect(raw).not.toMatch(/apiKey|token|secret/i)
  })

  it('settingsPath resolves inside userData', () => {
    expect(settingsPath('C:/data')).toContain('settings.json')
  })
})
