<script lang="ts">
  import type { Snippet } from 'svelte'
  import { config } from '../../config'
  import { isAuthenticated, authStatus, loadCurrentUser } from '../../stores/auth.svelte'

  // The guard boundary. Wired into guarded routes today.
  //
  //  - disabled mode: pass-through. getCurrentUser() resolves the dev user, so
  //    children render. bff is a drop-in.
  //  - bff mode: loadCurrentUser() calls GET /auth/me through the API client. A
  //    401 there is handled by the client's centralised 401 -> login(returnTo)
  //    seam (lib/api/client.ts) — the SINGLE owner of that hand-off. The guard
  //    does NOT call login() itself; it only renders the "redirecting" state.
  //
  // Two failure states are DISTINCT (item 5): `unauthenticated` (a 401 — the
  // client fired the redirect, so "Redirecting…" is truthful) vs `error` (the
  // BFF/API is down — no redirect is coming, so show a real error + Retry, never
  // a fake "Redirecting…" that strands the user forever).

  interface Props {
    children: Snippet
  }

  let { children }: Props = $props()

  // Resolve the user on first mount. In disabled mode this yields the dev user;
  // in bff mode it calls GET /auth/me. On a 401 the client (not this guard)
  // fires login(returnTo) — see lib/api/client.ts. Keeping one owner avoids a
  // double login() hand-off.
  $effect(() => {
    if (authStatus() === 'idle') void loadCurrentUser()
  })
</script>

{#if isAuthenticated()}
  {@render children()}
{:else if config.authMode === 'bff' && authStatus() === 'unauthenticated'}
  <p class="route-guard__notice">Redirecting to sign in…</p>
{:else if authStatus() === 'error'}
  <div class="route-guard__notice route-guard__notice--error" role="alert">
    <p>Sorry, we couldn't reach the server. Please try again.</p>
    <button type="button" class="route-guard__retry" onclick={() => void loadCurrentUser()}>
      Retry
    </button>
  </div>
{:else}
  <p class="route-guard__notice">Loading…</p>
{/if}

<style>
  .route-guard__notice {
    padding: 2rem;
    color: var(--text-secondary);
    text-align: center;
  }

  .route-guard__retry {
    margin-top: 1rem;
    padding: 0.5rem 1rem;
    cursor: pointer;
    color: var(--text-primary);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
</style>
