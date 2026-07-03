<script lang="ts">
  import RouteGuard from '../../../src/lib/components/auth/RouteGuard.svelte'
</script>

<RouteGuard>
  <p data-testid="guarded">protected content</p>
</RouteGuard>
