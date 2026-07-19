/**
 * Cron helpers for the Automations builder (phase 31) — pure, DOM-free, and
 * unit-tested. The dashboard offers three friendly schedule presets (hourly /
 * daily-at / weekly-on) plus a Custom raw-cron escape hatch; these round-trip a
 * cron string to a preset and back, and render any trigger as a plain sentence.
 *
 * Grammar: standard 5-field cron `min hour dom month dow` in LOCAL time, the
 * same croner accepts on the main side (the source of truth is the backend's
 * validation — this is only for the friendly UI).
 */

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

export type CronPreset =
  | { readonly kind: 'hourly' }
  | { readonly kind: 'daily'; readonly hour: number; readonly minute: number }
  | { readonly kind: 'weekly'; readonly hour: number; readonly minute: number; readonly dayOfWeek: number }
  | { readonly kind: 'custom' }

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Build a cron string from a friendly preset (never called for 'custom'). */
export function buildCron(preset: Exclude<CronPreset, { kind: 'custom' }>): string {
  if (preset.kind === 'hourly') return '0 * * * *'
  if (preset.kind === 'daily') return `${preset.minute} ${preset.hour} * * *`
  return `${preset.minute} ${preset.hour} * * ${preset.dayOfWeek}`
}

/** Reverse-map a cron string onto a preset, or {kind:'custom'} if it fits none. */
export function matchCronPreset(cron: string): CronPreset {
  const trimmed = cron.trim()
  if (trimmed === '0 * * * *') return { kind: 'hourly' }
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(trimmed)
  if (daily !== null) {
    const minute = Number(daily[1])
    const hour = Number(daily[2])
    if (minute <= 59 && hour <= 23) return { kind: 'daily', hour, minute }
  }
  const weekly = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/.exec(trimmed)
  if (weekly !== null) {
    const minute = Number(weekly[1])
    const hour = Number(weekly[2])
    const dayOfWeek = Number(weekly[3])
    if (minute <= 59 && hour <= 23) return { kind: 'weekly', hour, minute, dayOfWeek }
  }
  return { kind: 'custom' }
}

/** A cron string as a plain sentence ("Every day at 09:00"), else the raw expr. */
export function describeCron(cron: string): string {
  const preset = matchCronPreset(cron)
  switch (preset.kind) {
    case 'hourly':
      return 'Every hour'
    case 'daily':
      return `Every day at ${pad2(preset.hour)}:${pad2(preset.minute)}`
    case 'weekly':
      return `Every ${WEEKDAY_NAMES[preset.dayOfWeek] ?? '?'} at ${pad2(preset.hour)}:${pad2(preset.minute)}`
    default:
      return `On schedule ${cron}`
  }
}

export type TriggerLike =
  | { readonly type: 'schedule'; readonly cron: string }
  | { readonly type: 'watch'; readonly path: string }
  | { readonly type: 'watch'; readonly url: string; readonly intervalMin: number }

/** A trigger as a plain sentence for the automations table. */
export function describeTrigger(trigger: TriggerLike): string {
  if (trigger.type === 'schedule') return describeCron(trigger.cron)
  if ('path' in trigger) return `When ${trigger.path} changes`
  return `When ${trigger.url} changes (checked every ${trigger.intervalMin} min)`
}
