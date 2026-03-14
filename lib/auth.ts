// auth.ts - central admin credential verification helpers
import bcrypt from 'bcryptjs'

const adminEmail = process.env.ADMIN_EMAIL
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH

if (!adminEmail || !adminPasswordHash) {
  console.warn('[auth] ADMIN_EMAIL or ADMIN_PASSWORD_HASH env vars are missing')
}

export async function verifyAdminCredentials(email: string, password: string): Promise<boolean> {
  if (!adminEmail || !adminPasswordHash) {
    return false
  }

  if (email.trim().toLowerCase() !== adminEmail.trim().toLowerCase()) {
    return false
  }

  try {
    return await bcrypt.compare(password, adminPasswordHash)
  } catch (error) {
    console.error('[auth] Failed to compare password hash', error)
    return false
  }
}
