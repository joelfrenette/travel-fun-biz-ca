// A conservative, static list of plain place names (countries, regions, seas, continents, well-known islands and
// peninsulas) so the guide gate does not mistake geography for "a named venue or person not in the brief".
//
// It is used by namedThingsNotInBrief() in lib/guide-composer.ts. The rule it supports stays strict:
//   - a capitalised phrase passes ONLY when every word is either in the brief or a geography word, AND at least one
//     word is a real place name or a demonym (so "Hilton Cancun", "Royal Caribbean", "Ritz Carlton" still fail:
//     "Hilton", "Royal" and "Ritz" are not geography);
//   - the destinations stored for a brief never need this list: they are in the grounding text, which is "in the brief".
// Nothing here is a fact about a trip; it only says "this word is a place, not a business or a person".

/** Place names, lowercase. Multi-word names are listed once; each of their words is added to the word set below. */
const PLACE_NAMES: string[] = [
  // continents, oceans, seas, broad regions
  'africa', 'antarctica', 'asia', 'europe', 'oceania', 'north america', 'south america', 'central america', 'latin america', 'middle east', 'scandinavia', 'balkans', 'baltic', 'iberia', 'polynesia', 'micronesia', 'melanesia', 'south pacific', 'pacific', 'atlantic', 'arctic', 'indian ocean', 'caribbean', 'mediterranean', 'adriatic', 'aegean', 'ionian', 'tyrrhenian', 'red sea', 'black sea', 'north sea', 'caspian', 'baltic sea', 'persian gulf', 'gulf of mexico', 'gulf coast', 'bering sea', 'coral sea', 'tasman sea', 'sea of cortez', 'inside passage', 'caribbean sea', 'mediterranean sea', 'west indies', 'indochina', 'southeast asia', 'far east', 'eastern europe', 'western europe', 'northern europe', 'southern europe', 'central europe', 'british isles', 'channel islands', 'pacific northwest', 'new england', 'great lakes', 'rocky mountains', 'rockies', 'alps', 'pyrenees', 'andes', 'himalayas', 'sahara', 'serengeti', 'patagonia', 'tuscany', 'umbria', 'sicily', 'sardinia', 'provence', 'normandy', 'brittany', 'bordeaux', 'burgundy', 'champagne', 'alsace', 'bavaria', 'catalonia', 'andalusia', 'algarve', 'riviera', 'french riviera', 'italian riviera', 'amalfi coast', 'amalfi', 'cinque terre', 'dalmatian coast', 'costa del sol', 'costa brava', 'costa rica', 'cote d azur', 'yucatan', 'yucatan peninsula', 'riviera maya', 'riviera nayarit', 'baja', 'baja california', 'los cabos', 'cabo san lucas', 'iberian peninsula', 'balkan peninsula', 'kenai peninsula', 'olympic peninsula', 'istria', 'peloponnese', 'cyclades', 'dodecanese', 'canary islands', 'balearic islands', 'greek islands', 'hawaiian islands', 'cayman islands', 'virgin islands', 'british virgin islands', 'us virgin islands', 'windward islands', 'leeward islands', 'lesser antilles', 'greater antilles', 'turks and caicos', 'turks', 'caicos', 'abaco', 'exumas', 'galapagos', 'azores', 'madeira', 'faroe islands', 'aland islands', 'lofoten', 'norwegian fjords', 'fjords', 'danube', 'rhine', 'rhone', 'seine', 'moselle', 'main', 'elbe', 'douro', 'loire', 'garonne', 'dordogne', 'nile', 'mekong', 'mississippi', 'yangtze', 'amazon', 'ganges', 'volga', 'st lawrence', 'saint lawrence', 'niagara', 'niagara falls', 'yukon', 'okanagan', 'vancouver island', 'cape breton', 'prince edward island', 'newfoundland', 'labrador', 'nova scotia', 'new brunswick', 'quebec', 'ontario', 'manitoba', 'saskatchewan', 'alberta', 'british columbia', 'nunavut', 'northwest territories', 'banff', 'jasper', 'whistler', 'muskoka', 'gaspe', 'lake louise', 'lake tahoe', 'lake geneva', 'lake como', 'lake garda', 'lake constance', 'lake superior', 'lake ontario', 'lake michigan',
  // canada, us and mexico
  'canada', 'united states', 'usa', 'america', 'mexico', 'alaska', 'hawaii', 'florida', 'california', 'texas', 'nevada', 'arizona', 'colorado', 'utah', 'oregon', 'washington', 'montana', 'maine', 'vermont', 'massachusetts', 'new york', 'new jersey', 'new orleans', 'louisiana', 'georgia', 'carolina', 'north carolina', 'south carolina', 'virginia', 'tennessee', 'kentucky', 'alabama', 'mississippi', 'illinois', 'michigan', 'minnesota', 'wisconsin', 'ohio', 'pennsylvania', 'florida keys', 'key west', 'miami', 'orlando', 'las vegas', 'san diego', 'san francisco', 'los angeles', 'seattle', 'vancouver', 'victoria', 'calgary', 'edmonton', 'winnipeg', 'toronto', 'ottawa', 'montreal', 'halifax', 'cancun', 'cozumel', 'tulum', 'playa del carmen', 'puerto vallarta', 'mazatlan', 'acapulco', 'oaxaca', 'cabo',
  // caribbean and central america
  'jamaica', 'bahamas', 'nassau', 'bermuda', 'barbados', 'aruba', 'bonaire', 'curacao', 'antigua', 'barbuda', 'anguilla', 'dominica', 'grenada', 'montserrat', 'martinique', 'guadeloupe', 'st lucia', 'saint lucia', 'st kitts', 'nevis', 'st maarten', 'st martin', 'st barts', 'st thomas', 'st john', 'st croix', 'tortola', 'virgin gorda', 'trinidad', 'tobago', 'cuba', 'havana', 'varadero', 'hispaniola', 'dominican republic', 'punta cana', 'puerto plata', 'haiti', 'puerto rico', 'san juan', 'grand cayman', 'cayman', 'belize', 'honduras', 'roatan', 'guatemala', 'el salvador', 'nicaragua', 'panama', 'colon', 'costa rica',
  // south america
  'brazil', 'argentina', 'chile', 'peru', 'colombia', 'ecuador', 'bolivia', 'uruguay', 'paraguay', 'venezuela', 'guyana', 'suriname', 'rio de janeiro', 'buenos aires', 'machu picchu', 'cusco', 'lima', 'cartagena', 'quito', 'santiago', 'iguazu', 'easter island',
  // europe
  'united kingdom', 'england', 'scotland', 'wales', 'ireland', 'northern ireland', 'london', 'edinburgh', 'dublin', 'france', 'paris', 'nice', 'cannes', 'monaco', 'marseille', 'lyon', 'spain', 'madrid', 'barcelona', 'seville', 'valencia', 'mallorca', 'majorca', 'menorca', 'ibiza', 'tenerife', 'portugal', 'lisbon', 'porto', 'italy', 'rome', 'venice', 'florence', 'milan', 'naples', 'sorrento', 'capri', 'positano', 'amalfi', 'malta', 'greece', 'athens', 'santorini', 'mykonos', 'crete', 'rhodes', 'corfu', 'zakynthos', 'croatia', 'dubrovnik', 'split', 'hvar', 'slovenia', 'montenegro', 'kotor', 'albania', 'bosnia', 'serbia', 'bulgaria', 'romania', 'hungary', 'budapest', 'austria', 'vienna', 'salzburg', 'switzerland', 'zurich', 'geneva', 'germany', 'berlin', 'munich', 'cologne', 'frankfurt', 'netherlands', 'holland', 'amsterdam', 'belgium', 'brussels', 'bruges', 'luxembourg', 'czechia', 'czech republic', 'prague', 'poland', 'krakow', 'warsaw', 'slovakia', 'bratislava', 'denmark', 'copenhagen', 'sweden', 'stockholm', 'norway', 'oslo', 'bergen', 'finland', 'helsinki', 'iceland', 'reykjavik', 'estonia', 'tallinn', 'latvia', 'riga', 'lithuania', 'vilnius', 'turkey', 'istanbul', 'cyprus', 'russia', 'ukraine', 'st petersburg', 'moscow', 'gibraltar', 'andorra', 'liechtenstein',
  // asia, middle east, africa, oceania
  'japan', 'tokyo', 'kyoto', 'osaka', 'china', 'beijing', 'shanghai', 'hong kong', 'macau', 'taiwan', 'taipei', 'south korea', 'korea', 'seoul', 'thailand', 'bangkok', 'phuket', 'koh samui', 'chiang mai', 'vietnam', 'hanoi', 'saigon', 'ho chi minh city', 'halong bay', 'cambodia', 'siem reap', 'angkor wat', 'laos', 'myanmar', 'malaysia', 'kuala lumpur', 'singapore', 'indonesia', 'bali', 'java', 'lombok', 'philippines', 'manila', 'palawan', 'india', 'delhi', 'goa', 'kerala', 'rajasthan', 'sri lanka', 'maldives', 'nepal', 'bhutan', 'bangladesh', 'pakistan', 'mongolia', 'uzbekistan', 'jordan', 'petra', 'israel', 'jerusalem', 'egypt', 'cairo', 'luxor', 'aswan', 'lebanon', 'oman', 'muscat', 'qatar', 'doha', 'dubai', 'abu dhabi', 'united arab emirates', 'uae', 'saudi arabia', 'kuwait', 'bahrain', 'morocco', 'marrakech', 'casablanca', 'tunisia', 'algeria', 'kenya', 'tanzania', 'zanzibar', 'uganda', 'rwanda', 'ethiopia', 'south africa', 'cape town', 'namibia', 'botswana', 'zimbabwe', 'victoria falls', 'zambia', 'mozambique', 'madagascar', 'mauritius', 'seychelles', 'reunion', 'senegal', 'ghana', 'nigeria', 'australia', 'sydney', 'melbourne', 'brisbane', 'perth', 'tasmania', 'queensland', 'great barrier reef', 'new zealand', 'auckland', 'queenstown', 'fiji', 'samoa', 'tonga', 'tahiti', 'bora bora', 'moorea', 'french polynesia', 'cook islands', 'rarotonga', 'vanuatu', 'new caledonia', 'palau', 'guam', 'papua new guinea',
]

