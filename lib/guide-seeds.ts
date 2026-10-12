import type { GuideKind } from '@/lib/guides'
import type { GuideScope } from '@/lib/guide-scope'

// A short, hand-picked list of well-known names that Canadian travellers search for, so the guide writer
// has candidates before many trips are published. NAMES ONLY: no facts, no locations, no ratings. Anything
// a guide says about these comes from the writer's general guidebook knowledge, checked by the mechanical
// quality gate in lib/guide-composer.ts, never from this file. Add or remove entries freely; a name that is
// already a guide is skipped automatically.
export interface GuideSeed {
  kind: GuideKind
  name: string
  /** How wide the page is, when it cannot be told from the name (lib/guide-scope.ts infers the rest). */
  scope?: GuideScope
  /** The slug of the page this one sits under (a port under its country). Only set where it is plain geography. */
  parent_slug?: string
}

export const GUIDE_SEEDS: GuideSeed[] = [
  // Destinations
  { kind: 'destinations', name: 'Cancun' },
  { kind: 'destinations', name: 'Punta Cana' },
  { kind: 'destinations', name: 'Jamaica' },
  { kind: 'destinations', name: 'Cozumel' },
  { kind: 'destinations', name: 'Santorini' },
  { kind: 'destinations', name: 'Amalfi Coast' },
  { kind: 'destinations', name: 'Croatia' },
  { kind: 'destinations', name: 'Tahiti' },
  { kind: 'destinations', name: 'Alaska' },
  { kind: 'destinations', name: 'Iceland' },
  // The long tail (WP16): countries, then ports of call. Names only, plain geography. The daily guide step works
  // through these once the pages the trips name are written; a name a published trip already covers is skipped.
  { kind: 'destinations', name: 'Italy', scope: 'country' },
  { kind: 'destinations', name: 'Greece', scope: 'country' },
  { kind: 'destinations', name: 'Spain', scope: 'country' },
  { kind: 'destinations', name: 'Portugal', scope: 'country' },
  { kind: 'destinations', name: 'Mexico', scope: 'country' },
  { kind: 'destinations', name: 'Dominican Republic', scope: 'country' },
  { kind: 'destinations', name: 'Costa Rica', scope: 'country' },
  { kind: 'destinations', name: 'Bahamas', scope: 'country' },
  { kind: 'destinations', name: 'Turkey', scope: 'country' },
  { kind: 'destinations', name: 'Egypt', scope: 'country' },
  { kind: 'destinations', name: 'Caribbean', scope: 'region' },
  { kind: 'destinations', name: 'Mediterranean', scope: 'region' },
  { kind: 'destinations', name: 'Nassau', scope: 'port', parent_slug: 'bahamas' },
  { kind: 'destinations', name: 'Montego Bay', scope: 'port', parent_slug: 'jamaica' },
  { kind: 'destinations', name: 'Juneau', scope: 'port', parent_slug: 'alaska' },
  { kind: 'destinations', name: 'Ketchikan', scope: 'port', parent_slug: 'alaska' },
  // Resorts
  { kind: 'resorts', name: 'Sandals Resorts', scope: 'supplier' },
  { kind: 'resorts', name: 'Beaches Resorts', scope: 'supplier' },
  { kind: 'resorts', name: 'Club Med', scope: 'supplier' },
  { kind: 'resorts', name: 'Royalton Resorts', scope: 'supplier' },
  // Hotels
  { kind: 'hotels', name: 'Fairmont Banff Springs' },
  { kind: 'hotels', name: 'Atlantis Paradise Island' },
  // Cruise lines
  { kind: 'cruise-lines', name: 'Royal Caribbean' },
  { kind: 'cruise-lines', name: 'Celebrity Cruises' },
  { kind: 'cruise-lines', name: 'Holland America Line' },
  { kind: 'cruise-lines', name: 'Princess Cruises' },
  { kind: 'cruise-lines', name: 'Norwegian Cruise Line' },
  { kind: 'cruise-lines', name: 'Disney Cruise Line' },
  // Ships
  { kind: 'ships', name: 'Symphony of the Seas' },
  { kind: 'ships', name: 'Celebrity Edge' },
  { kind: 'ships', name: 'Disney Wish' },
  // River cruises
  { kind: 'river-cruises', name: 'Viking' },
  { kind: 'river-cruises', name: 'AmaWaterways' },
  { kind: 'river-cruises', name: 'Avalon Waterways' },
  { kind: 'river-cruises', name: 'Uniworld Boutique River Cruises' },
  // Yachts
  { kind: 'yachts', name: 'Star Clippers' },
  { kind: 'yachts', name: 'Sea Cloud Cruises' },
  { kind: 'yachts', name: 'Windstar Cruises' },
]
