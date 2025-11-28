import { Header } from "@/components/header"
import { HeroSection } from "@/components/hero-section"
import { FeaturesSection } from "@/components/features-section"
import { PackagesSection } from "@/components/packages-section"
import { ContactForm } from "@/components/contact-form"
import { Footer } from "@/components/footer"
import { fetchGoogleSheetData, mapSheetRowToPackage } from "@/lib/google-sheets"
import { TestimonialsSection } from "@/components/testimonials-section"

const samplePackages = [
  {
    id: "1",
    name: "Tropical Paradise Escape",
    destination: "Maldives",
    duration: "7 Days / 6 Nights",
    price: "$2,499",
    description:
      "Experience luxury in overwater bungalows with crystal-clear waters, pristine beaches, and world-class diving.",
    image: "/maldives-tropical-beach-resort.jpg",
    category: "Luxury",
    rating: 4.9,
    maxPeople: "2-4",
  },
  {
    id: "2",
    name: "European Heritage Tour",
    destination: "Italy & France",
    duration: "12 Days / 11 Nights",
    price: "$3,899",
    description: "Explore ancient ruins, Renaissance art, and culinary delights across Rome, Florence, and Paris.",
    image: "/european-cities-architecture.jpg",
    category: "Groups",
    rating: 4.8,
    maxPeople: "2-8",
  },
  {
    id: "3",
    name: "Mountain Adventure Trek",
    destination: "Nepal",
    duration: "10 Days / 9 Nights",
    price: "$1,899",
    description: "Trek through the Himalayas, visit ancient monasteries, and witness breathtaking mountain vistas.",
    image: "/himalayan-trekking.png",
    category: "Adventure",
    rating: 4.7,
    maxPeople: "4-12",
  },
  {
    id: "4",
    name: "Wellness Retreat & Spa",
    destination: "Bali, Indonesia",
    duration: "8 Days / 7 Nights",
    price: "$3,299",
    description:
      "Rejuvenate your mind and body with yoga, meditation, spa treatments, and healthy cuisine in paradise.",
    image: "/african-safari-wildlife.jpg",
    category: "Wellness",
    rating: 5.0,
    maxPeople: "2-6",
  },
  {
    id: "5",
    name: "Singles Getaway Experience",
    destination: "Costa Rica",
    duration: "9 Days / 8 Nights",
    price: "$2,799",
    description:
      "Connect with like-minded travelers, enjoy adventure activities, and explore stunning beaches and rainforests.",
    image: "/greek-islands-santorini.png",
    category: "Singles",
    rating: 4.8,
    maxPeople: "1-1",
  },
  {
    id: "6",
    name: "Amazon Rainforest Expedition",
    destination: "Brazil",
    duration: "6 Days / 5 Nights",
    price: "$2,199",
    description: "Explore the world's largest rainforest, encounter exotic wildlife, and learn from indigenous guides.",
    image: "/amazon-rainforest-jungle.jpg",
    category: "Adventure",
    rating: 4.6,
    maxPeople: "4-10",
  },
]

export default async function HomePage() {
  // To use Google Sheets, set GOOGLE_SHEET_ID environment variable
  let packages = samplePackages

  const sheetId = process.env.GOOGLE_SHEET_ID
  if (sheetId) {
    try {
      const sheetData = await fetchGoogleSheetData(sheetId)
      if (sheetData.length > 0) {
        packages = sheetData.map(mapSheetRowToPackage)
      }
    } catch (error) {
      console.error("Failed to fetch Google Sheets data, using sample packages:", error)
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="flex-1">
        <HeroSection />
        <PackagesSection packages={packages} />
        <FeaturesSection />

        <TestimonialsSection />

        <section id="contact" className="bg-muted/30 py-20">
          <div className="container mx-auto px-4">
            <div className="mb-12 text-center">
              <h2 className="text-balance text-3xl font-bold text-foreground">Get Your Free Travel Concierge</h2>
              <p className="mx-auto mt-4 max-w-2xl text-pretty text-muted-foreground">
                Ready to explore the world? Fill out the form below and let us help you plan your dream vacation.
              </p>
            </div>
            <ContactForm />
          </div>
        </section>
      </main>
      <Footer />
    </div>
  )
}
