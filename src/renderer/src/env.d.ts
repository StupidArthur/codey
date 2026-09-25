import type { TemporalApi } from '../../shared/contracts'

declare global {
  interface Window {
    temporal: TemporalApi
  }
}

export {}
