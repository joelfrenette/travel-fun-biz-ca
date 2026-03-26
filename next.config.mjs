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
      // Common travel image CDNs / suppliers
      {
        protocol: 'https',
        hostname: '*.wp.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.wordpress.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.cloudfront.net',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.amazonaws.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.imgix.net',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.westjetvacations.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.sunwing.ca',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.transat.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.exoticca.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.gocollette.com',
        pathname: '/**',
      },
    ],
    // Allow unoptimized images as fallback for any domain not listed
    unoptimized: false,
  },
}

export default nextConfig
