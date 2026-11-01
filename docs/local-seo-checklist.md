# Local SEO checklist (Google Business Profile and directories)

Plain steps for Joel. Grade-5 reading level on purpose. Do them in order. Tick each one off.

## What the site already does (nothing to build)

- The home page already tells Google we are a travel agency (TravelAgency structured data) with our name, phone, street address, city, province, postal code, logo and social pages. It also now says we serve Canada, and gives a customer service phone. All of it is read from `lib/site.ts`, so it cannot drift from the footer.
- The pages Google reads about places (`/destinations`, guides, blog, `/agents`) already have their own structured data, and they now point back to the same business.
- `/from/toronto` and the other city pages already exist. They only go in the sitemap while there is an upcoming trip to show. That is correct, keep it.
- The site does NOT claim opening hours, a map pin, a price range, star ratings or review counts. We do not store them, so we do not say them. Google can penalize made-up ratings.

## Facts Joel must supply

The site cannot invent these. Send them over and they get added.

1. Is 375 University Avenue, Suite 1072, Toronto a real office where people can walk in, or a mailbox or shared suite? This decides which Google Business Profile type you pick (see step 2). Google bans profiles that use a virtual office as a storefront.
2. Opening hours, if you want them shown (days and times, time zone Toronto).
3. The legal business name exactly as registered, if it differs from "TravelFunBiz.ca" (the footer says Florida and California Seller of Travel numbers; a Canadian registration, if any, is not in the repo).
4. Do you serve travelers outside Canada from this site? The schema now says "Canada" only. Tell us if it should add the United States or other places.
5. The link to your Google Business Profile once it is verified (the "Share profile" link). It then goes into `sameAs` and the footer.
6. Your real Google review count and rating, only if you want them on the site. We will link to the profile instead of printing numbers.
7. Photos you own: storefront or office if real, you with groups on trips, a team photo (with permission from the people in them).
8. Which email address should be public (the site shows a phone only today).

## Step 1: Keep name, address and phone the same everywhere (NAP)

NAP means Name, Address, Phone. Google trusts you more when every site shows the same ones.

Copy these exactly. Do not shorten "Avenue" to "Ave" in one place and not another.

- Name: TravelFunBiz.ca
- Address: 375 University Avenue, Suite 1072, Toronto, ON M5G 2J5
- Phone: (833) 878-5386

The admin page "Link building" has a NAP check that compares the site and the structured data. Run it after any change.

Use the same name, address and phone on: Google Business Profile, Facebook, Instagram, TikTok, YouTube, Pinterest, Bing Places, Apple Business Connect, every directory below, and your email signature.

## Step 2: Make or claim the Google Business Profile

1. Go to business.google.com and sign in with the Google account you want to own it. Use a shared business account, not a personal one.
2. Search for "TravelFunBiz". If a profile already exists, click "Claim". If not, click "Add your business".
3. Business name: exactly as in Step 1. Do not add keywords like "Best Cruises Toronto". Google removes those.
4. Pick the type:
   - If people can walk into the office: a normal business with the address shown.
   - If you work online or by phone: choose "I deliver goods and services to my customers" and hide the address. Add "Canada" or your real service areas (cities you serve).
5. Verify. Google asks for a postcard, a phone call, an email or a video. Do what it asks. Nothing shows until verified.
6. Turn on messages only if you will answer them within a day.

## Step 3: Categories

- Main category: Travel agency.
- Extra categories (pick only what is true): Tour operator, Cruise agency (if offered in the list), Travel services.
- Do not add more than five. Extra random ones water down the main one.

## Step 4: Fill every box

- Description (up to 750 characters): who the trips are for (singles, groups, river and ocean cruises), that you are real advisors, and where you serve. No prices, no "best", no phone number or link in it.
- Hours: only what is true. If you take calls by appointment, say "by appointment".
- Phone: (833) 878-5386 as the main number.
- Website: https://www.travelfunbiz.ca/ (add `?utm_source=google&utm_medium=organic&utm_campaign=gbp` so you can see these visits in analytics).
- Services: add each service with a short plain line (hosted group trips, river cruises, ocean cruises, singles getaways).
- Appointment link: point it at the "Book a free call" page.
- Products: add 3 to 5 current trips with a photo and a link.

