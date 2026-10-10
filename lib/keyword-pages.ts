import type { SupabaseClient } from '@supabase/supabase-js'
import { bestPairs } from '@/lib/rankings'
import { getQueryPagePairs } from '@/lib/search-console'
import { pageTypeOf } from '@/lib/site-pages'

// The connection between a keyword and the page Google really shows for it, made from Search Console's
// own query + page report (never guessed). Used by the Keyword Research page, and by a daily job that
// fills in the "target page" of every keyword that has none yet.

/** keyword (lowercase) -> the page Google shows for it most, limited to pages this site tracks
 * (home, packages, destinations, blog posts). Empty when Search Console is unavailable. */
export async function rankedPageByKeyword(): Promise<Map<string, string>> {
  const { pageForQuery } = bestPairs(await getQueryPagePairs())
  return new Map([...pageForQuery].filter(([, path]) => pageTypeOf(path) !== null))
}

/** Sets the target page of every keyword that has none to the page Google really shows for it. A page
 * someone chose by hand is never changed. Returns how many keywords were connected. */
export async function connectKeywordsToRankingPages(admin: SupabaseClient): Promise<number> {
  const ranked = await rankedPageByKeyword()
  if (!ranked.size) return 0
  const { data } = await admin.from('keyword_research').select('id, keyword').is('target_path', null)
  let connected = 0
  for (const row of (data ?? []) as { id: string; keyword: string }[]) {
    const path = ranked.get(row.keyword.toLowerCase())
    if (!path) continue
    const { error } = await admin.from('keyword_research').update({ target_path: path, updated_at: new Date().toISOString() }).eq('id', row.id).is('target_path', null)
    if (!error) connected++
  }
  return connected
}
