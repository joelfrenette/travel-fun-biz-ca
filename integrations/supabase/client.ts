import { createClient } from '@supabase/supabase-js'

// Public (anon) client. The anon key is meant to be public; Row Level Security is
// what protects the data (published packages are readable, nothing is writable).
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ldwmbwsxrktpcisqaxrb.supabase.co'
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxkd21id3N4cmt0cGNpc3FheHJiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MDYyOTUsImV4cCI6MjA4OTE4MjI5NX0.dODVqhWKhK1tNgVPpnbsY8-0L-QXGJmDHOFd89dKaJQ'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
