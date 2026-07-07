import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RESET_MARKER_FILENAME, UNINSTALL_BACKUP_DIRNAME } from '../../src/main/config'

/**
 * Structural text assertions that make the NSIS data-safety invariants
 * CI-enforced: a future edit to build/installer.nsh (or electron-builder.yml)
 * that drifts from an invariant fails here — cheap, hermetic, no makensis.
 */
const nsh = readFileSync(fileURLToPath(new URL('../../build/installer.nsh', import.meta.url)), 'utf8')
const yml = readFileSync(fileURLToPath(new URL('../../electron-builder.yml', import.meta.url)), 'utf8')

// NSIS INSTRUCTIONS only — full-line comments (starting with `;`) are stripped
// so the header, which deliberately NAMES the forbidden patterns to document
// them, cannot trip the "absence" assertions below.
const code = nsh
  .split(/\r?\n/)
  .filter((l) => !/^\s*;/.test(l))
  .join('\n')

// Actual `MessageBox` INSTRUCTIONS (comment lines already excluded above).
const messageBoxLines = code.split(/\r?\n/).filter((l) => /^\s*MessageBox\b/.test(l))

describe('installer.nsh data-safety invariants', () => {
  it('the already-installed prompt is a 3-way box that silently defaults to Update-keep-data', () => {
    const threeWay = messageBoxLines.find((l) => l.includes('MB_YESNOCANCEL'))
    expect(threeWay, 'a MB_YESNOCANCEL MessageBox').toBeDefined()
    expect(threeWay).toContain('/SD IDYES')
  })

  it('the reinstall-from-scratch confirm silently defaults to NO (/SD IDNO)', () => {
    expect(messageBoxLines.some((l) => l.includes('/SD IDNO'))).toBe(true)
  })

  it('the uninstall keep-vs-remove prompt silently defaults to KEEP (/SD IDYES)', () => {
    const keep = messageBoxLines.find((l) => l.includes('Keep your agentic-os data'))
    expect(keep, 'the keep-vs-remove MessageBox').toBeDefined()
    expect(keep).toContain('/SD IDYES')
  })

  it('EVERY MessageBox carries an /SD default (no dialog can hang a silent run)', () => {
    expect(messageBoxLines.length).toBeGreaterThanOrEqual(4)
    for (const line of messageBoxLines) {
      expect(line, `MessageBox missing /SD: ${line.trim()}`).toContain('/SD')
    }
  })

  it('the reset marker + uninstall-backup dir names match config.ts verbatim', () => {
    expect(code).toContain(RESET_MARKER_FILENAME)
    expect(code).toContain(UNINSTALL_BACKUP_DIRNAME)
  })

  it('never does an irreversible RMDir of user data, and never passes --delete-app-data', () => {
    expect(code).not.toMatch(/RMDir\s+\/r\s+"\$APPDATA/)
    expect(code).not.toContain('--delete-app-data')
  })

  it('the uninstall remove-data path is a Rename (move) into the backup dir', () => {
    expect(code).toMatch(/Rename\s+"\$APPDATA\\\$\{APP_FILENAME\}"\s+"\$APPDATA\\agentic-os-backups\\/)
  })
})

describe('electron-builder.yml data-safety invariants', () => {
  it('does not enable deleteAppDataOnUninstall (customUnInstall owns the choice)', () => {
    expect(yml).not.toMatch(/deleteAppDataOnUninstall:\s*true/)
  })
})
