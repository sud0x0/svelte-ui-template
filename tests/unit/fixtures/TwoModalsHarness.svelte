<script lang="ts">
  // Renders two Modal instances at once so a test can prove each gets a distinct
  // title id (a duplicate id would break aria-labelledby).
  import Modal from '../../../src/lib/components/ui/Modal.svelte'
</script>

<Modal open title="Modal A">
  <p data-testid="body-a">A body</p>
</Modal>
<Modal open title="Modal B">
  <p data-testid="body-b">B body</p>
</Modal>
