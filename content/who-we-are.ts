// The written copy of /who-we-are. It lives here (not inside the page file) so the page and the word-linker's text list
// (lib/affiliate-text-sources.ts) read the very same strings. English only on purpose: see the note in app/who-we-are/page.tsx.

export const WHO_WE_ARE_INTRO = "A straight answer to the question we get asked most about our singles and group trips: no, this isn't a dating service."

export interface WhoWeAreSection {
  id: 'connection' | 'who' | 'agency'
  heading: string
  body: string
}

export const WHO_WE_ARE_SECTIONS: WhoWeAreSection[] = [
  {
    id: 'connection',
    heading: 'Connection, not matchmaking',
    body: "Our singles and group trips exist for one reason: traveling is more fun with people around you. Some of our travelers come alone and leave with a group of new friends. Some bring their sister, their best friend, or their mom. Some are a couple joining a group departure. What they have in common isn't relationship status - it's wanting a trip where they're never doing things solo unless they want to be.",
  },
  {
    id: 'who',
    heading: 'Who actually shows up',
    body: "Every group is different, and we don't screen for dating intent or run a matching algorithm. You're not signing up to be paired with anyone. You're signing up for a real trip, with real logistics, run by a real travel advisor - the people on it are simply other travelers who booked the same departure.",
  },
  {
    id: 'agency',
    heading: 'A real travel agency, not a platform',
    body: "We're a licensed travel agency that plans and books the trip end to end - flights, hotels, excursions, the details that actually go wrong if nobody's handling them. That's the job. Anything social that happens on a trip is a side effect of good people ending up in the same place, not the product we're selling.",
  },
]

export const WHO_WE_ARE_CLOSING = "Have a question before you book? Just ask - we'd rather answer it now than have you wonder."
