import { describe, expect, it, vi } from 'vitest'
import { bootUpdater, type UpdaterLike } from '../../src/main/updater'

function fakeUpdater(check: () => Promise<unknown>): UpdaterLike & {
  listeners: Map<string, (payload?: unknown) => void>
  checkCalls: number
} {
  const listeners = new Map<string, (payload?: unknown) => void>()
  const fake = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkCalls: 0,
    listeners,
    on(event: 'error' | 'update-available' | 'update-downloaded', listener: (payload?: unknown) => void) {
      listeners.set(event, listener)
      return fake
    },
    checkForUpdatesAndNotify() {
      fake.checkCalls += 1
      return check()
    }
  }
  return fake
}

describe('bootUpdater (phase 13)', () => {
  it('dev build: logs and never touches the updater', () => {
    const updater = fakeUpdater(() => Promise.resolve())
    const log = vi.fn()
    bootUpdater({ isPackaged: false, updater, log })
    expect(log).toHaveBeenCalledWith('[updater] dev build — auto-update disabled')
    expect(updater.checkCalls).toBe(0)
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.listeners.size).toBe(0)
  })

  it('packaged build: configures background auto-update and checks once', () => {
    const updater = fakeUpdater(() => Promise.resolve({ updateInfo: null }))
    const log = vi.fn()
    bootUpdater({ isPackaged: true, updater, log })
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.checkCalls).toBe(1)
    // Background cockpit: every lifecycle event only logs, never dialogs.
    expect([...updater.listeners.keys()].sort()).toEqual(['error', 'update-available', 'update-downloaded'])
    updater.listeners.get('update-available')?.({ version: '9.9.9' })
    updater.listeners.get('update-downloaded')?.({ version: '9.9.9' })
    updater.listeners.get('error')?.(new Error('boom'))
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('[updater] update available: v9.9.9'))).toBe(true)
    expect(lines.some((l) => l.includes('[updater] update downloaded: v9.9.9') && l.includes('installs on quit'))).toBe(true)
    expect(lines.some((l) => l.includes('[updater] error: Error: boom'))).toBe(true)
    expect(lines.every((l) => l.startsWith('[updater] '))).toBe(true)
  })

  it('a rejected update check is swallowed and logged (private-repo feed today)', async () => {
    const updater = fakeUpdater(() => Promise.reject(new Error('HttpError: 404')))
    const log = vi.fn()
    expect(() => bootUpdater({ isPackaged: true, updater, log })).not.toThrow()
    // Let the rejection propagate through the .catch handler.
    await new Promise((resolve) => setImmediate(resolve))
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('[updater] update check failed: Error: HttpError: 404'))).toBe(true)
  })
})
