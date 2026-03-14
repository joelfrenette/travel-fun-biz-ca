// auth.ts - central admin credential verification helpers
import bcrypt from 'bcryptjs'

const adminEmail = process.env.ADMIN_EMAIL
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH


console.log('[auth] loaded env', {
  email: adminEmail,
  hasHash: Boolean(adminPasswordHash),
  hashLength: adminPasswordHash?.length,
  hashStart: adminPasswordHash?.substring(0, 10),
  hashEnd: adminPasswordHash?.substring((adminPasswordHash?.length ?? 0) - 5),
})

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
    const result = await bcrypt.compare(password, adminPasswordHash)
    console.log('[auth] bcrypt.compare result:', result, {
      passwordLength: password.length,
      hashLength: adminPasswordHash.length,
      hashPrefix: adminPasswordHash.substring(0, 7),
    })
    return result
  } catch (error) {
    console.error('[auth] Failed to compare password hash', error)
    return false
  }
}