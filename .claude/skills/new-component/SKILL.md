---
name: new-component
description: Scaffold a new reusable Svelte 5 runes component in this svelte-ui-template repo, with typed props, snippet children, CSS-variable styling, accessibility, and a colocated Vitest Browser test. Use when the user wants to add a UI component like a button, card, toast, dropdown, or any reusable piece under src/lib/components/. Mirrors src/lib/components/ui/Modal.svelte as the reference.
---

# /new-component — scaffold a runes component

Reusable components live under `src/lib/components/<group>/`. [`Modal.svelte`](../../../src/lib/components/ui/Modal.svelte)
is the reference — copy its shape. Read [security.md](../../rules/security.md) if
the component renders any API- or user-derived data.

## Steps

1. **Place it.** `src/lib/components/<group>/<Name>.svelte` (`ui/`, `auth/`,
   `layout/`, or a new feature group). PascalCase filename.
2. **Type the props with `$props()`.** Declare a `Props` interface and destructure
   — never `export let`. Snippet children are `children: Snippet` (and other named
   snippets as needed). Event callbacks are `onfoo?: (…) => void` props, not
   `createEventDispatcher`.
3. **State with runes.** `$state` for local state, `$derived` for computed,
   `$effect` ONLY to sync with an external system (DOM node, subscription) — never
   to fetch data.
4. **Style via CSS variables.** Reference `var(--bg-surface)`, `var(--text-primary)`,
   `var(--accent)`, etc. from `app.css`. No colour literals — theming must follow
   the variable.
5. **Accessibility.** Semantic elements, `aria-*` where needed, keyboard support,
   visible focus. `eslint-plugin-svelte`'s a11y rules will flag gaps — fix them.
6. **No raw HTML on dynamic data.** Never `{@html}` on props/API data.
7. **Colocated test.** Add `tests/unit/<Name>.test.ts` using `vitest-browser-svelte`'s
   `render` + `@vitest/browser/context` `page` locators. If the component takes a
   snippet prop, add a small `tests/unit/fixtures/<Name>Harness.svelte` wrapper
   (snippets can't be passed as plain props) — see `ModalHarness.svelte`.

## Rename pitfalls

- [ ] The `Props` interface name and the destructure must match the props you
      actually use — a leftover prop from the copied component fails strict types.
- [ ] `bind:this` targets are `$state<HTMLxElement>()` (undefined until mount) —
      guard with `if (!el) return` inside effects.
- [ ] Snippet children render with `{@render children()}`, not `<slot>`.
- [ ] If you copy Modal, drop its `<dialog>` effect unless you actually wrap a
      native dialog.

## Verify

`make verify` (lint + svelte-check + unit test + build + size). The component
test must pass in the real browser.
