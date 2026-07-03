<script lang="ts">
  import { currentPath, navigate } from '../lib/stores/router.svelte'

  const path = $derived(currentPath())
</script>

<section class="not-found">
  <h1>404</h1>
  <p>No route matches <code>{path}</code>.</p>
  <button type="button" onclick={() => navigate('/')}>Go home</button>
</section>

<style>
  .not-found {
    max-width: 480px;
    margin: 4rem auto;
    padding: 0 1rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
</style>
