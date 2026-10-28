import type { BeaconSettings } from './global'

export function applyTheme(s: BeaconSettings): void {
  const r = document.documentElement
  r.dataset['theme'] = s.theme
  r.dataset['glass'] = s.glass ? '1' : '0'
  r.dataset['contrast'] = s.highContrast ? '1' : '0'
  r.style.setProperty('--primary', s.accent)
}
