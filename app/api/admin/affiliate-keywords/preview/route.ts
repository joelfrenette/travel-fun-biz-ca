import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { cleanPhrase, isLinkScope, phraseProblem } from '@/lib/affiliate-linker'
import { loadUsageDocs, previewRule, MAX_USAGE_DOCS } from '@/lib/affiliate-usage'

// WP22: "Preview" for the Link a word tool. Read only: runs the finder over the published content and reports where
// the phrase would be linked. Nothing is saved, and no AI or outside service is called.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const problem = phraseProblem(body.phrase)
    if (problem) return NextResponse.json({ error: problem }, { status: 400 })
    const phrase = cleanPhrase(body.phrase)
    if (!phrase) return NextResponse.json({ error: 'That phrase cannot be used.' }, { status: 400 })
    const scope = body.scope == null || body.scope === '' ? 'all' : body.scope
    if (!isLinkScope(scope)) return NextResponse.json({ error: 'Pick where the phrase should be linked from the list.' }, { status: 400 })
    const max = Number(body.max_per_page ?? 1)
    if (!Number.isInteger(max) || max < 1 || max > 3) return NextResponse.json({ error: 'Max per page must be 1, 2 or 3.' }, { status: 400 })

    const site = await loadUsageDocs(getSupabaseAdmin())
    if (site.error) throw new Error(site.error)
    const result = previewRule(site.docs, { phrase, scope, max_per_page: max }, { totalDocs: site.totalDocs })
    return NextResponse.json({ ...result, limit: MAX_USAGE_DOCS })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