## Step 5: Photos

- Add at least 10 real photos in the first month. Real beats pretty.
- Logo, cover photo, group photos from trips, a team photo, an office photo if real.
- Name files like `travelfunbiz-singles-cruise-group.jpg` before uploading.
- Add 2 new photos a month. Posts and photos tell Google you are open.
- Only use photos you own or have permission to use. Ask guests first.

## Step 6: Reviews (the biggest local ranking help)

Ask every happy traveler after the trip, while they are still smiling. Never pay for reviews, never offer a gift or discount for one, and never write your own. Google and the Canadian Competition Bureau both treat that as fake.

Short message to send (text or email):

> Hi [first name], it was great having you on [trip]! If you have two minutes, would you share an honest review of your experience? It helps other travelers find us. Here is the link: [Google review link]. Thank you!

To get the link: in your Google Business Profile click "Ask for reviews" and copy the short link. Also make a QR code from it for printed trip cards.

Answer every review within a few days:
- Happy review: thank them by first name and mention one detail from their trip.
- Unhappy review: say sorry, say you will call, and give the phone number. Never argue in public.

## Step 7: Posts and Q and A

- Post once a week: an upcoming departure, a new guide or blog article, a trip photo. Use "Learn more" buttons that go to the matching page.
- Add the top 5 questions people ask (deposits, solo travelers, cruise vs tour, what is included, who comes on the trips) with answers. Answer them yourself, in your own words.

## Step 8: Listings in other places

Do these after the Google profile. Use the exact NAP from Step 1 each time.

Search and maps (free, do first):
- Bing Places for Business (bingplaces.com). Also feeds Copilot and DuckDuckGo.
- Apple Business Connect (businessconnect.apple.com).
- Facebook Page "About" box and Instagram profile: same NAP, website link.

Canadian directories worth the time:
- Yelp.ca
- Yellow Pages Canada (yellowpages.ca)
- Canada411
- 411.ca
- Better Business Bureau (the .com site shows a BBB badge, so check if the BBB profile there lists Canada or a Toronto address; do not create two conflicting ones)
- Toronto Board of Trade or your local Chamber of Commerce (join only if the fee is worth it to you)
- Trip and travel industry lists you really belong to: CLIA and ASTA member pages (both badges are in the site footer, so make sure those profiles show the same NAP)
- TripAdvisor (for the agency, only if you want reviews from travelers there)
- Cylex Canada, Hotfrog Canada, Foursquare, Tupalo (low value, free, only if you have time)

Skip: paid "SEO directory" bundles, link farms, and any site that asks for a fee to "boost" you. They do harm.

## Step 9: Cities and regions (proposal, nothing was built)

Why nothing was built: the repo only has real facts for the Toronto address and for eight departure cities in `lib/from-cities.ts` (Toronto, Vancouver, Calgary, Montreal, Ottawa, Edmonton, Winnipeg, Halifax). Those eight already have `/from/<city>` pages built from real trips. Making more pages like "Travel agency in Mississauga" with swapped city names would be thin copy, and Google marks that as spam. It would hurt the whole site.

If you want more city pages, each needs real, true things only you know:
- A real person or event tied to that city (an info night, a local group, a partner).
- Real departure facts (which airports your guests actually fly from, local pickup if any).
- A real client story from someone in that city, with permission.

Send those and we build the page with that content. Without them, do Google Business Profile service areas instead (Step 2), which costs nothing and has no thin-page risk.

## Step 10: Check it worked

- After one week, in Google Search Console open "Performance" and look at queries with a city name. Impressions should grow.
- In Google Business Profile, open "Performance" and look at calls and website clicks.
- Test the structured data: paste https://www.travelfunbiz.ca/ into search.google.com/test/rich-results. The page should show a TravelAgency with no errors.
- Re-check NAP every 3 months. If you ever move or change the phone, change every place in this list the same day.
