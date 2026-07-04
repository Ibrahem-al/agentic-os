import type { PreloadApi } from './index'

declare global {
  interface Window {
    agenticOS: PreloadApi
  }
}

export {}
