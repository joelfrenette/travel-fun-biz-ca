import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { isStaticRender } from '@/lib/static-render'

// Server-only client using the service role key, which bypasses Row Level
// Security. Never import this from client components; call it only from API
// routes / server code after the caller has passed validateToken().
// Created lazily so an environment without the key (local dev, a preview
// without secrets) still serves the public site and fails only on admin calls.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ldwmbwsxrktpcisqaxrb.supabase.co'

let client: SupabaseClient | null = null

export function getSupabaseAdmin(): SupabaseClient {
  if (!client) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
    // Every admin read must be live. Next.js can serve a repeated fetch from its data cache, and the
    // pipeline makes decisions from these reads ("was a post already written today?", "is this a
    // duplicate?", "has the weekly keyword spend been used?"). A stale answer made it write seven
    // near-identical posts in one day (2026-10-09) and double-spend keyword research (2026-10-08).
    client = createClient(SUPABASE_URL, key, {
      auth: { persistSession: false },
      global: {
        fetch: (input, init) =>
          // Only the cacheable default page render (lib/static-render.ts) may read through Next's data cache, and only
          // for the 5 minutes those pages already allow. Every other caller stays live, as described above.
          isStaticRender()
            ? fetch(input, { ...init, next: { revalidate: 300 } })
            : fetch(input, { ...init, cache: 'no-store' }),
      },
    })
  }
  return client
}

let pageSwitchClient: SupabaseClient | null = null

/** Service-role client for reading ONE on/off switch while a public page renders. A server component nested inside a
 * page renders after runStatic() has returned, so isStaticRender() is false there and the normal client's no-store fetch
 * turned the cached copy into "changed from static to dynamic" (HTTP 500 on /compare and /blog, 2026-11-01). This client
 * always lets Next cache the read for the same 5 minutes the pages declare. Use it only for a switch a visitor-facing
 * component reads, never for a decision the pipeline makes. */
export function getSupabaseAdminForPageSwitch(): SupabaseClient {
  if (!pageSwitchClient) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
    pageSwitchClient = createClient(SUPABASE_URL, key, {
      auth: { persistSession: false },
      global: { fetch: (input, init) => fetch(input, { ...init, next: { revalidate: 300 } }) },
    })
  }
  return pageSwitchClient
}