/** Demonyms and adjectives of place, lowercase. They count as a place word when they sit next to a place name. */
const PLACE_ADJECTIVES: string[] = [
  'african', 'american', 'asian', 'european', 'canadian', 'mexican', 'caribbean', 'mediterranean', 'alaskan', 'hawaiian', 'floridian', 'californian', 'british', 'english', 'scottish', 'welsh', 'irish', 'french', 'spanish', 'portuguese', 'italian', 'greek', 'croatian', 'german', 'dutch', 'belgian', 'swiss', 'austrian', 'hungarian', 'czech', 'polish', 'norwegian', 'swedish', 'danish', 'finnish', 'icelandic', 'turkish', 'russian', 'japanese', 'chinese', 'korean', 'thai', 'vietnamese', 'indonesian', 'balinese', 'indian', 'moroccan', 'egyptian', 'jordanian', 'israeli', 'emirati', 'kenyan', 'tanzanian', 'south african', 'australian', 'tasmanian', 'polynesian', 'jamaican', 'bahamian', 'bermudian', 'barbadian', 'cuban', 'dominican', 'puerto rican', 'costa rican', 'panamanian', 'belizean', 'brazilian', 'argentine', 'argentinian', 'chilean', 'peruvian', 'colombian', 'ecuadorian', 'patagonian', 'yucatecan', 'amazonian', 'nordic', 'alpine', 'baltic', 'atlantic', 'pacific', 'arctic', 'tropical',
]

