<script lang="ts">
  import { onMount } from 'svelte'
  import { currentTheme, toggleTheme } from './lib/stores/preferences.svelte'
  import {
    startRouter,
    navigate,
    routeComponent,
    isGuarded,
    routeError,
    currentPath,
  } from './lib/stores/router.svelte'
  import RouteGuard from './lib/components/auth/RouteGuard.svelte'

  // Theme via a single attribute on <html>; app.css maps it to CSS variables.
  // No per-component colour literals. (architecture rule: theming via variables)
  $effect(() => {
    document.documentElement.setAttribute('data-theme', currentTheme())
  })

  onMount(() => {
    startRouter()
  })

  // Intercept same-origin nav so the History router handles it (no full reload).
  function handleNav(event: MouseEvent, to: string) {
    // Never hijack a modified or non-primary click: Cmd/Ctrl/Shift/Alt-click and
    // middle-click are the browser's open-in-new-tab / new-window / download
    // affordances. Returning WITHOUT preventDefault lets the browser do its
    // thing. `defaultPrevented` guards against an upstream handler already
    // consuming the event.
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0 ||
      event.defaultPrevented
    ) {
      return
    }
    event.preventDefault()
    navigate(to)
  }

  const RouteComponent = $derived(routeComponent())
</script>

<a class="skip-link" href="#main">Skip to content</a>

<header class="topbar">
  <nav class="topbar__nav" aria-label="Primary">
    <a
      href="/"
      aria-current={currentPath() === '/' ? 'page' : undefined}
      onclick={(e) => handleNav(e, '/')}>Home</a
    >
    <a
      href="/login"
      aria-current={currentPath() === '/login' ? 'page' : undefined}
      onclick={(e) => handleNav(e, '/login')}>Login</a
    >
    <a
      href="/does-not-exist"
      aria-current={currentPath() === '/does-not-exist' ? 'page' : undefined}
      onclick={(e) => handleNav(e, '/does-not-exist')}>404 demo</a
    >
  </nav>
  <button type="button" class="topbar__theme" onclick={toggleTheme}>
    {currentTheme() === 'dark' ? '☀︎ Light' : '☾ Dark'}
  </button>
</header>

<!-- tabindex="-1" makes <main> programmatically focusable (not tab-reachable) so
     the router can move focus here after a client navigation without wiring a ref
     into every route. See router.svelte.ts applyNavFocus + BBC GEL routing. -->
<main id="main" class="content" tabindex="-1">
  <!-- Top-level error boundary: a render error in one route shows a fallback
       instead of blanking the whole app. -->
  <svelte:boundary>
    {#if routeError()}
      <p class="route-error">This page failed to load. Try another route.</p>
    {:else if RouteComponent}
      {#if isGuarded()}
        <RouteGuard>
          <RouteComponent />
        </RouteGuard>
      {:else}
        <RouteComponent />
      {/if}
    {:else}
      <p class="route-loading">Loading…</p>
    {/if}

    {#snippet failed(error, reset)}
      <div class="boundary-failed" role="alert">
        <h1>Something went wrong</h1>
        <p>{error instanceof Error ? error.message : 'Unexpected error'}</p>
        <button type="button" onclick={reset}>Try again</button>
      </div>
    {/snippet}
  </svelte:boundary>
</main>

<style>
  .skip-link {
    position: absolute;
    left: -9999px;
    top: 0;
    padding: 0.5rem 1rem;
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  .skip-link:focus {
    left: 0;
    z-index: 10;
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1.25rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
  }

  .topbar__nav {
    display: flex;
    gap: 1rem;
  }

  .topbar__nav a {
    color: var(--text-primary);
    text-decoration: none;
  }
  .topbar__nav a:hover {
    color: var(--accent);
  }

  .content {
    min-height: calc(100vh - 56px);
  }
  /* <main> is focused programmatically after a route change (for AT), not via
     keyboard tabbing, so suppress the focus ring on the container itself. */
  .content:focus {
    outline: none;
  }

  .route-error,
  .route-loading,
  .boundary-failed {
    padding: 2rem;
    text-align: center;
    color: var(--text-secondary);
  }
</style>
