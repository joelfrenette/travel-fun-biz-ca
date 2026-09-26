import { supabase } from '@/integrations/supabase/client'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { allowRequest } from '@/lib/abuse-guard'
import { goDestination, isLikelyBot, isValidSlug, refererParts, type GoCard } from '@/lib/affiliate-go'
import { SITE_URL } from '@/lib/site'

// Factory Phase 6: affiliate layer. Looks up an ACTIVE card by slug and answers 302 to the link
// stored on that card. An unknown, hidden or draft slug goes to the home page instead, so a
// mistyped or retired short link never dead-ends and never reveals a card that isn't live.
// The destination is only ever the card's stored URL or this site's own home page - nothing in
// the request can choose it, so this is not an open redirect.
export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: { slug: string } }) {
  const slug = String(params.slug ?? '').trim().toLowerCase()
  const fallback = `${SITE_URL}/`

  let card: GoCard | null = null
  if (isValidSlug(slug)) {
    try {
      const { data } = await supabase.from('affiliate_links').select('id, slug, status, url, merchant').eq('slug', slug).eq('status', 'active').maybeSingle()
      card = (data as GoCard | null) ?? null
    } catch {
      card = null
    }
  }

  const dest = goDestination(card, fallback)

  // A light per-IP throttle stops a hammering script from inflating the numbers - it only skips
  // the log, it never blocks the redirect. Logging never slows the visitor down more than one
  // fast insert; this route has no real traffic yet (no admin screen creates links), so there's
  // no reason to reach for an experimental background-task API on Next 14 for this.
  if (dest.card && !isLikelyBot(request.headers.get('user-agent'))) {
    const clicked = dest.card
    const { page, referrerHost } = refererParts(request.headers.get('referer'), request.url)
    try {
      if (await allowRequest(request, 'go-click', 60, 600)) {
        await getSupabaseAdmin()
          .from('affiliate_clicks')
          .insert({ link_id: clicked.id, merchant: clicked.merchant, page, channel: null, channel_source: null, referrer_host: referrerHost })
      }
    } catch {
      // a lost click log must never matter to the visitor
    }
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: dest.location,
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
      // Our links keep the Referer so the click log gets the page; don't pass it on to the merchant.
      'Referrer-Policy': 'no-referrer',
    },
  })
}
