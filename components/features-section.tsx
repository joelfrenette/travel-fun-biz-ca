import { Plane, Shield, Clock, Heart } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"

const features = [
  {
    icon: Clock,
    title: "Save Time",
    description: "We take care of all the hard work so you can focus on enjoying your trip.",
  },
  {
    icon: Shield,
    title: "Save Stress",
    description: "Relax knowing every detail is handled by experienced travel professionals.",
  },
  {
    icon: Heart,
    title: "Save Money",
    description: "Get the best value with our exclusive deals and insider supplier connections.",
  },
  {
    icon: Plane,
    title: "Dedicated Travel Concierge",
    description: "Your personal concierge trained in CRM and AI, specialized in locations and suppliers.",
  },
]

export function FeaturesSection() {
  return (
    <section className="py-20 md:py-32">
      <div className="container mx-auto px-4">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-balance text-3xl font-bold tracking-tight text-foreground sm:text-4xl md:text-5xl">
            Why Choose TravelFunBiz.CA
          </h2>
          <p className="mt-4 text-pretty text-lg leading-relaxed text-muted-foreground">
            When you work with us, you save time, you save stress, you save money. We take care of all the hard work
            with a <span className="font-semibold text-primary">FREE dedicated experience concierge</span>. That's
            right—you don't pay more! We meet or beat what you can get on your own. We get paid by the suppliers for
            bringing them millions in business, and we get group rates and exclusive offers that we pass on to YOU.
          </p>
        </div>

        <div className="mt-16 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((feature) => (
            <Card key={feature.title} className="border-border/50 transition-shadow hover:shadow-lg">
              <CardContent className="flex flex-col items-center p-6 text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                  <feature.icon className="h-6 w-6 text-primary" />
                </div>
                <h3 className="mb-2 text-lg font-semibold text-foreground">{feature.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{feature.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  )
}
