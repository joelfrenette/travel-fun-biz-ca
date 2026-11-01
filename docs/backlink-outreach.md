# Backlink outreach plan for TravelFunBiz.ca

Written 2026-11-01. Docs only. Nothing here sends anything; every message is sent by Joel, by hand.

Why this exists: the site earned about 393 Google impressions and 0 clicks in a month. Content volume is not the bottleneck, authority is. A backlink is a link from someone else's site to ours that a real person put there on purpose. A handful of real ones beats hundreds of junk ones.

Related tool already in the repo: the admin page `/admin/links-building` (config in `lib/link-targets.ts`) tracks free listings, host-agency pages and association profiles. Use it for the "claim a listing" tasks. This document covers the part it does not: asking people for links, with message templates and rules.

## 0. Read this first (honest caveats)

1. **Check the assets are live before pitching.** The country advisory pages sit behind the `app_settings` key `country_advisories_mode` (off by default per `docs/country-advisory-pages-design.md`) and the quiz behind `trip_quiz_mode` (also off by default). Open `/travel-advisories` and `/trip-quiz` in a private window. If either is a 404, do not pitch it. A pitch that lands on a 404 burns the contact for good.
2. **We are a thin link target on our own.** Our country pages restate government advisories (Canada, UK, US State Department) with a dated log. A librarian or journalist can link the government source directly. Pitch the page only for what it adds: several governments side by side, plain English, a change log, and (once it exists) a "last changed" date. If it does not add that yet, fix the page first.
3. **Do not claim credentials we cannot show.** `content/footer.ts` shows CLIA, ASTA, IATAN, BBB and Boca Raton Chamber badges, and `lib/site.ts` lists Florida and California Seller of Travel numbers for a US entity (TravelFun LLC). I found no evidence in the repo of ACTA membership or an Ontario TICO registration for the Toronto address. Never write "ACTA member" or "TICO registered" in an email unless Joel can show the membership. Confirm which registrations actually apply to a Canadian-facing business with the registrar or counsel.
4. **Expect slow results.** Realistic target: 3 to 6 genuine links in the first 90 days. Links from pages that already list agencies (section 1, ranks 1 to 4) are the most likely to land.

## 1. Ranked link targets (by type)

Status key: **VERIFIED** = I confirmed the organisation or program exists from a web search or by loading the page on 2026-11-01. "Not verified" says what I could not confirm. I did not invent any contact or URL; where a page has no public contact, the row says to find it on the site itself.

