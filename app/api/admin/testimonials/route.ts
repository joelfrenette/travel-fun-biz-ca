import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { listTestimonials, createTestimonial } from '@/lib/testimonials'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json({ testimonials: await listTestimonials() })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json()
    const testimonial = await createTestimonial(body)
    return NextResponse.json({ testimonial })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 400 })
  }
}
