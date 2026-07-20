import { describe, expect, it, vi } from 'vitest'
import { bootUpdater, quiesceForInstall, type UpdaterLike } from '../../src/main/updater'
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

  it('DTO additivity: installDeferred is an optional field spread onto a downloaded snapshot', () => {
    const downloaded: UpdaterStatusDto = { state: 'downloaded', percent: 100, version: '2.0.0' }
    const deferred: UpdaterStatusDto = { ...downloaded, installDeferred: true, detail: 'finishing a write' }
    // The existing 'downloaded' snapshot is unchanged when the field is absent…
    expect(downloaded.installDeferred).toBeUndefined()
    // …and additive when present (state stays 'downloaded' — the renderer switch is untouched).
    expect(deferred).toMatchObject({ state: 'downloaded', installDeferred: true, detail: 'finishing a write' })
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

describe('bootUpdater — release notes (patch notes)', () => {
  const boot = (): ReturnType<typeof fakeUpdater> => fakeUpdater()

  it('surfaces string release notes on update-available and update-downloaded', () => {
    const updater = boot()
    const controller = bootUpdater({ isPackaged: true, updater })
    updater.emit('update-available', { version: '2.0.0', releaseNotes: '- fixed a crash', releaseName: 'Big fixes' })
    expect(controller.status()).toMatchObject({ state: 'downloading', releaseNotes: '- fixed a crash', releaseName: 'Big fixes' })
    updater.emit('update-downloaded', { version: '2.0.0', releaseNotes: '- fixed a crash' })
    expect(controller.status().releaseNotes).toBe('- fixed a crash')
  })

  it('joins an Array of per-version notes newest-first and skips null-note entries', () => {
    const updater = boot()
    const controller = bootUpdater({ isPackaged: true, updater })
    updater.emit('update-available', {
      version: '2.0.0',
      releaseNotes: [
        { version: '2.0.0', note: 'two point oh' },
        { version: '1.9.0', note: null },
        { version: '1.8.0', note: 'one point eight' }
      ]
    })
    const notes = controller.status().releaseNotes ?? ''
    expect(notes).toContain('## 2.0.0')
    expect(notes).toContain('two point oh')
    expect(notes).toContain('## 1.8.0')
    expect(notes).toContain('one point eight')
    expect(notes).not.toContain('1.9.0') // the null-note version is dropped
  })

  it('strips HTML from a body (untrusted) — no angle brackets survive', () => {
    const updater = boot()
    const controller = bootUpdater({ isPackaged: true, updater })
    updater.emit('update-available', { version: '2.0.0', releaseNotes: '<p>Hello</p><script>bad()</script>' })
    const notes = controller.status().releaseNotes ?? ''
    expect(notes).toContain('Hello')
    expect(notes).not.toContain('<')
    expect(notes).not.toContain('>')
  })

  it('truncates an over-cap body with a trailing ellipsis', () => {
    const updater = boot()
    const controller = bootUpdater({ isPackaged: true, updater })
    updater.emit('update-available', { version: '2.0.0', releaseNotes: 'x'.repeat(10_001) })
    const notes = controller.status().releaseNotes ?? ''
    expect(notes.endsWith('…')).toBe(true)
    expect(notes.length).toBeLessThanOrEqual(10_010)
  })

  it('carries the notes across update-available → download-progress → update-downloaded', () => {
    const updater = boot()
    const controller = bootUpdater({ isPackaged: true, updater })
    updater.emit('update-available', { version: '2.0.0', releaseNotes: '- kept through download' })
    updater.emit('download-progress', { percent: 40, bytesPerSecond: 1000 }) // no notes in this payload
    expect(controller.status().releaseNotes).toBe('- kept through download')
    updater.emit('update-downloaded', { version: '2.0.0' }) // no notes in this payload either
    expect(controller.status()).toMatchObject({ state: 'downloaded', releaseNotes: '- kept through download' })
  })

  it('drops the notes once there is no pending update (up-to-date)', () => {
    const updater = boot()
    const controller = bootUpdater({ isPackaged: true, updater })
    updater.emit('update-available', { version: '2.0.0', releaseNotes: 'stale' })
    updater.emit('update-not-available', { version: '2.0.0' })
    expect(controller.status().releaseNotes).toBeUndefined()
  })

  it('omits the field for malformed / absent notes (never throws)', () => {
    const updater = boot()
    const controller = bootUpdater({ isPackaged: true, updater })
    for (const bad of [{ version: '1.0.0', releaseNotes: 42 }, { version: '1.0.0', releaseNotes: null }, { version: '1.0.0' }]) {
      updater.emit('update-available', bad)
      expect(controller.status().releaseNotes).toBeUndefined()
      expect(controller.status().version).toBe('1.0.0')
    }
  })
})

describe('quiesceForInstall — pre-install drain (§21.9 G5+G6)', () => {
  /**
   * A fake storage engine whose lane goes idle after `idleAfter` laneIdle()
   * probes, counting checkpoint() calls. A manual clock is driven by the fake
   * sleep (advances by pollMs each poll), so the bounded wait is deterministic.
   */
  function fakeEngine(opts: { idleAfter?: number; checkpointRejects?: boolean } = {}): {
    laneIdle(): boolean
    checkpoint(): Promise<void>
    checkpointCalls: number
  } {
    const idleAfter = opts.idleAfter ?? 0
    let probes = 0
    const engine = {
      checkpointCalls: 0,
      laneIdle(): boolean {
        return probes++ >= idleAfter
      },
      async checkpoint(): Promise<void> {
        engine.checkpointCalls += 1
        if (opts.checkpointRejects) throw new Error('checkpoint boom')
      }
    }
    return engine
  }

  function clock() {
    let t = 0
    return {
      now: () => t,
      sleep: (ms: number) => {
        t += ms
        return Promise.resolve()
      }
    }
  }

  it('idle immediately (nothing in flight): checkpoints and reports safe to install', async () => {
    const engine = fakeEngine({ idleAfter: 0 })
    const c = clock()
    const result = await quiesceForInstall({
      engine,
      queue: { runningTaskId: null },
      now: c.now,
      sleep: c.sleep
    })
    expect(result).toEqual({ idle: true, checkpointed: true })
    expect(engine.checkpointCalls).toBe(1)
  })

  it('busy then idle: waits for the queue task + lane to drain, then checkpoints', async () => {
    const engine = fakeEngine({ idleAfter: 3 }) // lane idle only on the 4th probe
    const c = clock()
    const result = await quiesceForInstall({
      engine,
      queue: { runningTaskId: null },
      pollMs: 200,
      timeoutMs: 30_000,
      now: c.now,
      sleep: c.sleep
    })
    expect(result).toEqual({ idle: true, checkpointed: true })
    expect(engine.checkpointCalls).toBe(1)
    expect(c.now()).toBe(600) // three 200ms polls before it drained
  })

  it('a running queue task keeps it busy: defers after the bound WITHOUT installing or checkpointing', async () => {
    const engine = fakeEngine({ idleAfter: 0 }) // lane is idle, but the QUEUE is not
    const c = clock()
    const result = await quiesceForInstall({
      engine,
      queue: { runningTaskId: 'task-in-flight' },
      pollMs: 200,
      timeoutMs: 1_000,
      now: c.now,
      sleep: c.sleep
    })
    expect(result).toEqual({ idle: false, checkpointed: false })
    // Deferred → the in-flight write is never interrupted and no checkpoint runs.
    expect(engine.checkpointCalls).toBe(0)
    expect(c.now()).toBe(1_000)
  })

  it('a busy write lane also defers even when the queue is idle', async () => {
    const engine = fakeEngine({ idleAfter: 999 }) // lane never idle within the bound
    const c = clock()
    const result = await quiesceForInstall({
      engine,
      queue: { runningTaskId: null },
      pollMs: 200,
      timeoutMs: 1_000,
      now: c.now,
      sleep: c.sleep
    })
    expect(result.idle).toBe(false)
    expect(engine.checkpointCalls).toBe(0)
  })

  it('a failed checkpoint is best-effort: still idle:true, never throws', async () => {
    const engine = fakeEngine({ idleAfter: 0, checkpointRejects: true })
    const log = vi.fn()
    const result = await quiesceForInstall({ engine, queue: null, log })
    expect(result).toEqual({ idle: true, checkpointed: false })
    expect(engine.checkpointCalls).toBe(1)
    expect(log.mock.calls.some((cc) => String(cc[0]).includes('pre-install checkpoint failed'))).toBe(true)
  })

  it('no engine wired (storage down): nothing to drain — idle:true, no checkpoint', async () => {
    const result = await quiesceForInstall({ engine: null, queue: null })
    expect(result).toEqual({ idle: true, checkpointed: false })
  })
})
