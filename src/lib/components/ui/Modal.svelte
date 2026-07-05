<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    open: boolean
    title?: string
    onclose?: () => void
    children: Snippet
  }

  let { open, title, onclose, children }: Props = $props()

  // Unique per-instance id so two modals on one page don't share `modal-title`
  // (a duplicate id breaks aria-labelledby — the AT would resolve the wrong
  // heading). $props.id() is Svelte's stable, SSR-safe per-instance id; it must
  // be a direct variable-declaration initializer, hence the separate derive.
  const uid = $props.id()
  const titleId = `${uid}-title`

  let dialog = $state<HTMLDialogElement>()

  // Drive the native <dialog> from the `open` prop. <dialog> has its own
  // open/closed state and showModal() throws if called on an already-open
  // dialog (and close() on a closed one), so guard with `dialog.open`.
  $effect(() => {
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  })

  // Fires for both Escape and explicit dialog.close() — bubble up so the parent
  // can clear its `open` flag and stay in sync.
  function handleClose() {
    onclose?.()
  }

  // A click on the backdrop is a click on the <dialog> element itself (outside
  // .modal-content). A click inside the content stops here.
  function handleBackdropClick(event: MouseEvent) {
    if (event.target === dialog) onclose?.()
  }
</script>

<dialog
  bind:this={dialog}
  class="modal"
  aria-labelledby={title ? titleId : undefined}
  onclose={handleClose}
  onclick={handleBackdropClick}
>
  <div class="modal-content">
    {#if title}
      <header class="modal-header">
        <h2 id={titleId}>{title}</h2>
        {#if onclose}
          <button type="button" class="modal-close" onclick={onclose} aria-label="Close">
            &times;
          </button>
        {/if}
      </header>
    {/if}
    {@render children()}
  </div>
</dialog>

<style>
  .modal {
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
    max-width: 90vw;
    max-height: 90vh;
    overflow: auto;
    min-width: 320px;
    padding: 0;
  }

  .modal::backdrop {
    background: rgba(0, 0, 0, 0.5);
  }

  .modal-content {
    padding: 1.5rem;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }

  .modal-header h2 {
    font-size: 1.125rem;
    font-weight: 600;
    margin: 0;
  }

  .modal-close {
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
    color: var(--text-secondary);
    line-height: 1;
  }
</style>
