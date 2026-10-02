import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getAllPackagesAdmin } from '@/lib/packages'
import { importPackage } from '@/lib/import-package'
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
