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

/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return legacyComRedirects()
  },
  images: {
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
