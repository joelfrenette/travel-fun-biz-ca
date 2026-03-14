// auth.ts - central admin credential verification helpers

const adminEmail = process.env.ADMIN_EMAIL
const adminPassword = process.env.ADMIN_PASSWORD

if (!adminEmail || !adminPassword) {
  console.warn('[auth] ADMIN_EMAIL or ADMIN_PASSWORD env vars are missing')
}

export async function verifyAdminCredentials(email: string, password: string): Promise<boolean> {
  if (!adminEmail || !adminPassword) {
    return false
  }

  if (email.trim().toLowerCase() !== adminEmail.trim().toLowerCase()) {
    return false
  }

  // Direct comparison — password is only in server-side env vars, never sent to client
  return password === adminPassword
}
