import type { LucideIcon } from 'lucide-react'
import { Clock, Heart, Plane, Shield } from 'lucide-react'

export interface FeatureItem {
  icon: LucideIcon
  title: string
  description: string
}

export const featureItems: FeatureItem[] = [
  {
    icon: Clock,
    title: 'Save Time',
    description: 'We take care of all the hard work so you can focus on enjoying your trip.',
  },
  {
    icon: Shield,
    title: 'Save Stress',
    description: 'Relax knowing every detail is handled by experienced travel professionals.',
  },
  {
    icon: Heart,
    title: 'Save Money',
    description: 'Get the best value with our exclusive deals and insider supplier connections.',
  },
  {
    icon: Plane,
    title: 'Dedicated Travel Concierge',
    description: 'Your personal concierge trained in CRM and AI, specialized in locations and suppliers.',
  },
]