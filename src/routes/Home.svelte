<script lang="ts">
  import { authUser } from '../lib/stores/auth.svelte'
  import { logout } from '../lib/api/auth'
  import { clearAuthUser } from '../lib/stores/auth.svelte'
  import { getHealth } from '../lib/api/health'
  import { errorMessage } from '../lib/utils/errors'
  import Modal from '../lib/components/ui/Modal.svelte'

  // Data loading via an explicit load function — NOT inside $effect. Effects are
  // for synchronising with external systems; fetching in one double-fires and
  // lacks cancellation. The promise drives an {#await} block below.
  function loadHealth() {
    return getHealth()
  }
  let healthPromise = $state(loadHealth())

  function refreshHealth() {
    healthPromise = loadHealth()
  }

  let modalOpen = $state(false)

  async function handleLogout() {
    await logout()
    clearAuthUser()
  }

  const user = $derived(authUser())
</script>

<section class="home">
  <header class="home__header">
    <h1>Welcome{user ? `, ${user.displayName}` : ''}</h1>
    <button type="button" onclick={handleLogout}>Log out</button>
  </header>

  <p class="home__note">
    This view is wrapped in <code>&lt;RouteGuard&gt;</code>. With
    <code>VITE_AUTH_MODE=disabled</code> the guard is pass-through and renders using the local dev user
    above.
  </p>

  <!-- Reference resource: the unauthenticated /health endpoint, loaded outside
       $effect and surfaced via {#await}. -->
  <div class="card">
    <div class="card__head">
      <h2>Backend health</h2>
      <button type="button" onclick={refreshHealth}>Refresh</button>
    </div>
    {#await healthPromise}
      <p>Checking…</p>
    {:then health}
      <p class="health-ok">
        status: <strong>{health.status}</strong>{#if health.version}
          &middot; v{health.version}{/if}
      </p>
    {:catch error}
      <p class="health-error">Could not reach the backend: {errorMessage(error)}</p>
    {/await}
  </div>

  <div class="card">
    <h2>Modal demo</h2>
    <button type="button" onclick={() => (modalOpen = true)}>Open modal</button>
  </div>
</section>

<Modal open={modalOpen} title="Hello from Modal.svelte" onclose={() => (modalOpen = false)}>
  <p>
    Native <code>&lt;dialog&gt;</code>, driven by the <code>open</code> prop. Closes on backdrop click
    and Escape.
  </p>
</Modal>

<style>
  .home {
    max-width: 720px;
    margin: 0 auto;
    padding: 2rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .home__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .home__note {
    color: var(--text-secondary);
  }

  .card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.25rem;
    background: var(--bg-surface);
  }

  .card__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .health-ok {
    color: var(--accent);
  }

  .health-error {
    color: var(--danger);
  }
</style>
