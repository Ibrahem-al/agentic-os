import { clamp } from './util'

export interface WateringSchedule {
  zone: string
  startMinute: number
  durationMinutes: number
}

/**
 * Compute the next watering schedule for a zone from its average soil
 * moisture reading. Drier soil waters longer, capped at one hour.
 */
export function computeSchedule(zone: string, moisture: number): WateringSchedule {
  const durationMinutes = clamp(Math.round((1 - moisture) * 90), 5, 60)
  return { zone, startMinute: 360, durationMinutes }
}

export const toMinutes = (hours: number): number => hours * 60
