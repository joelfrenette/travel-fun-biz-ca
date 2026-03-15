import { NextResponse } from 'next/server'
import { validateToken } from '@/lib/admin-auth'
import { getAllPackagesAdmin, createPackage, generateSlug } from '@/lib/packages'

// GET all packages (admin)
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  
  if (!validateToken(token || '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const packages = await getAllPackagesAdmin()
  return NextResponse.json({ packages })
}

// POST create new package
export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  
  if (!validateToken(token || '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    
    // Generate slug if not provided
    if (!body.slug && body.name) {
      body.slug = generateSlug(body.name)
    }

    const pkg = await createPackage(body)
    
    if (!pkg) {
      return NextResponse.json({ error: 'Failed to create package' }, { status: 500 })
    }

    return NextResponse.json({ package: pkg })
  } catch (error) {
    console.error('Error creating package:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
