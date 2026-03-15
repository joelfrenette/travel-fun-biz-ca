// auth.ts - central admin credential verification helpers

const adminEmail = process.env.ADMIN_EMAIL
const adminPassword = process.env.ADMIN_PASSWORD

const expectedPassword = adminPassword ? adminPassword.trim() : undefined

console.log('[auth] env check', {
  hasEmail: Boolean(adminEmail),
  hasPassword: Boolean(adminPassword),
  passwordLength: expectedPassword ? expectedPassword.length : 0,
})

if (!adminEmail || !expectedPassword) {
  console.warn('[auth] ADMIN_EMAIL or ADMIN_PASSWORD env vars are missing')
}

export async function verifyAdminCredentials(email: string, password: string): Promise<boolean> {
  if (!adminEmail || !expectedPassword) {
    return false
  }

  const providedEmail = email.trim().toLowerCase()
  const expectedEmail = adminEmail.trim().toLowerCase()
  const providedPassword = typeof password === 'string' ? password.trim() : ''

  const emailMatches = providedEmail === expectedEmail
  const passwordMatches = providedPassword === expectedPassword

  console.log('[auth] verify attempt', {
    providedEmail,
    expectedEmail,
    emailMatches,
    providedPasswordLength: providedPassword.length,
    expectedPasswordLength: expectedPassword.length,
    passwordMatches,
  })

  if (!emailMatches) return false
  return passwordMatches
}