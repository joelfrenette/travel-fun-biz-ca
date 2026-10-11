import type { SupabaseClient } from '@supabase/supabase-js'
import { getPublishedPosts } from '@/lib/posts'
import { supabase } from '@/integrations/supabase/client'
import { isPastTrip, hasRecap } from '@/lib/past-trip'

// Post-publish drift monitoring (factory spec, Nomad Escape Plan item 1): a post is only grounded
// in facts on the day it's written - the underlying travel_packages row can change after (a price
// updates, a trip sells out and gets unpublished, its dates pass). This re-reads every PUBLISHED
// post and checks it against CURRENT package data, the same no-invented-data discipline as
// composition itself, just applied after the fact instead of before.
//
// Deliberately deterministic, not AI-based: every finding here is a real database fact mismatch
// (a package no longer published, a trip's dates already passed, a dead link), not a guess about
// whether free-text prose "still sounds right." Scanning prose for invented numeric drift is a
// real future enhancement, not attempted here - a false positive on that would be worse than a
// missed one, and it needs its own careful design.

export interface DriftFinding {
  postId: string
  postSlug: string
  postTitle: string
  kind: 'related_package_unpublished' | 'related_package_dates_passed' | 'linked_package_unpublished'
  detail: string
}

interface PackageRow {
  id: string
  slug: string
  status: string
  available_to: string | null
  recap_mode?: string | null
}

// WP14: a trip whose dates passed is a PAST TRIP, and a past trip is never unpublished. Nothing in this file
// suggests unpublishing one. What drift can say about a past trip is "needs a recap" (it has none yet), with a link
// to the Convert to Past Trip card. The rule for "past" is the shared one in lib/past-trip.ts.
export interface RecapDriftFinding {
  packageId: string
  packageSlug: string
  packageName: string
  kind: 'needs_recap'
  detail: string
  /** Where to fix it: the editor, scrolled to the Convert to Past Trip card. Never an unpublish action. */
  href: string
}

export interface PackageDriftRow {
  id: string
  slug: string
  name: string
  status: string
  available_to: string | null
  recap_mode?: string | null
  recap_summary?: string | null
}

/** Pure: the drift findings for a list of trips. Only a published past trip with no recap (and not forced live)
 * produces one, and the only kind is needs_recap. */
export function recapDriftFindings(rows: PackageDriftRow[], today: string = new Date().toISOString().slice(0, 10)): RecapDriftFinding[] {
  return rows
    .filter((p) => p.status === 'published' && isPastTrip(p, today) && !hasRecap(p))
    .map((p) => ({
      packageId: p.id,
      packageSlug: p.slug,
      packageName: p.name,
      kind: 'needs_recap' as const,
      detail: `${p.name} has already happened and has no recap yet. Keep it published: add your photos and journal notes and write the recap.`,
      href: `/admin/packages?edit=${p.id}#past-trip-panel`,
    }))
}

/** Reads the published trips and returns the "needs a recap" findings. [] when the recap columns do not exist yet
 * (migration 0037 not applied), because nothing can be done about it from the admin until then. */
export async function checkPastTripsForRecap(admin: SupabaseClient, today?: string): Promise<RecapDriftFinding[]> {
  const { data, error } = await admin.from('travel_packages').select('id, slug, name, status, available_to, recap_mode, recap_summary').eq('status', 'published')
  if (error) {
    if (/recap_mode|recap_summary|column|schema cache/i.test(error.message)) return []
    throw new Error(error.message)
  }
  return recapDriftFindings((data ?? []) as PackageDriftRow[], today)
}

/** Every /packages/<slug> link inside a post body, deduped. Catches a stale reference even when
 * it's just in the prose (e.g. autoblog's own CTA link, lib/autoblog-run.ts's appendCta) and not
 * the post's related_package_id. */
function extractLinkedPackageSlugs(body: string): string[] {
  const slugs = new Set<string>()
  const re = /\/packages\/([a-z0-9-]+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(body))) slugs.add(match[1])
  return Array.from(slugs)
}

export async function checkPublishedPostsForDrift(): Promise<DriftFinding[]> {
  const [posts, firstTry] = await Promise.all([
    getPublishedPosts(),
    supabase.from('travel_packages').select('id, slug, status, available_to, recap_mode'),
  ])
  // Before migration 0037 there is no recap_mode column: read without it (every trip then counts as 'auto').
  const packagesRes = firstTry.error ? await supabase.from('travel_packages').select('id, slug, status, available_to') : firstTry
  if (packagesRes.error) throw new Error(packagesRes.error.message)
  const packages = (packagesRes.data ?? []) as PackageRow[]
  const byId = new Map(packages.map((p) => [p.id, p]))
  const bySlug = new Map(packages.map((p) => [p.slug, p]))
  const today = new Date().toISOString().slice(0, 10)

  const findings: DriftFinding[] = []

  for (const post of posts) {
    if (post.related_package_id) {
      const pkg = byId.get(post.related_package_id)
      if (!pkg || pkg.status !== 'published') {
        findings.push({
          postId: post.id,
          postSlug: post.slug,
          postTitle: post.title,
          kind: 'related_package_unpublished',
          detail: pkg ? `Related package is now "${pkg.status}", not published.` : 'Related package no longer exists.',
        })
      } else if (isPastTrip(pkg, today)) {
        findings.push({
          postId: post.id,
          postSlug: post.slug,
          postTitle: post.title,
          kind: 'related_package_dates_passed',
          detail: `Related trip has already happened${pkg.available_to ? ` (ended ${pkg.available_to})` : ''}. Its page stays published as a trip recap; check that the post does not still say the trip is bookable.`,
        })
      }
    }

    for (const slug of extractLinkedPackageSlugs(post.body)) {
      if (post.related_package_id && byId.get(post.related_package_id)?.slug === slug) continue // already checked above
      const pkg = bySlug.get(slug)
      if (!pkg || pkg.status !== 'published') {
        findings.push({
          postId: post.id,
          postSlug: post.slug,
          postTitle: post.title,
          kind: 'linked_package_unpublished',
          detail: `Links to /packages/${slug}, which is ${pkg ? `now "${pkg.status}"` : 'gone'}.`,
        })
      }
    }
  }

  return findings
}
