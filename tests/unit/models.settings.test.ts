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
  defaultReasoningSettings,
  defaultRunnerSettings,
  loadModelSettings,
  saveModelSettings,
  settingsPath
} from '../../src/main/models'
import { RUNNER_MODEL_DEFAULT } from '../../src/main/config'

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

// ── phase-16 reasoning + runner sections (§2.1/§11.4) ────────────────────────

describe('phase-16 reasoning + runner settings', () => {
  it('a default install materializes NEITHER section (DEFAULT == TODAY)', () => {
    // The prime directive: a fresh settings.json is byte-identical to pre-phase-16,
    // so the router reads "no reasoning config → today's per-role tiers".
    const settings = loadModelSettings(filePath)
    expect(settings.reasoning).toBeUndefined()
    expect(settings.runner).toBeUndefined()
    // The factory defaults exist for opt-in, and the runner default is DISABLED.
    expect(defaultReasoningSettings()).toEqual({ backend: 'local-qwen3' })
    expect(defaultRunnerSettings().enabled).toBe(false)
    expect(defaultRunnerSettings()).toEqual({
      enabled: false,
      model: RUNNER_MODEL_DEFAULT,
      stageAll: true,
      mode: 'completion',
      injectionPolicy: 'downgrade'
    })
  })

  it('round-trips both new sections through save/load losslessly', () => {
    const settings = defaultModelSettings()
    settings.reasoning = {
      backend: 'subscription-claude',
      overrides: { 'extraction.fuzzy': 'cloud-api', 'skills.grader': 'local-qwen3' },
      models: { 'context.summarize': 'qwen3:8b' }
    }
    settings.runner = {
      enabled: true,
      model: 'sonnet',
      stageAll: false,
      mode: 'agent',
      injectionPolicy: 'proceed',
      verifierModel: 'qwen3:4b',
      binaryPath: '/opt/claude'
    }
    saveModelSettings(filePath, settings)
    expect(loadModelSettings(filePath)).toEqual(settings)
  })

  it('normalizes a partial section on disk with the phase-doc defaults', () => {
    // Only `enabled` present → the rest fill from defaultRunnerSettings();
    // only `backend` present → reasoning has no overrides/models.
    writeFileSync(filePath, JSON.stringify({ runner: { enabled: true }, reasoning: { backend: 'subscription-claude' } }))
    const settings = loadModelSettings(filePath)
    expect(settings.runner).toEqual({ enabled: true, model: RUNNER_MODEL_DEFAULT, stageAll: true, mode: 'completion', injectionPolicy: 'downgrade' })
    expect(settings.reasoning).toEqual({ backend: 'subscription-claude' })
  })

  it('rejects invalid backend / mode / non-boolean values loudly', () => {
    writeFileSync(filePath, JSON.stringify({ reasoning: { backend: 'gpt-9000' } }))
    expect(() => loadModelSettings(filePath)).toThrow(/reasoning\.backend/)
    writeFileSync(filePath, JSON.stringify({ reasoning: { overrides: { 'skills.rewrite': 'nope' } } }))
    expect(() => loadModelSettings(filePath)).toThrow(/is not a valid backend/)
    writeFileSync(filePath, JSON.stringify({ runner: { enabled: 'yes' } }))
    expect(() => loadModelSettings(filePath)).toThrow(/runner\.enabled must be a boolean/)
    writeFileSync(filePath, JSON.stringify({ runner: { mode: 'telepathy' } }))
    expect(() => loadModelSettings(filePath)).toThrow(/runner\.mode/)
  })
})
