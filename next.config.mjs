import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Legacy travelfunbiz.com -> new-path 301s, only active on the US deployment (the .ca site has
// nothing to redirect from). Read as plain JSON, not through the TS path alias, because this file
// runs directly under Node before Next's compiler is available. See lib/legacy-redirects.ts.
function legacyComRedirects() {
  if (process.env.NEXT_PUBLIC_SITE_ID !== 'us') return []
  const path = fileURLToPath(new URL('./data/legacy-com-redirects.json', import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8'))
}

// Plain JSON for the same reason as above (this file runs under Node before the TS alias exists).
function securityHeaders() {
  const path = fileURLToPath(new URL('./data/security-headers.json', import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8'))
}

// 2026-10-09: the autoblog wrote six near-identical Rhine posts in one day (a stale-read bug, fixed).
// Their links were already posted on social, so the five extras are unpublished and 301 to the one
// kept, instead of showing a not-found page.
const KEPT_RHINE_POST = '/blog/your-7-night-rhine-float-decoded-cologne-to-basel'
const duplicatePostRedirects = [
  '7-nights-on-the-rhine-river-swiss-alps-cruise',
  'deck-to-peak-planning-your-cologne-to-basel-rhine-cruise',
  'cologne-to-basel-rhine-river-cruise-planning-guide',
  'rhine-river-cruise-with-amy-liz-cologne-to-basel',
  '7-night-rhine-river-cruise-from-cologne-day-by-day',
].map((slug) => ({ source: `/blog/${slug}`, destination: KEPT_RHINE_POST, permanent: true }))

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Basic security headers on every response (hub WP7). Deliberately NOT here: Strict-Transport-Security (Vercel sets it, Joel's call)
  // and any Content-Security-Policy (a wrong one breaks the consent banner and the Google tags). No page of the site uses the camera,
  // the microphone or the location (checked with a search of app/, components/ and lib/ on 2026-10-24), so those three are denied.
  // The list lives in data/security-headers.json so scripts/check-head-hygiene.ts tests the exact same values.
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders() }]
  },
  async redirects() {
    return [...legacyComRedirects(), ...duplicatePostRedirects]
  },
  images: {
    // AVIF first, WebP second: the optimiser returns the smallest format the browser accepts (hero and blog photos).
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [
      // Supabase storage (where uploaded package images live)
      {
        protocol: 'https',
        hostname: 'ldwmbwsxrktpcisqaxrb.supabase.co',
        pathname: '/**',
      },
      // TravelFunBiz source site
      {
        protocol: 'https',
        hostname: 'travelfunbiz.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'www.travelfunbiz.com',
        pathname: '/**',
      },
    ],
  },
}

export default nextConfig
