# TravelFunBiz.CA Travel Website

A high-performance, SEO-optimized travel website built with Next.js 15 for generating leads and showcasing travel packages.

## Features

- **Fast Loading**: Optimized for Core Web Vitals and SEO
- **Google Sheets Integration**: Dynamically load travel packages from Google Sheets
- **GoHighLevel CRM**: Automatic lead capture and opportunity creation
- **Lead Generation**: Capture traveler information with a beautiful contact form
- **Responsive Design**: Mobile-first design that works on all devices
- **SEO Optimized**: Proper meta tags, semantic HTML, and structured data ready

## Quick Start

1. Clone the repository
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env.local` and configure
4. Run development server: `npm run dev`
5. Open [http://localhost:3000](http://localhost:3000)

## Configuration

### Google Sheets Setup (Travel Packages)

1. Create a Google Sheet with your travel packages
2. Set sharing to "Anyone with the link can view"
3. Add the Sheet ID to `GOOGLE_SHEET_ID` in `.env.local`

Required columns: name, destination, duration, price, description, category

### GoHighLevel Setup (Lead Management)

1. Get your API key from GoHighLevel Settings > API Keys
2. Find your Location ID in Settings > Business Profile
3. Add credentials to `.env.local`:
   - `GOHIGHLEVEL_API_KEY`
   - `GOHIGHLEVEL_LOCATION_ID`
   - `GOHIGHLEVEL_PIPELINE_ID` (optional)

See [SETUP.md](./SETUP.md) for detailed instructions.

## Tech Stack

- **Framework**: Next.js 15 (App Router)
- **Styling**: Tailwind CSS v4
- **UI Components**: Radix UI + shadcn/ui
- **CRM**: GoHighLevel API
- **TypeScript**: Full type safety
- **Analytics**: Vercel Analytics

## Performance

- Server-side rendering for optimal SEO
- Image optimization with Next.js Image
- Minimal JavaScript bundle
- 5-minute cache revalidation for Google Sheets data

## Deployment

Deploy to Vercel with one click or push to GitHub and import in Vercel dashboard.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new)

## Documentation

See [SETUP.md](./SETUP.md) for detailed setup instructions.

## License

MIT
