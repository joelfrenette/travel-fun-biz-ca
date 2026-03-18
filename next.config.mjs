/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'travelfunbiz.com',
        pathname: '/**',
      },
    ],
  },
}

export default nextConfig