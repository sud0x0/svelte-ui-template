/// <reference types="svelte" />
/// <reference types="vite/client" />

// Typed build-time env. Only VITE_-prefixed, non-secret values are exposed to
// the browser. Read these ONLY through src/lib/config.ts (single config seam).
interface ImportMetaEnv {
  readonly VITE_API_TARGET?: string
  readonly VITE_AUTH_MODE?: 'disabled' | 'bff'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
