/**
 * Browser error reporting → GlitchTip. Env-gated, never throws.
 *
 * BUNDLE COST, measured in a real production build (@sentry/react 10.70.0, Vite, React 18) rather than
 * cited — `npm --prefix frontend run build`, with and without:
 *
 *   entry chunk, no telemetry ......... 108.07 kB gzip
 *   entry chunk, with telemetry ....... 108.09 kB gzip   (+0.02 kB — effectively nothing)
 *   telemetry async chunk .............  30.54 kB gzip   (fetched AFTER first paint)
 *
 * So the lever is the DYNAMIC IMPORT at the call site, not anything in this file: the SDK is
 * ~30 kB gzip however it is written, and deferring it keeps that entirely out of the chunk
 * that gates first paint.
 *
 * A claim that named imports beat `import * as Sentry` was tested here and REFUTED: swapping
 * all 11 symbols to a namespace import produced a byte-identical chunk, same content hash,
 * 90.17 kB / 30.54 kB gzip. Rollup tree-shakes both the same way. The named form is kept
 * because the explicit `integrations` array below is what actually excludes replay, feedback
 * and profiling — and that is worth keeping for what it does NOT send, not for its size.
 *
 * Load it from the entry point inside an async IIFE with try/catch:
 *
 *     void (async () => {
 *       try { (await import('./lib/telemetry')).initTelemetry() } catch { }
 *     })()
 *
 * NOT `void import('./lib/telemetry').then(m => m.initTelemetry()).catch(...)`. A `.catch()`
 * handles a REJECTED promise, not a SYNCHRONOUS throw, and inside a React effect a synchronous
 * throw escapes into the commit phase and unmounts the tree — the bug class
 * a guard test should forbid (see references/edge-cases.md). Error reporting must never be able to
 * blank the app.
 */
import {
  init,
  addBreadcrumb,
  captureException,
  setUser,
  setTag,
  breadcrumbsIntegration,
  dedupeIntegration,
  functionToStringIntegration,
  globalHandlersIntegration,
  inboundFiltersIntegration,
  linkedErrorsIntegration,
} from '@sentry/react'

/**
 * Browser noise that is not an app bug. Without this the feed fills with things nobody can
 * act on, and the team stops reading it — the failure mode of alerting is too many alerts,
 * not too few.
 */
const IGNORED_ERRORS: (string | RegExp)[] = [
  /ResizeObserver loop/i,
  'Script error.',                        // cross-origin, no detail available, unfixable
  'Non-Error promise rejection captured',
  'AbortError',
  /The operation was aborted/i,
  /extension context invalidated/i,
  /Failed to fetch dynamically imported module/i,  // user on a stale bundle after a deploy
]

/** Errors thrown by browser extensions or third-party injected scripts. */
const DENY_URLS: RegExp[] = [
  /^chrome-extension:\/\//i,
  /^moz-extension:\/\//i,
  /^safari-(web-)?extension:\/\//i,
  /\/extensions\//i,
]

/**
 * Record the ACCESSIBLE LABEL of clicked controls, so a trail reads `clicked "Search"` rather
 * than an opaque CSS selector. This is what makes an alert actionable without a reproduction.
 * Capture-phase and fully wrapped: it can never break a user's click.
 */
const installClickBreadcrumbs = (): void => {
  if (typeof document === 'undefined') return
  document.addEventListener(
    'click',
    (event) => {
      try {
        const target = event.target as Element | null
        const el = target?.closest?.(
          'button, a, [role="button"], [role="tab"], [role="menuitem"], input, select, label, [data-testid]',
        )
        if (!el) return
        const raw =
          el.getAttribute('aria-label') ||
          (el as HTMLElement).innerText ||
          el.getAttribute('title') ||
          el.getAttribute('data-testid') ||
          el.tagName.toLowerCase()
        const label = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 80)
        if (!label) return
        addBreadcrumb({
          category: 'ui.click',
          message: label,
          level: 'info',
          data: { element: el.tagName.toLowerCase(), testid: el.getAttribute('data-testid') || undefined },
        })
      } catch {
        /* never break a click */
      }
    },
    { capture: true },
  )
}

let initialized = false

export const initTelemetry = (): boolean => {
  if (initialized) return true
  const dsn = String(import.meta.env.VITE_GLITCHTIP_DSN || import.meta.env.VITE_SENTRY_DSN || '').trim()
  if (!dsn) return false
  try {
    init({
      dsn,
      // Explicit, so a production-MODE staging build is still tagged "staging".
      environment: String(import.meta.env.VITE_APP_ENV || import.meta.env.MODE || 'production'),
      release: String(import.meta.env.VITE_GIT_SHA || '').trim() || undefined,
      tracesSampleRate: 0,          // errors only
      // No `autoSessionTracking` key: it was REMOVED in @sentry/react v10 (passing it is a
      // TS2353). Sessions are now opt-in through `browserSessionIntegration`, which the
      // explicit array below deliberately omits — GlitchTip has no session ingest, so the
      // envelopes would be built, sent and discarded.
      sendDefaultPii: false,
      ignoreErrors: IGNORED_ERRORS,
      denyUrls: DENY_URLS,
      maxBreadcrumbs: 50,
      // An explicit list, so replay / feedback / tracing / profiling are never CONSTRUCTED.
      // Measured above: this does not change the chunk size — it changes what the SDK does at
      // runtime. Replay would record the composer's legal question, and GlitchTip has no
      // replay ingest to receive it anyway.
      integrations: [
        inboundFiltersIntegration(),
        functionToStringIntegration(),
        breadcrumbsIntegration({ console: false, dom: false, fetch: true, history: true, xhr: true }),
        globalHandlersIntegration(),
        linkedErrorsIntegration(),
        dedupeIntegration(),
      ],
    })
    installClickBreadcrumbs()
    initialized = true
    return true
  } catch {
    return false
  }
}

/**
 * Tag events with a NON-PII identity, so "which user hit this" is answerable without ever
 * putting a name, phone or email into the error store. Call on auth change; pass null on
 * logout. Anything human-readable is resolved out of band, at alert time, by the relay.
 */
export const setTelemetryUser = (user: { id?: string | null; role?: string | null } | null): void => {
  if (!initialized) return
  try {
    if (!user || !user.id) {
      setUser(null)
      return
    }
    setUser({ id: String(user.id) })
    if (user.role) setTag('role', user.role)
  } catch {
    /* observability must never break the app */
  }
}

/** Capture explicitly — for a caught error the global handlers will never see. */
export const captureTelemetryException = (err: unknown, context?: Record<string, unknown>): void => {
  if (!initialized) return
  try {
    captureException(err, context ? { extra: context } : undefined)
  } catch {
    /* swallow */
  }
}

export const isTelemetryEnabled = (): boolean => initialized
