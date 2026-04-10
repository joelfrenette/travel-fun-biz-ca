import { NextResponse } from 'next/server'
import { validateToken } from '@/lib/admin-auth'
import { getPackageById, updatePackage, deletePackage } from '@/lib/packages'

// GET single package
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  
  if (!validateToken(token || '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  
  if (!validateToken(token || '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const pkg = await updatePackage(params.id, body)
    
    if (!pkg) {
      return NextResponse.json({ error: 'Failed to update package' }, { status: 500 })
    }

    return NextResponse.json({ package: pkg })
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
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  
  if (!validateToken(token || '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const success = await deletePackage(params.id)
  
  if (!success) {
    return NextResponse.json({ error: 'Failed to delete package' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
