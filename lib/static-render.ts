// static-render.ts - marks one render as "the cacheable default page" (English, the site's own currency, no cookies).
//
// Why: the public pages call getVisitorPreferences(), which reads the lang / currency cookies. Reading a cookie
// makes a page render fresh on every request, so nothing could be cached at the CDN. The mirror pages
// (see lib/cache-routing.ts) call the very same page code inside runStatic(); while inside it:
//   - getVisitorPreferences() returns the defaults and never touches cookies(), and
//   - the database client (lib/supabase-admin.ts) stops sending `no-store` and lets Next cache reads for 5 minutes,
//     the same freshness the pages already declare with `export const revalidate = 300`.
// Outside runStatic() nothing changes: cookie visitors and every admin / cron / API code path behave as before.
import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<{ static: true }>()

/** Run a page render as the cacheable default page. Everything awaited inside it sees isStaticRender() === true. */
export function runStatic<T>(render: () => T): T {
  return storage.run({ static: true }, render)
}

export function isStaticRender(): boolean {
  return storage.getStore()?.static === true
}
