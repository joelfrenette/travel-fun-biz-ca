import type { GuideKind } from '@/lib/guides'

// A short, hand-picked list of well-known names that Canadian travellers search for, so the guide writer
// has candidates before many trips are published. NAMES ONLY: no facts, no locations, no ratings. Anything
// a guide says about these comes from the writer's general guidebook knowledge, checked by the mechanical
// quality gate in lib/guide-composer.ts, never from this file. Add or remove entries freely; a name that is
// already a guide is skipped automatically.
export interface GuideSeed {
  kind: GuideKind
  name: string
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
  // Resorts
  { kind: 'resorts', name: 'Sandals Resorts' },
  { kind: 'resorts', name: 'Beaches Resorts' },
  { kind: 'resorts', name: 'Club Med' },
  { kind: 'resorts', name: 'Royalton Resorts' },
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
  { kind: 'river-cruises', name: 'Viking River Cruises' },
  { kind: 'river-cruises', name: 'AmaWaterways' },
  { kind: 'river-cruises', name: 'Avalon Waterways' },
  { kind: 'river-cruises', name: 'Uniworld Boutique River Cruises' },
  // Yachts
  { kind: 'yachts', name: 'Star Clippers' },
  { kind: 'yachts', name: 'Sea Cloud Cruises' },
  { kind: 'yachts', name: 'Windstar Cruises' },
]
