import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import ModalHarness from './fixtures/ModalHarness.svelte'
import TwoModalsHarness from './fixtures/TwoModalsHarness.svelte'

describe('Modal', () => {
  it('renders snippet children when open and hides them when closed', async () => {
    const screen = render(ModalHarness, { open: true })
    await expect.element(page.getByTestId('modal-body')).toBeVisible()

    await screen.rerender({ open: false })
    await expect.element(page.getByTestId('modal-body')).not.toBeVisible()
  })

  it('calls onclose when the close button is clicked', async () => {
    const onclose = vi.fn()
    render(ModalHarness, { open: true, onclose })
    await userEvent.click(page.getByRole('button', { name: 'Close' }))
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('calls onclose on Escape', async () => {
    const onclose = vi.fn()
    render(ModalHarness, { open: true, onclose })
    await expect.element(page.getByTestId('modal-body')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    expect(onclose).toHaveBeenCalled()
  })

  it('gives each instance a distinct title id wired to aria-labelledby', () => {
    render(TwoModalsHarness)
    const headingA = page.getByRole('heading', { name: 'Modal A' }).element()
    const headingB = page.getByRole('heading', { name: 'Modal B' }).element()

    // Per-instance ids must differ (a shared `modal-title` would collide).
    expect(headingA.id).toBeTruthy()
    expect(headingB.id).toBeTruthy()
    expect(headingA.id).not.toBe(headingB.id)

    // Each <dialog> points aria-labelledby at its OWN heading.
    const dialogA = headingA.closest('dialog')
    const dialogB = headingB.closest('dialog')
    expect(dialogA?.getAttribute('aria-labelledby')).toBe(headingA.id)
    expect(dialogB?.getAttribute('aria-labelledby')).toBe(headingB.id)
  })
})
