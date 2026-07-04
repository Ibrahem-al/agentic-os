import { contextBridge } from 'electron'

/**
 * Typed IPC bridge (spec §21 rule 8: renderer has no Node access; all
 * privileged work crosses this contract). Phase 00 exposes version info only —
 * real channels arrive with their phases.
 */
const api = {
  appVersion: process.env['npm_package_version'] ?? '0.0.1',
  platform: process.platform
} as const

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('agenticOS', api)
