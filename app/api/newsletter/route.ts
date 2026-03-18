import { NextResponse } from 'next/server'
import { newsletterSchema } from '@/lib/schemas/newsletter'

export async function POST(request: Request) {
  try {
    const json = await request.json()
    const parsed = newsletterSchema.safeParse(json)

    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid data', issues: parsed.error.flatten() }, { status: 400 })
    }

    console.log('[newsletter] subscription request', {
      email: parsed.data.email,
      deals: parsed.data.deals,
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[newsletter] failed to subscribe', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
