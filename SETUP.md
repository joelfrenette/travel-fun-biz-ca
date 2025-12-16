# TravelFunBiz.CA Setup Guide

## Overview
This is a high-performance, SEO-optimized travel website built with Next.js 15, designed to generate leads for travel packages.

## Features
- Fast-loading, SEO-optimized pages
- Dynamic travel packages from Google Sheets
- Lead generation with GoHighLevel CRM integration
- Responsive design for all devices
- Server-side rendering for optimal performance

## Environment Variables

Create a `.env.local` file in the root directory with the following variables:

### Google Sheets Integration (Reading Packages)

```env
# For reading travel packages from Google Sheets
GOOGLE_SHEET_ID=your_sheet_id_here
```

**How to get your Google Sheet ID:**
1. Open your Google Sheet
2. Make sure it's set to "Anyone with the link can view"
3. Copy the ID from the URL: `https://docs.google.com/spreadsheets/d/[SHEET_ID]/edit`

**Required Sheet Structure:**
Your Google Sheet should have these columns (case-insensitive):
- `name` or `Name` - Package name
- `destination` or `Destination` - Location
- `duration` or `Duration` - Trip length (e.g., "7 Days / 6 Nights")
- `price` or `Price` - Price (e.g., "$2,499")
- `description` or `Description` - Package description
- `category` or `Category` - Type (e.g., "Beach", "Adventure", "Cultural")
- `image` or `Image` (optional) - Image URL
- `rating` or `Rating` (optional) - Rating out of 5
- `maxPeople` or `MaxPeople` (optional) - Capacity

### GoHighLevel Integration (Lead Management & Bookings)

```env
# GoHighLevel API credentials
GOHIGHLEVEL_API_KEY=your_api_key_here
GOHIGHLEVEL_LOCATION_ID=your_location_id_here

# Optional: Pipeline ID for creating opportunities
GOHIGHLEVEL_PIPELINE_ID=your_pipeline_id_here
```

**How to get your GoHighLevel credentials:**

1. **API Key:**
   - Log in to your GoHighLevel account
   - Go to Settings > API Keys
   - Click "Create API Key"
   - Give it a name (e.g., "Travel Website")
   - Copy the API key

2. **Location ID:**
   - In GoHighLevel, go to Settings > Business Profile
   - Your Location ID is displayed at the top
   - Or find it in the URL: `https://app.gohighlevel.com/location/[LOCATION_ID]`

3. **Pipeline ID (Optional):**
   - Go to Opportunities > Pipelines
   - Click on the pipeline you want to use
   - Copy the Pipeline ID from the URL

**What happens when a lead is submitted:**
- Contact is created in GoHighLevel with all form data
- Tags are automatically applied (e.g., "travel-lead", package name)
- Custom fields store package interest, travel dates, and message
- If Pipeline ID is configured, an opportunity is created automatically
- You can set up automations in GoHighLevel to:
  - Send confirmation emails
  - Trigger SMS follow-ups
  - Assign to sales team
  - Create tasks and reminders

## Installation

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

## Deployment

### Deploy to Vercel (Recommended)

1. Push your code to GitHub
2. Import project in Vercel
3. Add environment variables in Vercel dashboard:
   - `GOOGLE_SHEET_ID`
   - `GOHIGHLEVEL_API_KEY`
   - `GOHIGHLEVEL_LOCATION_ID`
   - `GOHIGHLEVEL_PIPELINE_ID` (optional)
4. Deploy

### Performance Optimizations

This site is optimized for speed:
- Server-side rendering (SSR) for SEO
- Image optimization with Next.js Image
- Minimal JavaScript bundle
- CSS-in-JS with Tailwind CSS v4
- Revalidation caching for Google Sheets data (5 minutes)

## SEO Features

- Semantic HTML structure
- Meta tags and Open Graph
- Structured data ready
- Mobile-first responsive design
- Fast loading times
- Accessible components

## Customization

### Update Site Information

Edit `app/layout.tsx` to update:
- Site title
- Description
- Keywords
- Social media metadata

### Update Colors

Edit `app/globals.css` to customize the color scheme using CSS variables.

### Add More Packages

If not using Google Sheets, edit the `samplePackages` array in `app/page.tsx`.

## GoHighLevel Automation Ideas

Once leads are in GoHighLevel, you can set up powerful automations:

1. **Instant Follow-up**: Send personalized email/SMS when lead submits
2. **Nurture Sequences**: Drip campaigns based on package interest
3. **Booking Reminders**: Automated reminders for travel dates
4. **Sales Assignment**: Auto-assign leads to team members
5. **Lead Scoring**: Track engagement and prioritize hot leads
6. **Calendar Booking**: Include booking links in follow-ups

## Support

For issues or questions, please refer to the Next.js documentation or contact support.
