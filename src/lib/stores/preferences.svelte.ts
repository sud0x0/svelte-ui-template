// User preferences — runes, persisted through a thin typed wrapper.
//
// Unlike auth state, preferences are NON-sensitive and SHOULD survive reload, so
// persisting them to localStorage is fine. The rule is the inverse for session
// material: tokens never touch Web Storage. (.claude/rules/security.md)

export type Theme = 'light' | 'dark'

const THEME_KEY = 'svelte-ui-template:theme'

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // localStorage unavailable — fall back to the system preference.
  }
  return systemPrefersDark() ? 'dark' : 'light'
}

function persistTheme(value: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, value)
  } catch {
    // ignore — preference simply won't survive reload
  }
}

let theme = $state<Theme>(loadTheme())

export function currentTheme(): Theme {
  return theme
}

export function setTheme(value: Theme): void {
  theme = value
  persistTheme(value)
}

export function toggleTheme(): void {
  setTheme(theme === 'dark' ? 'light' : 'dark')
}
