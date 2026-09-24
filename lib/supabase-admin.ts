import { createClient } from '@supabase/supabase-js'

// Server-only client using the service role key, which bypasses Row Level
// Security. Never import this from client components — it must only run
// in API routes / server actions where the caller has already been checked
// against validateToken().
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ldwmbwsxrktpcisqaxrb.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[supabase-admin] SUPABASE_SERVICE_ROLE_KEY is not set — admin writes will fail')
}

export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})
