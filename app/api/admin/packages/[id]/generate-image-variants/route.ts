import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getPackageById, updatePackage } from '@/lib/packages'
import { uploadImagePackageVariants, uploadGeneratedImageVariants } from '@/lib/import-package'
import { findDestinationPhoto, isPexelsConfigured } from '@/lib/pexels'
import { generateAiImage, isImageAiConfigured } from '@/lib/image-ai-gen'

// Image format pipeline: the manual "add/edit package" admin flow just pastes a raw image URL
// into image_url with no processing (unlike the sync/scrape import path, which now runs every
// photo through lib/image-pipeline.ts on the way in). This route is that same processing, callable
// on demand from the packages admin page for a package that already has an image_url, or that has
// none yet and wants a real Pexels photo of its destination — or, only when explicitly asked
// (useAi: true), an OpenAI-generated illustration for a genuine no-photo, no-Pexels-match gap.
// useAi is a separate, deliberate action rather than an automatic fallback: it costs real money
// per image, and this project's rule is every credit-costing call is admin-triggered, never silent.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const pkg = await getPackageById(params.id)
    if (!pkg) return NextResponse.json({ error: 'Package not found' }, { status: 404 })

    const body = await request.json().catch(() => ({}))
    const useSourceUrl = typeof body.sourceUrl === 'string' && body.sourceUrl.trim() ? body.sourceUrl.trim() : null
    const useAi = body.useAi === true

    if (useAi) {
      if (!isImageAiConfigured()) {
        return NextResponse.json({ error: 'OPENAI_API_KEY is not set, so AI image generation is off.' }, { status: 400 })
      }
      const prompt = [pkg.name, pkg.destination, pkg.short_description].filter(Boolean).join(' — ')
      const ai = await generateAiImage(prompt)
      if (!ai) return NextResponse.json({ error: 'AI image generation failed or timed out. Try again, or use a real photo instead.' }, { status: 502 })

      const variants = await uploadGeneratedImageVariants(ai.buffer, pkg.slug)
      if (!variants.image_url) return NextResponse.json({ error: 'Generated an image but could not process/store it.' }, { status: 500 })

      const updated = await updatePackage(params.id, { ...variants, image_source: 'ai_generated' })
      if (!updated) return NextResponse.json({ error: 'Generated the images but could not save them to the package.' }, { status: 500 })
      return NextResponse.json({ package: updated, aiGenerated: true })
    }

    let sourceUrl = useSourceUrl || pkg.image_url
    let photoCredit: { photographer: string; photographerUrl: string } | null = null
    let imageSource: 'upload' | 'pexels' = 'upload'

    if (!sourceUrl) {
      if (!isPexelsConfigured()) {
        return NextResponse.json({ error: 'This package has no image yet, and PEXELS_API_KEY is not set to find one automatically. Paste an image URL, upload a photo, or use "Generate AI image" instead.' }, { status: 400 })
      }
      const photo = await findDestinationPhoto(pkg.destination || pkg.name)
      if (!photo) return NextResponse.json({ error: `No Pexels photo found for "${pkg.destination || pkg.name}". Try "Generate AI image" instead.` }, { status: 404 })
      sourceUrl = photo.url
      photoCredit = { photographer: photo.photographer, photographerUrl: photo.photographerUrl }
      imageSource = 'pexels'
    }

    const variants = await uploadImagePackageVariants(sourceUrl, pkg.slug)
    if (!variants.image_url) {
      return NextResponse.json({ error: 'Could not fetch or process that image. Check the URL and try again.' }, { status: 400 })
    }

    const updated = await updatePackage(params.id, { ...variants, image_source: imageSource })
    if (!updated) return NextResponse.json({ error: 'Generated the images but could not save them to the package.' }, { status: 500 })

    return NextResponse.json({ package: updated, photoCredit })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
