import { beforeEach, describe, expect, it } from 'vitest'
import { currentTheme, setTheme, toggleTheme } from '../../src/lib/stores/preferences.svelte'

describe('preferences (theme)', () => {
  beforeEach(() => localStorage.clear())

  it('sets, reads, and persists the theme', () => {
    setTheme('dark')
    expect(currentTheme()).toBe('dark')
    expect(localStorage.getItem('svelte-ui-template:theme')).toBe('dark')
  })

  it('toggles between light and dark', () => {
    setTheme('light')
    toggleTheme()
    expect(currentTheme()).toBe('dark')
    toggleTheme()
    expect(currentTheme()).toBe('light')
  })
})
