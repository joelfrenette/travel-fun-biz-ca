import { createClient, type SupabaseClient } from '@supabase/supabase-js'

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
      global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }) },
    })
  }
  return client
}
