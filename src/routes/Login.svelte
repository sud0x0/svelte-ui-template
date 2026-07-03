<script lang="ts">
  import { config } from '../lib/config'
  import { login } from '../lib/api/auth'
  import { navigate } from '../lib/stores/router.svelte'

  // The landing that would start a login. In bff mode the button hands off to
  // the BFF /auth/login; in disabled mode it is a documented no-op, so we just
  // bounce to Home (which renders as the dev user).
  function handleSignIn() {
    if (config.authMode === 'bff') {
      login('/')
    } else {
      navigate('/')
    }
  }
</script>

<section class="login">
  <h1>Sign in</h1>

  {#if config.authMode === 'bff'}
    <p>You'll be redirected to your identity provider via the backend.</p>
  {:else}
    <p class="login__note">
      Auth is <strong>disabled</strong> in this template. There is no real login — the app runs as a
      local dev user. Flip <code>VITE_AUTH_MODE=bff</code> to wire the OIDC/BFF flow.
    </p>
  {/if}

  <button type="button" onclick={handleSignIn}>
    {config.authMode === 'bff' ? 'Continue to sign in' : 'Enter (dev user)'}
  </button>
</section>

<style>
  .login {
    max-width: 480px;
    margin: 4rem auto;
    padding: 0 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    text-align: center;
  }

  .login__note {
    color: var(--text-secondary);
  }
</style>
