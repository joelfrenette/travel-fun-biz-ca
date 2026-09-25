import { createSign } from 'crypto'

// Service-account access tokens for Google APIs, signed with node's crypto (no SDK).
// One token per scope, cached until shortly before it expires.
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const tokens = new Map<string, { token: string; expiresAt: number }>()

interface ServiceAccount {
  client_email: string
  private_key: string
}

export function isGoogleServiceAccountConfigured(): boolean {
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY
}

export function googleServiceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || ''
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set')
  const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')
  const parsed = JSON.parse(json)
  if (!parsed.client_email || !parsed.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is missing client_email or private_key')
  return parsed
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

export async function getGoogleAccessToken(scope: string): Promise<string> {
  const cached = tokens.get(scope)
  if (cached && Date.now() < cached.expiresAt) return cached.token

  const sa = googleServiceAccount()
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(JSON.stringify({ iss: sa.client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claims}`)
  const assertion = `${header}.${claims}.${base64url(signer.sign(sa.private_key))}`

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    cache: 'no-store',
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.access_token) throw new Error(`Google token exchange failed: ${body.error_description || body.error || res.status}`)

  tokens.set(scope, { token: body.access_token, expiresAt: Date.now() + 50 * 60 * 1000 })
  return body.access_token
}