| Rank | Type | Specific target | Status | Why they would link | Effort / odds |
| --- | --- | --- | --- | --- | --- |
| 1 | Supplier "find an agent" and cruise-industry directories | Sandals "Find a Travel Agency" locator, reached from https://www.sandals.com/about/travel-agent/ ; CLIA agency verification, https://cruising.org/en/verify-a-travel-agency-member | Sandals: VERIFIED to exist (search result; the page returned 403 to my fetch, so I could not read how listing works). CLIA: URL taken from our own footer, my fetch failed, so not re-verified | These pages exist to send shoppers to agents who actually sell the brand. A listing is a service to the supplier, not a favour. Only apply to programs we truly sell and hold a booking relationship with | Low effort, medium odds. Only if Joel really is a Sandals-appointed or CLIA-member seller |
| 2 | National agent association directory | ACTA Member Travel Directory, https://acta.ca/travel-directory (consumer search by location and specialization). Membership info: https://acta.ca/membership | VERIFIED. Could not confirm that listings carry a website link or how a member edits one; ask ACTA | Members are listed for consumers to find them; the website field is the point of the listing | Low effort if already a member. If not a member, this is a paid membership decision, not outreach |
| 3 | Directories we are already in | Boca Raton Chamber member page (https://web.bocaratonchamber.com/TRAVEL-AGENCIES/TravelFunbiz-15987), BBB profile, ASTA advisor directory (https://www.asta.org/travelerServices/advisor-directory) | URLs are from `content/footer.ts` (the live .com footer); not re-fetched, so listed as **existing, not re-verified** | The link relationship already exists. Check each profile's website field points to the .ca or the right site (the .com may later redirect). A free fix, no outreach | Very low effort, high odds. Do this first |
| 4 | Host agency / consortium agent pages | Whatever host agency or network Joel books under (already a task in `lib/link-targets.ts`: `host-agency-agent-page`, `consortium-agent-directory`) | Not verified: the host's name is not in the repo | Hosts publish agent profile pages and usually allow a website link | Low effort, high odds if the profile has a website field |
| 5 | Expert-source requests (the HARO replacement) | Source of Sources (SOS, free, email, run by Peter Shankman); Qwoted (free tier for experts, journalists use it free) | VERIFIED both exist. HARO/Connectively closed 9 Dec 2024 (Cision). Featured.com is paid, skip it per the no-paid-links rule below. I did not open either site's sign-up page, so check current terms | Journalists post requests for quotes; a useful quote often comes with a byline link. Fits Joel's real expertise: cruise and resort planning, group and singles travel, advisories | Medium effort (answer fast, only when you truly fit), medium odds. Most replies earn nothing; one hit can be a strong link |
| 6 | Canadian travel trade press | Travelweek (https://www.travelweek.ca) | VERIFIED the publication exists (appears in search, runs Canadian trade news). Not verified: how it accepts news tips or guest items. Find its contact or "send us news" page on the site | Trade press runs agency milestones, new group departures, and agent commentary. Needs a real news hook, not "we have a website" | Medium effort, low to medium odds. Needs something newsworthy (a hosted group trip, a survey of travellers) |
| 7 | Local news "travel tips" and community newsletters | Local paper, community newsletter, club or alumni newsletter near the Toronto office | Type only. No named outlet verified; Joel picks real ones he can name | Local editors want a quick seasonal tip with a named local expert (cruise first-timer tips, solo travel safety) | Medium effort, medium odds locally. Pitch by named editor, never a mass list |
| 8 | Student and staff travel-safety resource pages | Canadian university international offices already link Government of Canada advisories. Examples that exist: Memorial https://mun.ca/goabroad/safety-abroad/ , VIU https://international.viu.ca/global-engagement/travel-safety-resouces , UBC https://srs.ubc.ca/ (international travel resources), McMaster https://global.mcmaster.ca/home/informed-travel/ | VERIFIED these pages exist and link to advisories. I did not confirm any accepts outside suggestions | Their pages are resource lists. We could be a "plain-English, several governments, with change log" extra. | Low odds. They prefer official sources. Try two or three at most, never a mass mailing |
| 9 | Local business cross-links | A non-competing local business with a real tie to us: a travel photographer, luggage or passport photo shop, a social club for singles, a fitness studio running a group trip | Type only | A genuine local partnership (share a trip, run a talk) often comes with a "partners" or "friends" link | Medium effort, medium odds. Keep it to real relationships, never a swap list |
| 10 | Chamber of commerce / board of trade | Toronto Region Board of Trade, https://bot.com/membership | VERIFIED exists. Corporate membership from about $1,600 a year; the member directory is members only, so it is probably not a public backlink | Little SEO value for the price. Listed so Joel can skip it with a clear conscience. Boca Raton Chamber (rank 3) already covers the US side | Not recommended for links alone |
| 11 | Reddit and Quora answers, done honestly | r/solotravel, r/canadatravel, r/travel, Quora travel questions | Subreddits exist. Their current rules I could not read directly. Mirrors suggest r/canadatravel asks you to message moderators before promoting; r/backpacking bans self-promotion. Read each sidebar before posting | These links are normally nofollow (no direct ranking boost). The gain is trust, referrals and being quoted by AI answer engines. Never drop the link in the first reply | Low direct SEO value. Do it as helpful answers with a disclosed affiliation, about 9 helpful replies for each link |
| 12 | Tourism boards and destination programs | Destination "specialist" programs (e.g. Mexico Tourism Board's Canada-specific Mexico Specialist Course, reported by Travelweek) | Mixed: the course is reported, but one headline says the board closed most offices including Canada. **Not verified as current. Do not list it until Joel confirms the program is live** | Boards link to certified or specialist agents. Only worth it for destinations we sell and can show training for | Medium effort, uncertain odds |

Order of work: ranks 3 and 4 first (free, certain), then 1 and 2 if the memberships are real, then 5 (weekly habit), then 6 to 9 only with a real hook.

## 2. Outreach email templates

Voice: plain Canadian English, short, one ask, easy to say no. Merge fields are in `{{double braces}}`. Replace every one by hand and delete lines that do not apply. Never send a template unedited.

Sender block to end every email (CASL requires it, see section 3):

```
{{Your name}}, {{Title}}
TravelFunBiz.ca
375 University Avenue, Suite 1072, Toronto, ON M5G 2J5
{{phone}} | {{reply-to email}}
If you would rather not hear from me again, reply "no thanks" and I will remove you right away.
```

(The address above is the Toronto address in `lib/site.ts`. Use the address CASL-registered mail should show; confirm it with counsel.)

### Template A: partner / supplier listing request

Subject: Listing request for TravelFunBiz.ca on your agent finder

```
Hi {{First name}},

I run {{Agency/Brand}}, a travel agency that books {{Supplier}} trips for Canadian travellers, mostly {{specific: groups, singles, cruises}}. {{One real proof point, e.g. "We have booked X sailings with you since {{year}}" or "We hold your {{program}} certification, number {{id}}"}}.

I could not find our site on your "find a travel agent" page. If listings include a website field, could we add https://travelfunbiz.ca? If there is a form or a different contact for this, point me to it and I will take it from there.

Thanks for your time,
{{Sender block}}
```

### Template B: resource-page suggestion (cites the advisory pages)

Subject: A plain-English page that tracks travel advisory changes

```
Hi {{First name}},

I was reading your page "{{Their page title}}" ({{their URL}}) and it was clear and useful, especially {{one specific thing you actually liked}}.

One idea for it. We keep a page for each country that shows the current Government of Canada, UK and US advisory side by side, with a dated log of when the level or wording changed, and a link to each official source: https://travelfunbiz.ca/travel-advisories/{{country}} (index: https://travelfunbiz.ca/travel-advisories). It does not replace the official page. It just makes changes easier to spot.

If it fits, it might be a helpful extra link next to {{the official link they already have}}. If it does not suit your page, no problem at all.

{{Sender block}}
```

Only send this after checking that the page you name works and shows a real log for that country.

### Template C: journalist expert-source pitch

Use inside Source of Sources or Qwoted replies, or by email to a named reporter who has covered this before. Answer the actual question first.

Subject: Re: {{their request title}}: travel agent for {{angle}}

```
Hi {{Reporter first name}},

Short answer to your question on {{topic}}: {{your direct answer in two to three sentences, with one specific, checkable detail from real experience}}.

Some context if you need it: I am {{Name}}, a travel advisor with {{N years}} planning {{cruises/group trips/solo trips}} for Canadians. Happy to be quoted by name, on the record, and to send photos or a booking example (with the traveller's permission).

I am reachable at {{phone}} until {{deadline time and timezone}}. A link to {{TravelFunBiz.ca or a relevant guide URL}} is welcome if it fits your style, but it is up to you.

{{Sender block}}
```

Rules: reply only when you truly fit, answer within the hour, never offer a link in exchange for coverage, never fabricate numbers or experience.

### Template D: local business cross-link

Subject: Idea for {{their business}} and our {{event/trip}}

```
Hi {{First name}},

I am {{Name}} at {{Agency}} here in {{Neighbourhood/City}}. I am a customer at {{their business}} ({{one real detail}}).

We are running {{a real trip, talk or event}} for {{audience}} on {{date}}. I thought your {{members/customers}} might enjoy it, and I would be glad to {{a real thing of value for them, e.g. give a free 20-minute travel safety talk, offer their members a group rate}}.

If it suits you, a mention or link on your {{events/partners page or newsletter}} would be great, and I would do the same for you on our site if it is genuinely useful to our travellers. If not, thanks for reading.

{{Sender block}}
```

Keep it to one-off partnerships you could explain to a customer. See the link-swap rule in section 3.

### Template E: guest tip

Subject: Guest tip for {{Publication / column name}}: {{working title}}

```
Hi {{Editor first name}},

I read your piece "{{their article title}}" ({{URL}}) and enjoyed {{specific thing}}.

I would like to offer a short tip piece for your readers: "{{title, e.g. 5 things first-time cruisers forget to book}}". It would be about {{word count}} words, based on {{your real experience}}, with no sales pitch. I would only ask for a short author line with my name and site.

Here is the opening paragraph so you can judge the tone:
{{two to three sentences}}

Happy to adjust the angle, length or deadline, or to drop it if it does not fit.

{{Sender block}}
```

## 3. Rules to stay safe

**Hard no (these can get the site penalised by Google or the agency in trouble):**
- No paid links, no "sponsored post" that passes a link without rel="sponsored", no buying links or link packages, no "guaranteed backlinks" services.
- No link exchanges at scale. A one-off, genuinely useful reciprocal mention with a real partner is fine; a spreadsheet of swaps is a link scheme.
- No fake reviews, fake testimonials or fake "experts". Ask only real travellers for reviews, and never offer a discount or gift in return for a review.
- No mass or automated email, no scraped lists, no AI-written pitches sent unreviewed, no pretending to be a reader, a customer or a journalist.
- No private blog networks, comment spam, or profile spam on forums. On Reddit and Quora, disclose that you are the agency when it is relevant and follow each community's rules.
- Do not send a pitch about a page that is not live or that you have not read.

**CASL (Canada's anti-spam law).** Any email that promotes the business or asks for a link can count as a "commercial electronic message" if one of its purposes is to encourage commercial activity. For a Canadian recipient you generally need all three:
1. **Consent**, either express (they said yes) or implied (for example an existing business relationship, or the narrow "conspicuously published business address" rule).
2. **Sender identification**: your name, the business name, a mailing address, and working contact details (the sender block above).
3. **A working unsubscribe**, honoured promptly (sources say within 10 business days; honour it immediately).

**Flag for Joel: cold B2B outreach has conditions and I am not a lawyer.** Facts I confirmed from the CRTC guidance and law-firm summaries of the 2020 Federal Court of Appeal decision on Compu.Finder (sources: https://crtc.gc.ca/eng/com500/faq500.htm and law-firm notes at https://www.torys.com and https://www.blg.com; my fetch of the CRTC page itself was blocked, so these come from the summaries):
- The business-to-business exemption needs a real, provable existing relationship, and a handful of transactions may not be enough.
- The "conspicuous publication" rule needs a published business address with no "no unsolicited email" notice, and the message must relate to the recipient's business role. It does not allow harvesting addresses from directories.
- The sender must be able to prove it; keep records of when and how consent was obtained.

Practical, lower-risk approach until counsel confirms: use web forms and contact pages the recipient published for exactly this purpose, answer journalist requests posted to you, make the first message about their work rather than selling, include the sender block and a clear opt-out, and keep a log (section 4). **Confirm the above with Canadian counsel before the first cold email.** The same caution applies if the recipient is outside Canada (other countries have their own rules, e.g. US CAN-SPAM) or if a message could be read as promoting the business.

## 4. Tracking table template

Copy this into a sheet or the admin tracker. One row per contact. Keep it; CASL consent evidence depends on it.

| ID | Target (org + type) | Contact name + role | Where the contact came from (URL) | Consent basis (express / implied: what) | Template used | Page we pitched | Date sent | Follow-up date | Status (todo / sent / replied / link live / declined / no reply) | Link URL + date seen live | Link type (follow / nofollow, one-off or listing) | Notes + opt-out? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | | | | | | | |

Rules for the table: one follow-up only, 7 to 10 days later, then stop; if someone says "no" or "unsubscribe", mark opt-out and never contact them again; record every live link and re-check the 1st of each month.

## 5. Weekly 30-minute routine

Same slot each week. Stop when the timer ends.

| Minutes | Task |
| --- | --- |
| 0 to 5 | Open `/travel-advisories` and `/trip-quiz` in a private window; confirm both load. Check last week's rows in the tracker for replies. |
| 5 to 15 | Scan Source of Sources and Qwoted requests. Answer at most 2 that you truly fit (Template C). Skip the rest. |
| 15 to 25 | Work one target from section 1 (start with ranks 3 and 4, then 1 and 2). Research the contact on the organisation's own site, write one personalised email from a template, send it, log it. |
| 25 to 30 | Send due follow-ups (one only), update statuses, note any new live link. On the 1st of the month, re-check all "link live" rows and Google Search Console (Links report) for new referring domains. |

Success check each month: number of new referring domains, number of replies, and whether impressions and clicks moved. If nothing lands after 8 to 10 well-aimed pitches, change the asset (make the page more useful) rather than sending more email.

## 6. What I verified and what I could not

Verified on 2026-11-01 (web search or page load): ACTA Member Travel Directory (acta.ca/travel-directory) and that it is a consumer-facing member directory; ACTA membership page; Sandals travel-agent page exists with an agency locator (seen in search, page returned 403 on fetch); Source of Sources and Qwoted exist and are free for experts to start; HARO/Connectively closed 9 Dec 2024; Toronto Region Board of Trade membership (bot.com/membership), member directory is members only and corporate membership starts near $1,600; Travelweek exists; the university example pages in rank 8; the CASL consent, identification and unsubscribe requirements (via summaries of CRTC guidance).

Could not verify: whether ACTA or Sandals listings carry a website link and how to apply; CLIA verification page content (fetch failed); how Travelweek takes tips; that the Mexico Tourism Board Canada program is currently live; current rules of r/travel and r/solotravel; the exact CASL text (read summaries, not the Act); whether the agency actually holds ACTA, TICO or any supplier appointments; the host agency's name; and whether any outlet or university will accept our link.
