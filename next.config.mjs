/** @type {import('next').NextConfig} */
const nextConfig = {
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
