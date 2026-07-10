import { describe, expect, it, vi } from 'vitest'
import { bootUpdater, type UpdaterLike } from '../../src/main/updater'
import type { UpdaterStatusDto } from '../../src/shared/ipc'

/**
 * A fake electron-updater AppUpdater. `emit(event, payload)` drives the
 * lifecycle listeners bootUpdater registers; the call counters let the boot-path
 * tests assert exactly which check ran, and quitAndInstall is observable.
 */
function fakeUpdater(
  opts: {
    onCheckNotify?: () => Promise<unknown>
    onCheck?: () => Promise<unknown>
  } = {}
): UpdaterLike & {
  listeners: Map<string, (payload?: unknown) => void>
  emit(event: string, payload?: unknown): void
  checkNotifyCalls: number
  checkCalls: number
  quitAndInstallCalls: number
} {
  const listeners = new Map<string, (payload?: unknown) => void>()
  const fake = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkNotifyCalls: 0,
    checkCalls: 0,
    quitAndInstallCalls: 0,
    listeners,
    on(event: string, listener: (payload?: unknown) => void) {
      listeners.set(event, listener)
      return fake
    },
    emit(event: string, payload?: unknown) {
      listeners.get(event)?.(payload)
    },
    checkForUpdatesAndNotify() {
      fake.checkNotifyCalls += 1
      return opts.onCheckNotify ? opts.onCheckNotify() : Promise.resolve({ updateInfo: null })
    },
    checkForUpdates() {
      fake.checkCalls += 1
      return opts.onCheck ? opts.onCheck() : Promise.resolve({ updateInfo: null })
    },
    quitAndInstall() {
      fake.quitAndInstallCalls += 1
    }
  }
  return fake
}

describe('bootUpdater — boot behaviour (phase 13)', () => {
  it('dev build: logs, disables, and never touches the updater', () => {
    const updater = fakeUpdater()
    const log = vi.fn()
    const controller = bootUpdater({ isPackaged: false, updater, log })
    expect(log).toHaveBeenCalledWith('[updater] dev build — auto-update disabled')
    expect(controller.status().state).toBe('disabled')
    expect(updater.checkNotifyCalls).toBe(0)
    expect(updater.checkCalls).toBe(0)
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.listeners.size).toBe(0)
  })

  it('packaged build: configures background auto-update, checks once, and logs lifecycle', () => {
    const updater = fakeUpdater({ onCheckNotify: () => Promise.resolve({ updateInfo: null }) })
    const log = vi.fn()
    bootUpdater({ isPackaged: true, updater, log })
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.checkNotifyCalls).toBe(1)
    // The controller listens to the full lifecycle now (was error/available/downloaded).
    expect([...updater.listeners.keys()].sort()).toEqual([
      'checking-for-update',
      'download-progress',
      'error',
      'update-available',
      'update-downloaded',
      'update-not-available'
    ])
    updater.emit('update-available', { version: '9.9.9' })
    updater.emit('update-downloaded', { version: '9.9.9' })
    updater.emit('error', new Error('boom'))
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('[updater] update available: v9.9.9'))).toBe(true)
    expect(lines.some((l) => l.includes('[updater] update downloaded: v9.9.9') && l.includes('installs on quit'))).toBe(
      true
    )
    expect(lines.some((l) => l.includes('[updater] error: Error: boom'))).toBe(true)
    expect(lines.every((l) => l.startsWith('[updater] '))).toBe(true)
  })

  it('a rejected boot check is swallowed, logged, and lands in the error snapshot (private-repo feed today)', async () => {
    const updater = fakeUpdater({ onCheckNotify: () => Promise.reject(new Error('HttpError: 404')) })
    const log = vi.fn()
    const controller = bootUpdater({ isPackaged: true, updater, log })
    // Let the rejection propagate through the .catch handler.
    await new Promise((resolve) => setImmediate(resolve))
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('[updater] update check failed: Error: HttpError: 404'))).toBe(true)
    expect(controller.status()).toMatchObject({ state: 'error', error: 'HttpError: 404' })
  })
})

