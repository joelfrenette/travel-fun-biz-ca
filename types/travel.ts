export interface TravelPackage {
  id: string
  name: string
  destination: string
  duration: string
  price: string
  priceValue?: number
  description: string
  image: string
  category: string
  rating?: number
  maxPeople?: string
}