import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getPackageById, updatePackage } from '@/lib/packages'
import { uploadImagePackageVariants } from '@/lib/import-package'
import { findDestinationPhoto, isPexelsConfigured } from '@/lib/pexels'

// Image format pipeline: the manual "add/edit package" admin flow just pastes a raw image URL
// into image_url with no processing (unlike the sync/scrape import path, which now runs every
// photo through lib/image-pipeline.ts on the way in). This route is that same processing, callable
// on demand from the packages admin page for a package that already has an image_url, or that has
// none yet and wants a real Pexels photo of its destination instead.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const pkg = await getPackageById(params.id)
    if (!pkg) return NextResponse.json({ error: 'Package not found' }, { status: 404 })

    const body = await request.json().catch(() => ({}))
    const useSourceUrl = typeof body.sourceUrl === 'string' && body.sourceUrl.trim() ? body.sourceUrl.trim() : null

    let sourceUrl = useSourceUrl || pkg.image_url
    let photoCredit: { photographer: string; photographerUrl: string } | null = null

    if (!sourceUrl) {
      if (!isPexelsConfigured()) {
        return NextResponse.json({ error: 'This package has no image yet, and PEXELS_API_KEY is not set to find one automatically. Paste an image URL or upload a photo first.' }, { status: 400 })
      }
      const photo = await findDestinationPhoto(pkg.destination || pkg.name)
      if (!photo) return NextResponse.json({ error: `No Pexels photo found for "${pkg.destination || pkg.name}".` }, { status: 404 })
      sourceUrl = photo.url
      photoCredit = { photographer: photo.photographer, photographerUrl: photo.photographerUrl }
    }

    const variants = await uploadImagePackageVariants(sourceUrl, pkg.slug)
    if (!variants.image_url) {
      return NextResponse.json({ error: 'Could not fetch or process that image. Check the URL and try again.' }, { status: 400 })
    }

    const updated = await updatePackage(params.id, variants)
    if (!updated) return NextResponse.json({ error: 'Generated the images but could not save them to the package.' }, { status: 500 })

    return NextResponse.json({ package: updated, photoCredit })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
