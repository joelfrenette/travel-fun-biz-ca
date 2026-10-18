import { supabase } from '@/integrations/supabase/client'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { allowRequest } from '@/lib/abuse-guard'
import { isLikelyBot, refererParts } from '@/lib/affiliate-go'
import { getDestinationPage } from '@/lib/destinations'
import { logPartnerClick, resolvePartnerGo } from '@/lib/things-to-do'
import { SITE_URL } from '@/lib/site'

// WP21: the automatic "Find <place> tours and activities on <Partner>" button. The URL names a partner
// (by its slug) and a page (kind + slug). The server looks up the partner's STORED search template, fills
// it with the page's name, and answers 302 to that filled link, only if it is https and still on the
// template's own host. Nothing in the request can choose the destination, so this is not an open redirect.
// A bad or inactive partner, or an unknown page, goes to the page on this site instead.
export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: { partner: string; kind: string; slug: string } }) {
  let location = `${SITE_URL}/`
  try {
    const admin = getSupabaseAdmin()
    const result = await resolvePartnerGo({
      admin,
      reader: supabase,
      partnerSlug: params.partner,
      kind: params.kind,
      slug: params.slug,
      siteUrl: SITE_URL,
      destinationName: async (slug) => (await getDestinationPage(slug))?.destination ?? null,
    })
    location = result.location
    if (result.click && !isLikelyBot(request.headers.get('user-agent'))) {
      const { page, referrerHost } = refererParts(request.headers.get('referer'), request.url)
      try {
        if (await allowRequest(request, 'go-click', 60, 600)) await logPartnerClick(admin, result.click, { page, referrerHost })
      } catch {
        // a lost click log must never matter to the visitor
      }
    }
  } catch {
    // no database key (a preview without secrets): fall through to the home page
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}
