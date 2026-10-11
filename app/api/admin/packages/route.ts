import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getAllPackagesAdmin } from '@/lib/packages'
import { importPackage } from '@/lib/import-package'
import { createDraftPackage } from '@/lib/package-ingest'
import { pingIndexNow } from '@/lib/indexnow'

// GET all packages (admin)
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const packages = await getAllPackagesAdmin()
  return NextResponse.json({ packages })
}

// POST create new package
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json()
    // The add-a-trip wizard (WP13) creates an empty DRAFT first, so the sources can be dropped onto a real row. Only a
    // name (optional) and the destination are taken; nothing else is invented. Always a draft.
    if (body && body.stub === true) {
      const name = typeof body.name === 'string' && body.name.trim() ? body.name : `New trip ${new Date().toISOString().slice(0, 10)}`
      const made = await createDraftPackage({ name, destination: typeof body.destination === 'string' ? body.destination : '', supplier: 'TravelFunBiz' })
      if (made.error || !made.pkg) return NextResponse.json({ error: made.error?.message ?? 'Failed to create the draft' }, { status: made.error?.status ?? 500 })
      return NextResponse.json({ package: made.pkg })
    }
    const { pkg, error } = await importPackage(body)
    if (error) return NextResponse.json({ error: error.message }, { status: error.status })
    if (pkg?.status === 'published') {
      // Tell Bing a new public package page appeared. Never blocks or fails the save above.
      await pingIndexNow([`/packages/${pkg.slug}`, '/'])
    }
    return NextResponse.json({ package: pkg })
  } catch (error) {
    console.error('[packages-api] Error creating package:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
