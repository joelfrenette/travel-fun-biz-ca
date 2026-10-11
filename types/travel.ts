export interface TravelPackage {
  id: string
  slug?: string
  name: string
  destination: string
  duration: string
  price: string
  priceValue?: number
  /** True when the price is given on request: the card shows "Call or text <number> for pricing". */
  priceOnRequest?: boolean
  description: string
  image: string
  category: string
  rating?: number
  maxPeople?: string
}