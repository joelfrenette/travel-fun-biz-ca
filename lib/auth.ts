// auth.ts - central admin credential verification helpers

const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase()
const adminPassword = (process.env.ADMIN_PASSWORD || '').trim()

console.log('[auth] env check', {
  hasEmail: Boolean(adminEmail),
  hasPassword: Boolean(adminPassword),
  passwordLength: adminPassword.length,
})

export async function verifyAdminCredentials(email: string, password: string): Promise<boolean> {
  const providedEmail = (email || '').trim().toLowerCase()
  const providedPassword = (password || '').trim()

  const emailMatches = providedEmail === adminEmail
  const passwordMatches = providedPassword === adminPassword

  console.log('[auth] verify attempt', {
    providedEmail,
    expectedEmail: adminEmail,
    emailMatches,
    providedPasswordLength: providedPassword.length,
    expectedPasswordLength: adminPassword.length,
    passwordMatches,
  })

  return emailMatches && passwordMatches
}