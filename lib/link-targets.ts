// Pure config for the Link building workspace (/admin/links-building). No imports, no network, no database.
// Every item is something the owner does by hand: nothing here sends, posts or buys anything.
// Rules: no invented URLs (we give the official site NAME and a search phrase, the owner finds the link), no paid
// links, no spam, no automated outreach. Copy has no em dashes.

export type LinkStatus = 'todo' | 'doing' | 'done' | 'skipped'
export const LINK_STATUSES: LinkStatus[] = ['todo', 'doing', 'done', 'skipped']

export type LinkGroup = 'listings' | 'social' | 'reviews' | 'partners' | 'host' | 'associations' | 'pr'

export type Level = 'low' | 'medium' | 'high'

/** Which message templates a task offers. */
export type DraftKind = 'directory' | 'partner' | 'review' | 'agent_page' | 'association' | 'pitch' | 'bio' | 'none'

export interface LinkTarget {
  /** Stable id: lowercase letters, digits and dashes. Saved task status is keyed by it. */
  id: string
  group: LinkGroup
  title: string
  /** One or two plain sentences: what to do. */
  how: string
  /** What to type into a search engine to find the real page. Never a URL. */
  searchPhrase: string
  /** The official site's name, so the owner knows which result is the real one. Never a URL. */
  officialSite: string
  effort: Level
  /** Expected value for ranking and trust. */
  value: Level
  /** True when the task asks for the name, address and phone, so the NAP block is shown. */
  needsNap: boolean
  drafts: DraftKind[]
  /** True for items we cannot assume (memberships): the owner ticks "I hold this" before the task counts. */
  askHolds?: boolean
  /** True for ideas only (no outreach script is generated for them beyond a short pitch). */
  ideaOnly?: boolean
}

export const GROUP_LABELS: Record<LinkGroup, string> = {
  listings: 'Free business listings and profiles',
  social: 'Social profile bios',
  reviews: 'Reviews',
  partners: 'Partner and supplier link requests',
  host: 'Host agency and consortium',
  associations: 'Travel associations',
  pr: 'Local PR and guest post ideas',
}

export const GROUP_ORDER: LinkGroup[] = ['listings', 'social', 'reviews', 'partners', 'host', 'associations', 'pr']

export const GROUP_BLURBS: Record<LinkGroup, string> = {
  listings: 'Free, real profiles on well-known sites. Each one is a link back to us and a trust signal. Paste the same name, address and phone every time.',
  social: 'Put our bio link in each profile. The link goes to our /links page, which lists the newest guides, trips and posts.',
  reviews: 'Real reviews from real travellers. Ask only people who travelled with you, never offer anything in return.',
  partners: 'Ask the companies we actually sell to link to our page about them. Built from your published trips and your affiliate partners.',
  host: 'If you sell under a host agency or consortium, ask for a link to your agent page from theirs.',
  associations: 'Only memberships you already hold. Tick the ones you have, we do not assume any.',
  pr: 'Ideas only. Nothing is sent for you. Pick one or two, write them yourself, and send from your own email.',
}

