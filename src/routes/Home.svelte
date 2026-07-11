<script lang="ts">
  import { authUser } from '../lib/stores/auth.svelte'
  import { logout } from '../lib/api/auth'
  import { clearAuthUser } from '../lib/stores/auth.svelte'
  import { getHealth } from '../lib/api/health'
  import { listLogs } from '../lib/api/logs'
  import { errorMessage, parseApiError } from '../lib/utils/errors'
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

  // Recent logs — the reference AUTHENTICATED resource. Same load-outside-$effect
  // discipline; the {#await} block below renders loading / empty / list, and the
  // catch distinguishes a 403 (authorised-but-forbidden — no redirect) from a
  // generic error.
  function loadLogs() {
    return listLogs()
  }
  let logsPromise = $state(loadLogs())

  function refreshLogs() {
    logsPromise = loadLogs()
  }

  /** A 403 means "signed in but not authorised" — render in place, never redirect. */
  function isForbidden(error: unknown): boolean {
    return parseApiError(error).error === 'forbidden'
  }

  let modalOpen = $state(false)

  async function handleLogout() {
    // If logout() started a full-page end_session navigation it returns true;
    // do NOT clearAuthUser() then, or the guard/401-login seam re-arms and its
    // competing navigation cancels the end_session redirect (fix 7). On a 204
    // (no end_session) logout returns false and we clear the store here.
    const navigatedAway = await logout()
    if (!navigatedAway) clearAuthUser()
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

  {#if user}
    <!-- Reference AUTHENTICATED resource. In bff mode this rides the session
         cookie through the BFF, which attaches the bearer server-side. -->
    <div class="card">
      <div class="card__head">
        <h2>Recent logs</h2>
        <button type="button" onclick={refreshLogs}>Refresh</button>
      </div>
      {#await logsPromise}
        <p>Loading logs…</p>
      {:then response}
        {#if response.logs.length === 0}
          <p class="logs-empty">No logs yet.</p>
        {:else}
          <ul class="logs">
            {#each response.logs as entry (entry.id)}
              <li>
                <time datetime={entry.date_and_time}>{entry.date_and_time}</time>
                <span>{entry.log}</span>
              </li>
            {/each}
          </ul>
        {/if}
      {:catch error}
        {#if isForbidden(error)}
          <p class="logs-forbidden">You’re signed in, but not authorised to view logs.</p>
        {:else}
          <p class="logs-error">Could not load logs: {errorMessage(error)}</p>
        {/if}
      {/await}
    </div>
  {/if}

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

  .logs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .logs li {
    display: flex;
    gap: 0.75rem;
    align-items: baseline;
  }

  .logs time {
    color: var(--text-secondary);
    font-size: 0.85em;
    white-space: nowrap;
  }

  .logs-empty {
    color: var(--text-secondary);
  }

  .logs-forbidden {
    color: var(--danger);
  }

  .logs-error {
    color: var(--danger);
  }
</style>
