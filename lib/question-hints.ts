import type { SupabaseClient } from '@supabase/supabase-js'
import { readStoredQueryRows } from '@/lib/gsc-mining'
import { ownQuestionsFromPosts, pickFaqQuestions } from '@/lib/question-intel'

// The database half of hub WP5. Reads the stored Search Console searches (read-only, the daily snapshot) and the question
// headings in our own posts, and hands the FAQ step of the blog and guide composers a short list of real questions.
// Read-only: no writes, no new paid call. Never throws: any failure gives [] and the composer prompt stays exactly as it was.

export async function loadQuestionHints(admin: SupabaseClient, keywords: readonly string[], now: Date = new Date()): Promise<string[]> {
  try {
    const wanted = keywords.map((k) => k.trim()).filter(Boolean)
    if (wanted.length === 0) return []
    const [searches, postsRes] = await Promise.all([
      readStoredQueryRows(admin, now),
      admin.from('posts').select('body').order('created_at', { ascending: false }).limit(200),
    ])
    const own = postsRes.error ? [] : ownQuestionsFromPosts((postsRes.data ?? []) as { body: string | null }[])
    return pickFaqQuestions({ keywords: wanted, searches, own })
  } catch {
    return []
  }
}