/** Words that may stand next to a place name without changing what it is ("Western Caribbean", "Rhine River", "Cayman Islands"). */
const PLACE_MODIFIERS: string[] = [
  'north', 'south', 'east', 'west', 'northern', 'southern', 'eastern', 'western', 'central', 'upper', 'lower', 'greater', 'lesser', 'inner', 'outer', 'coastal', 'southeast', 'northeast', 'southwest', 'northwest',
  'river', 'rivers', 'sea', 'seas', 'ocean', 'island', 'islands', 'isle', 'isles', 'peninsula', 'coast', 'coastline', 'riviera', 'gulf', 'bay', 'strait', 'channel', 'passage', 'valley', 'mountains', 'mountain', 'mount', 'lake', 'lakes', 'falls', 'canyon', 'desert', 'rainforest', 'forest', 'archipelago', 'cape', 'port', 'fjord', 'fjords', 'glacier', 'glaciers', 'reef', 'reefs', 'delta', 'region', 'province', 'territory', 'state', 'city',
  'saint', 'st', 'san', 'santa', 'sao', 'costa', 'isla', 'playa', 'puerto', 'cabo', 'monte', 'lago', 'rio',
  'of', 'de', 'del', 'la', 'le', 'the', 'and',
]

const WORD_RE = /[\p{L}'’-]+/gu

function tokens(s: string): string[] {
  return (s.toLowerCase().replace(/\./g, '').match(WORD_RE) ?? []).map((w) => w.replace(/^['’-]+|['’-]+$/g, '')).filter(Boolean)
}

/** Every single word of every place name: a name made of known place words is a place. */
const PLACE_WORDS: Set<string> = (() => {
  const set = new Set<string>()
  for (const n of PLACE_NAMES) for (const w of tokens(n)) set.add(w)
  return set
})()
const ADJECTIVES: Set<string> = new Set(PLACE_ADJECTIVES.flatMap(tokens))
const MODIFIERS: Set<string> = new Set(PLACE_MODIFIERS)
/** Place words that are also ordinary words or common parts of a business name: never enough on their own to pass a phrase. */
const WEAK_PLACE_WORDS = new Set(['main', 'victoria', 'split', 'nice', 'java', 'colon', 'turks', 'cape', 'port', 'america', 'georgia', 'washington', 'jordan', 'reunion', 'cabo', 'amazon', 'paris', 'florence', 'savannah'])

/** Is this lowercase word a plain place word (a place name, a demonym, or a harmless modifier)? */
export function isPlaceWord(word: string): boolean {
  const w = word.toLowerCase().replace(/\./g, '')
  return PLACE_WORDS.has(w) || ADJECTIVES.has(w) || MODIFIERS.has(w)
}

/** True when a capitalised phrase (its words, in order) is plain geography: every word is a place word or a modifier, and at
 * least one word is a real place name or demonym (not only modifiers such as "Island" or "River"). A phrase with any other word
 * ("Hilton Cancun", "Royal Caribbean", "Ritz Carlton", "Atlantis Resort") is not geography, whatever else it holds.
 * `known` words (from the brief) are handled by the caller; this function judges the words alone. */
export function isGeographyPhrase(words: string[]): boolean {
  if (words.length === 0) return false
  const lower = words.map((w) => w.toLowerCase().replace(/\./g, ''))
  if (!lower.every(isPlaceWord)) return false
  const strong = lower.some((w) => (PLACE_WORDS.has(w) || ADJECTIVES.has(w)) && !MODIFIERS.has(w) && !WEAK_PLACE_WORDS.has(w))
  if (strong) return true
  // Only weak words ("Victoria Island", "Port Victoria"): accept when the whole phrase is a listed name.
  const joined = lower.join(' ')
  return PLACE_NAMES.includes(joined)
}

/** Exposed for the offline check. */
export const GEOGRAPHY_SIZE = { names: PLACE_NAMES.length, adjectives: PLACE_ADJECTIVES.length }
