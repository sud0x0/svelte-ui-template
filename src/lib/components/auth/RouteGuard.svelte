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
{:else if config.authMode === 'bff' && authStatus() === 'error'}
  <p class="route-guard__notice">Redirecting to sign in…</p>
{:else}
  <p class="route-guard__notice">Loading…</p>
{/if}

<style>
  .route-guard__notice {
    padding: 2rem;
    color: var(--text-secondary);
    text-align: center;
  }
</style>
