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
    client = createClient(SUPABASE_URL, key, { auth: { persistSession: false } })
  }
  return client
}
