import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getPackageById, updatePackage, deletePackage } from '@/lib/packages'
import { pingIndexNow } from '@/lib/indexnow'

// GET single package
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const pkg = await getPackageById(params.id)
  
  if (!pkg) {
    return NextResponse.json({ error: 'Package not found' }, { status: 404 })
  }

  return NextResponse.json({ package: pkg })
}

// PUT update package
export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await request.json()
    const before = await getPackageById(params.id)
    const pkg = await updatePackage(params.id, body)
    
    if (!pkg) {
      return NextResponse.json({ error: 'Failed to update package' }, { status: 500 })
    }

    // Tell Bing when a public page appeared, changed, or went away (unpublish or slug change).
    const urls: string[] = []
    if (pkg.status === 'published') urls.push(`/packages/${pkg.slug}`, '/')
    if (before?.status === 'published' && (pkg.status !== 'published' || before.slug !== pkg.slug)) urls.push(`/packages/${before.slug}`)
    const indexNow = urls.length > 0 ? await pingIndexNow(urls) : null

    return NextResponse.json({ package: pkg, indexNow })
  } catch (error) {
    console.error('Error updating package:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

// DELETE package
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const before = await getPackageById(params.id)
  const success = await deletePackage(params.id)
  
  if (!success) {
    return NextResponse.json({ error: 'Failed to delete package' }, { status: 500 })
  }

  const indexNow = before?.status === 'published' ? await pingIndexNow([`/packages/${before.slug}`, '/']) : null
  return NextResponse.json({ success: true, indexNow })
}
