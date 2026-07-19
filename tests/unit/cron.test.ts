/**
 * Cron helpers for the Automations builder (phase 31): build a cron from a
 * friendly preset, reverse-map a cron onto its preset (build→match round-trip),
 * and render a trigger as a plain sentence.
 */
import { describe, expect, it } from 'vitest'
import { buildCron, describeCron, describeTrigger, matchCronPreset } from '../../src/renderer/src/lib/cron'

describe('cron build / match', () => {
  it('builds the three presets', () => {
    expect(buildCron({ kind: 'hourly' })).toBe('0 * * * *')
    expect(buildCron({ kind: 'daily', hour: 9, minute: 5 })).toBe('5 9 * * *')
    expect(buildCron({ kind: 'weekly', hour: 3, minute: 30, dayOfWeek: 0 })).toBe('30 3 * * 0')
  })

  it('reverse-maps known crons and falls back to custom', () => {
    expect(matchCronPreset('0 * * * *')).toEqual({ kind: 'hourly' })
    expect(matchCronPreset('5 9 * * *')).toEqual({ kind: 'daily', hour: 9, minute: 5 })
    expect(matchCronPreset('30 3 * * 0')).toEqual({ kind: 'weekly', hour: 3, minute: 30, dayOfWeek: 0 })
    expect(matchCronPreset('*/5 * * * *')).toEqual({ kind: 'custom' })
    expect(matchCronPreset('99 9 * * *')).toEqual({ kind: 'custom' }) // out-of-range minute
    expect(matchCronPreset('0 24 * * *')).toEqual({ kind: 'custom' }) // out-of-range hour
  })

  it('round-trips build→match for every daily and weekly time', () => {
    for (const h of [0, 9, 23]) {
      for (const m of [0, 30, 59]) {
        expect(matchCronPreset(buildCron({ kind: 'daily', hour: h, minute: m }))).toEqual({ kind: 'daily', hour: h, minute: m })
        for (const d of [0, 3, 6]) {
          expect(matchCronPreset(buildCron({ kind: 'weekly', hour: h, minute: m, dayOfWeek: d }))).toEqual({
            kind: 'weekly',
            hour: h,
            minute: m,
            dayOfWeek: d
          })
        }
      }
    }
  })
})

describe('plain-language descriptions', () => {
  it('describes crons', () => {
    expect(describeCron('0 * * * *')).toBe('Every hour')
    expect(describeCron('5 9 * * *')).toBe('Every day at 09:05')
    expect(describeCron('30 3 * * 1')).toBe('Every Monday at 03:30')
    expect(describeCron('*/5 * * * *')).toBe('On schedule */5 * * * *')
  })

  it('describes triggers', () => {
    expect(describeTrigger({ type: 'schedule', cron: '0 9 * * *' })).toBe('Every day at 09:00')
    expect(describeTrigger({ type: 'watch', path: '/x/notes' })).toBe('When /x/notes changes')
    expect(describeTrigger({ type: 'watch', url: 'https://a.com', intervalMin: 30 })).toBe(
      'When https://a.com changes (checked every 30 min)'
    )
  })
})
