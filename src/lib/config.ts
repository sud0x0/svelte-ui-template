// Single source of truth for build-time configuration.
//
// This is the ONLY module that reads `import.meta.env`. Everything else imports
// `config` from here, so there is exactly one place that decides dev/prod
// behaviour and the auth mode. (vite.config.ts owns the dev-proxy target, the
// one env read that cannot live in the browser bundle.)

export type AuthMode = 'disabled' | 'bff'

function readAuthMode(): AuthMode {
  // Anything other than the explicit opt-in falls back to the safe default.
  return import.meta.env.VITE_AUTH_MODE === 'bff' ? 'bff' : 'disabled'
}

export const config = {
  /**
   * The auth switch. `disabled` ships a no-auth dev experience; `bff` wires the
   * SPA to the Backend-For-Frontend. See README "Authentication".
   */
  authMode: readAuthMode(),
} as const
