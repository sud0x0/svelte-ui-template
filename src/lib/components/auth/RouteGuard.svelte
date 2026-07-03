<script lang="ts">
  import type { Snippet } from 'svelte'
  import { config } from '../../config'
  import { login } from '../../api/auth'
  import { isAuthenticated, authStatus, loadCurrentUser } from '../../stores/auth.svelte'

  // The guard boundary. Wired into guarded routes today.
  //
  //  - disabled mode: pass-through. getCurrentUser() resolves the dev user, so
  //    children render. The return-path plumbing still runs (a no-op) so bff is
  //    a drop-in.
  //  - bff mode: the stub below is where real 401 -> login enforcement goes. It
  //    captures the intended destination as returnTo before handing off.

  interface Props {
    children: Snippet
  }

  let { children }: Props = $props()

  // Resolve the user on first mount. In disabled mode this yields the dev user;
  // in bff mode it calls GET /auth/me.
  $effect(() => {
    if (authStatus() === 'idle') void loadCurrentUser()
  })

  // The path to come back to after a future login. Captured now even though
  // login() is a no-op in disabled mode.
  function returnTo(): string {
    return location.pathname + location.search
  }

  $effect(() => {
    // TODO(auth): real 401 -> login enforcement lives here. When the BFF /auth/me
    // call fails (401), capture the destination and hand off to GET /auth/login.
    // This branch only runs under VITE_AUTH_MODE='bff'; disabled mode never
    // reaches it because the dev user always resolves.
    if (config.authMode === 'bff' && authStatus() === 'error') {
      login(returnTo())
    }
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