describe('bootUpdater — controller lifecycle (Settings "Updates")', () => {
  it('drives check → available → progress → downloaded, and installs only after downloaded', () => {
    const updater = fakeUpdater()
    const controller = bootUpdater({ isPackaged: true, updater })
    const seen: UpdaterStatusDto[] = []
    controller.onStatusChange((s) => seen.push({ ...s }))

    // Boot fired the background check once; no lifecycle event yet ⇒ still idle.
    expect(updater.checkNotifyCalls).toBe(1)
    expect(controller.status().state).toBe('idle')

    updater.emit('checking-for-update')
    expect(controller.status().state).toBe('checking')

    updater.emit('update-available', { version: '2.0.0' })
    expect(controller.status()).toMatchObject({ state: 'downloading', version: '2.0.0' })

    updater.emit('download-progress', { percent: 42.5, bytesPerSecond: 1_048_576, transferred: 500, total: 1_000 })
    expect(controller.status()).toMatchObject({
      state: 'downloading',
      version: '2.0.0',
      percent: 42.5,
      bytesPerSecond: 1_048_576,
      transferred: 500,
      total: 1_000
    })

    // quitAndInstall is a no-op before an update is actually downloaded.
    controller.quitAndInstall()
    expect(updater.quitAndInstallCalls).toBe(0)

    updater.emit('update-downloaded', { version: '2.0.0' })
    expect(controller.status()).toMatchObject({ state: 'downloaded', version: '2.0.0', percent: 100 })

    controller.quitAndInstall()
    expect(updater.quitAndInstallCalls).toBe(1)

    const states = seen.map((s) => s.state)
    expect(states).toContain('checking')
    expect(states).toContain('downloading')
    expect(states).toContain('downloaded')
  })

  it('up-to-date path: a manual check with no update reports up-to-date', async () => {
    const updater = fakeUpdater()
    const controller = bootUpdater({ isPackaged: true, updater })
    const pending = controller.check()
    // check() flips to checking synchronously before awaiting the updater.
    expect(controller.status().state).toBe('checking')
    updater.emit('update-not-available', { version: '1.4.2' })
    const snapshot = await pending
    expect(snapshot).toMatchObject({ state: 'up-to-date', version: '1.4.2' })
    expect(updater.checkCalls).toBe(1)
  })

  it('check() is a no-op while already checking or downloading', async () => {
    const updater = fakeUpdater()
    const controller = bootUpdater({ isPackaged: true, updater })
    updater.emit('update-available', { version: '3.0.0' }) // → downloading
    const snapshot = await controller.check()
    expect(snapshot).toMatchObject({ state: 'downloading', version: '3.0.0' })
    expect(updater.checkCalls).toBe(0) // no second check issued
  })

  it('error path: a rejected manual check lands in the snapshot and never throws', async () => {
    const updater = fakeUpdater({ onCheck: () => Promise.reject(new Error('ENOTFOUND github.com')) })
    const controller = bootUpdater({ isPackaged: true, updater })
    const snapshot = await controller.check()
    expect(snapshot.state).toBe('error')
    expect(snapshot.error).toContain('ENOTFOUND')
  })

  it('disabled (dev build): status is disabled with a detail; check/install are no-ops', async () => {
    const updater = fakeUpdater()
    const controller = bootUpdater({ isPackaged: false, updater })
    expect(controller.status()).toMatchObject({ state: 'disabled' })
    expect(controller.status().detail).toBeDefined()
    const snapshot = await controller.check()
    expect(snapshot.state).toBe('disabled')
    expect(updater.checkCalls).toBe(0)
    controller.quitAndInstall()
    expect(updater.quitAndInstallCalls).toBe(0)
  })

  it('unsubscribe stops further status notifications', () => {
    const updater = fakeUpdater()
    const controller = bootUpdater({ isPackaged: true, updater })
    const cb = vi.fn()
    const unsubscribe = controller.onStatusChange(cb)
    updater.emit('checking-for-update')
    expect(cb).toHaveBeenCalledTimes(1)
    unsubscribe()
    updater.emit('update-available', { version: '4.0.0' })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('throttles download-progress notifications to ~4/second (snapshot stays current)', () => {
    const updater = fakeUpdater()
    let clock = 10_000
    const controller = bootUpdater({ isPackaged: true, updater, now: () => clock })
    const percents: number[] = []
    controller.onStatusChange((s) => {
      if (s.state === 'downloading' && s.percent !== undefined) percents.push(s.percent)
    })

    updater.emit('update-available', { version: '5.0.0' }) // no percent ⇒ not counted below

    // 10 progress ticks inside one 250ms window: only the first pushes.
    for (let i = 1; i <= 10; i++) {
      updater.emit('download-progress', { percent: i * 5, bytesPerSecond: 1000 })
    }
    // Advance past the throttle window: the next tick pushes again.
    clock += 300
    updater.emit('download-progress', { percent: 99, bytesPerSecond: 1000 })

    expect(percents).toEqual([5, 99])
    // Even the throttled ticks updated the snapshot, so status() is current.
    expect(controller.status().percent).toBe(99)
  })
})