export const LINK_TARGETS: LinkTarget[] = [
  // ---- free listings and profiles ----
  { id: 'google-business-profile', group: 'listings', title: 'Google Business Profile', how: 'Claim or create the profile, add the website, hours and category (Travel agency), then complete the verification Google asks for.', searchPhrase: 'Google Business Profile create listing', officialSite: 'Google Business Profile', effort: 'medium', value: 'high', needsNap: true, drafts: ['directory'] },
  { id: 'bing-places', group: 'listings', title: 'Bing Places for Business', how: 'Claim or add the business. Bing can import from your Google profile, which keeps the details identical.', searchPhrase: 'Bing Places for Business add business', officialSite: 'Bing Places for Business', effort: 'low', value: 'medium', needsNap: true, drafts: ['directory'] },
  { id: 'apple-business-connect', group: 'listings', title: 'Apple Business Connect', how: 'Claim the listing so it shows correctly in Apple Maps and Siri. Add the website and phone.', searchPhrase: 'Apple Business Connect add your business', officialSite: 'Apple Business Connect', effort: 'low', value: 'medium', needsNap: true, drafts: ['directory'] },
  { id: 'facebook-page', group: 'listings', title: 'Facebook page: About section', how: 'In the About section of the existing page, set the website, phone and address to the exact details below.', searchPhrase: 'Facebook page edit About website phone address', officialSite: 'Facebook (Meta)', effort: 'low', value: 'medium', needsNap: true, drafts: ['directory'] },
  { id: 'linkedin-company-page', group: 'listings', title: 'LinkedIn company page', how: 'Create or update the company page with the website, a short description and the location.', searchPhrase: 'LinkedIn create a company page', officialSite: 'LinkedIn', effort: 'low', value: 'medium', needsNap: true, drafts: ['directory'] },
  { id: 'yelp-canada', group: 'listings', title: 'Yelp Canada business page', how: 'Claim or add the business on the Canadian Yelp site. Add the website and the same name, address and phone.', searchPhrase: 'Yelp for Business claim your business Canada', officialSite: 'Yelp (Canada)', effort: 'low', value: 'medium', needsNap: true, drafts: ['directory'] },
  { id: 'bbb-canada', group: 'listings', title: 'Better Business Bureau Canada', how: 'Look up whether a profile already exists for the business, then claim or request one. Accreditation is optional and may cost money, the basic profile does not need it.', searchPhrase: 'Better Business Bureau Canada business profile', officialSite: 'Better Business Bureau (BBB) Canada', effort: 'medium', value: 'medium', needsNap: true, drafts: ['directory'] },
  { id: 'yellow-pages-canada', group: 'listings', title: 'Yellow Pages Canada free listing', how: 'Add the free basic listing only. Skip any paid upgrade offered.', searchPhrase: 'Yellow Pages Canada add free business listing', officialSite: 'Yellow Pages (Canada)', effort: 'low', value: 'low', needsNap: true, drafts: ['directory'] },
  { id: 'local-chamber', group: 'listings', title: 'Local chamber of commerce or board of trade', how: 'Check whether the Toronto area board of trade or a local chamber lists members with a website link. Join only if the fee makes sense to you.', searchPhrase: 'Toronto board of trade chamber of commerce member directory', officialSite: 'Toronto Region Board of Trade or your local chamber', effort: 'high', value: 'medium', needsNap: true, drafts: ['directory'] },
  { id: 'trustpilot', group: 'listings', title: 'Trustpilot business profile (free plan)', how: 'Claim the free profile. Use only the free plan.', searchPhrase: 'Trustpilot for business claim profile free', officialSite: 'Trustpilot', effort: 'low', value: 'medium', needsNap: true, drafts: ['directory'] },

  // ---- social bios (point at /links) ----
  { id: 'instagram-bio', group: 'social', title: 'Instagram bio link', how: 'Set the profile website to the /links page so every reel and post sends people to the newest guides and trips.', searchPhrase: 'Instagram edit profile website link', officialSite: 'Instagram', effort: 'low', value: 'medium', needsNap: false, drafts: ['bio'] },
  { id: 'tiktok-bio', group: 'social', title: 'TikTok bio link', how: 'Add the /links page as the website on the profile.', searchPhrase: 'TikTok add website link to profile', officialSite: 'TikTok', effort: 'low', value: 'low', needsNap: false, drafts: ['bio'] },
  { id: 'pinterest-bio', group: 'social', title: 'Pinterest profile website', how: 'Add and claim the website on the Pinterest profile, then use the /links page in the bio.', searchPhrase: 'Pinterest claim your website', officialSite: 'Pinterest', effort: 'low', value: 'medium', needsNap: false, drafts: ['bio'] },
  { id: 'youtube-about', group: 'social', title: 'YouTube channel About links', how: 'If there is a channel, add the website and the /links page to the About section.', searchPhrase: 'YouTube channel customization add links', officialSite: 'YouTube', effort: 'low', value: 'low', needsNap: false, drafts: ['bio'] },

  // ---- reviews ----
  { id: 'google-review-request', group: 'reviews', title: 'Ask past travellers for a Google review', how: 'Pick three to five people who really travelled with you. Send each one a short personal message with the review link from your Google Business Profile. Never offer anything in return.', searchPhrase: 'Google Business Profile share review link', officialSite: 'Google Business Profile', effort: 'medium', value: 'high', needsNap: false, drafts: ['review'] },
  { id: 'trustpilot-review-request', group: 'reviews', title: 'Ask past travellers for a Trustpilot review', how: 'Same idea once the free Trustpilot profile is claimed. Ask only real travellers, one message each.', searchPhrase: 'Trustpilot invite reviewers business', officialSite: 'Trustpilot', effort: 'medium', value: 'medium', needsNap: false, drafts: ['review'] },

  // ---- host agency / consortium ----
  { id: 'host-agency-agent-page', group: 'host', title: 'Link from your host agency agent page', how: 'If you book under a host agency, check whether it has an agent profile page that can show a link to this site. Ask your contact there.', searchPhrase: 'your host agency name agent profile page website link', officialSite: 'Your host agency (use the official site you already log in to)', effort: 'low', value: 'high', needsNap: true, drafts: ['agent_page'] },
  { id: 'consortium-agent-directory', group: 'host', title: 'Consortium or network agent directory', how: 'If you belong to a consortium or travel network with an agent directory, ask for your listing to include this website.', searchPhrase: 'your consortium name find an agent directory', officialSite: 'Your consortium (official site only)', effort: 'low', value: 'medium', needsNap: true, drafts: ['agent_page'] },

  // ---- associations: only if already held ----
  { id: 'assoc-acta', group: 'associations', title: 'Association of Canadian Travel Agencies (ACTA)', how: 'If you are a member, check your member profile or find-an-agent listing for a website field.', searchPhrase: 'ACTA Association of Canadian Travel Agencies member', officialSite: 'ACTA', effort: 'low', value: 'medium', needsNap: true, drafts: ['association'], askHolds: true },
  { id: 'assoc-clia', group: 'associations', title: 'Cruise Lines International Association (CLIA)', how: 'If you hold CLIA agent membership, check the member profile for a website field.', searchPhrase: 'CLIA cruise agent member profile', officialSite: 'CLIA', effort: 'low', value: 'medium', needsNap: true, drafts: ['association'], askHolds: true },
  { id: 'assoc-asta', group: 'associations', title: 'ASTA (American Society of Travel Advisors)', how: 'If you are a member, check your member profile for a website field.', searchPhrase: 'ASTA American Society of Travel Advisors member profile', officialSite: 'ASTA', effort: 'low', value: 'medium', needsNap: true, drafts: ['association'], askHolds: true },
  { id: 'assoc-tico', group: 'associations', title: 'Ontario registration listing (TICO)', how: 'If the agency is registered in Ontario, check the public registrant record for a website field. Edit only what the registrar allows.', searchPhrase: 'TICO Travel Industry Council of Ontario registrant', officialSite: 'TICO', effort: 'low', value: 'low', needsNap: true, drafts: ['association'], askHolds: true },

  // ---- local PR and guest post ideas (ideas only) ----
  { id: 'pr-canadian-travel-bloggers', group: 'pr', title: 'Idea: Canadian travel bloggers', how: 'Find two or three Canadian travel bloggers who write about group trips or cruises. Read their recent posts first, then offer something genuinely useful, such as a guide they could cite. No mass emails.', searchPhrase: 'Canadian travel blog group travel cruises', officialSite: 'Not applicable: choose blogs you already read', effort: 'high', value: 'medium', needsNap: false, drafts: ['pitch'], ideaOnly: true },
  { id: 'pr-community-newsletters', group: 'pr', title: 'Idea: community newsletters', how: 'Local community, church, club or alumni newsletters sometimes run a short item on a group trip. Offer a short item to one or two you actually belong to.', searchPhrase: 'Toronto community newsletter submit local business news', officialSite: 'Not applicable: choose groups you belong to', effort: 'medium', value: 'low', needsNap: false, drafts: ['pitch'], ideaOnly: true },
  { id: 'pr-local-news', group: 'pr', title: 'Idea: a local story angle', how: 'A real hosted trip with a real story (a milestone group, a first cruise) can be a local news item. Only pitch it if the story is true and the travellers agree.', searchPhrase: 'Toronto local news submit story tip', officialSite: 'Not applicable: choose outlets that cover your area', effort: 'high', value: 'medium', needsNap: false, drafts: ['pitch'], ideaOnly: true },
]

/** Words and patterns the generated copy must never contain: prices, response-time promises, superlatives we cannot back. */
export const COPY_BANNED = [/\$\s?\d/, /\bwithin\s+\d+\s*(?:hours?|minutes?|days?)\b/i, /\bsame[-\s]day\b/i, /\b24\s*\/\s*7\b/, /\bbest\b/i, /\bcheapest\b/i, /\bguarantee/i, /\blowest price/i, new RegExp(String.fromCharCode(0x2014))]

export const MAX_TASKS_STORED = 300
export const MAX_NOTE_LENGTH = 500
export const MAX_EARNED = 500
export const MAX_PARTNER_TASKS = 40
