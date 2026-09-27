import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getDestinationSlugs } from '@/lib/destinations'
import { getAllBlurbsAdmin } from '@/lib/destination-blurbs'

// Every destination that has at least one published package, joined with its blurb (if any) and
// how many packages exist there - enough context for the admin to decide which destinations are
// worth writing a blurb for.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const [destinations, blurbs] = await Promise.all([getDestinationSlugs(), getAllBlurbsAdmin()])
  const blurbBySlug = new Map(blurbs.map((b) => [b.slug, b]))
  const rows = destinations.map((d) => ({ ...d, blurb: blurbBySlug.get(d.slug) ?? null }))
  return NextResponse.json({ destinations: rows })
}
