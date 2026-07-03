<script lang="ts">
  // Wraps Modal so a test can supply snippet children (which can't be passed as
  // a plain prop) and drive the `open` prop via rerender.
  import Modal from '../../../src/lib/components/ui/Modal.svelte'

  interface Props {
    open: boolean
    onclose?: () => void
  }

  let { open, onclose }: Props = $props()
</script>

<Modal {open} title="Test Modal" {onclose}>
  <p data-testid="modal-body">Body content</p>
</Modal>
