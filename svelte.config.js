import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import("@sveltejs/vite-plugin-svelte").SvelteConfig} */
export default {
  // Enables TypeScript inside <script lang="ts"> and other preprocessing.
  preprocess: vitePreprocess(),
}
