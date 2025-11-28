import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function Footer() {
  return (
    <footer className="bg-[#2a2a2a] text-white">
      <div className="container mx-auto px-4 py-12">
        <div className="grid gap-8 lg:grid-cols-4">
          <div className="space-y-4">
            <div className="mb-6">
              <img
                src="https://travelfunbiz.com/wp-content/uploads/2023/09/500x185-trim-Logo-PlayfairBuffaloMontserrat.trans_.png"
                alt="TravelFun.Biz Logo"
                className="w-full max-w-[300px]"
              />
            </div>

            <div className="space-y-2 text-sm text-gray-300">
              <p>375 University Avenue, Suite 1072</p>
              <p>Toronto, ON M5G 2J5</p>
              <p className="pt-2">(365) 800-6363</p>
            </div>

            <div className="space-y-2 text-xs text-gray-400">
              <Link href="https://www.travelfunbiz.com/privacy-policy/" className="block hover:text-white">
                Privacy Policy
              </Link>
              <Link href="https://www.travelfunbiz.com/terms-conditions/" className="block hover:text-white">
                Terms & Conditions
              </Link>
              <Link href="https://www.travelfunbiz.com/earnings-disclaimer/" className="block hover:text-white">
                Earnings Disclaimer
              </Link>
              <Link href="https://travelfunbiz.com/affiliate-agreement/" className="block hover:text-white">
                Affiliate Agreement
              </Link>
            </div>

            <div className="space-y-1 text-xs text-gray-400">
              <p className="font-semibold text-white">Florida Seller of Travel # ST42324</p>
              <p className="font-semibold text-white">California Seller of Travel # 2154919-50</p>
            </div>

            <p className="text-xs text-gray-400">
              By calling or texting (365) 800-6363, you agree to receive text messages. If you no longer wish to receive
              text messages, you may opt out at any time by replying "STOP"
            </p>

            <div className="pt-4">
              <img
                src="https://travelfunbiz.com/wp-content/uploads/2025/10/logo-IATAN.png"
                alt="IATAN - International Airlines Travel Agent Network"
                className="w-[300px]"
              />
            </div>
          </div>

          <div className="space-y-4">
            <a
              href="https://travelfunbiz.com/reviews/"
              target="_blank"
              rel="noopener noreferrer"
              className="block transition-opacity hover:opacity-90"
            >
              <img
                src="https://travelfunbiz.com/wp-content/uploads/2024/01/300xReviews.jpg"
                alt="Google and Facebook Reviews"
                className="w-full rounded"
              />
            </a>

            <a
              href="https://web.bocaratonchamber.com/TRAVEL-AGENCIES/TravelFunbiz-15987"
              target="_blank"
              rel="noopener noreferrer"
              className="block transition-opacity hover:opacity-90"
            >
              <img
                src="https://travelfunbiz.com/wp-content/uploads/2024/01/300xChamber.png"
                alt="Boca Raton Chamber of Commerce"
                className="w-full rounded"
              />
            </a>

            <a
              href="https://www.bbb.org/us/fl/boca-raton/profile/online-travel-agency/travelfun-llc-0633-90563333"
              target="_blank"
              rel="noopener noreferrer"
              className="block transition-opacity hover:opacity-90"
            >
              <img
                src="https://travelfunbiz.com/wp-content/uploads/2018/10/300x100-bbb_a_rating_logo-2.png"
                alt="BBB A+ Rating"
                className="w-full rounded"
              />
            </a>

            <a
              href="https://cruising.org/en/verify-a-travel-agency-member"
              target="_blank"
              rel="noopener noreferrer"
              className="block transition-opacity hover:opacity-90"
            >
              <img
                src="https://travelfunbiz.com/wp-content/uploads/2024/01/CLIA-o-graph-e1705621125433-300x92.jpg"
                alt="CLIA - Cruise Lines International Association"
                className="w-full rounded"
              />
            </a>

            <a
              href="https://www.asta.org/travelerServices/advisor-directory"
              target="_blank"
              rel="noopener noreferrer"
              className="block transition-opacity hover:opacity-90"
            >
              <img
                src="https://travelfunbiz.com/wp-content/uploads/2024/01/asta-logo-1-e1705621308273-300x122.png"
                alt="ASTA - American Society of Travel Advisors"
                className="w-full rounded"
              />
            </a>
          </div>

          <div className="space-y-4">
            <a
              href="https://www.facebook.com/MostPartiesMostFun"
              target="_blank"
              rel="noopener noreferrer"
              className="block transition-opacity hover:opacity-90"
            >
              <img
                src="https://travelfunbiz.com/wp-content/uploads/2019/12/best-singles-cruises-11.jpg"
                alt="Follow us on Facebook"
                className="w-full rounded"
              />
            </a>

            <a
              href="https://www.instagram.com/solotravelexpert/"
              target="_blank"
              rel="noopener noreferrer"
              className="block transition-opacity hover:opacity-90"
            >
              <img
                src="https://travelfunbiz.com/wp-content/uploads/2019/12/best-singles-cruises-12.jpg"
                alt="Follow us on Instagram"
                className="w-full rounded"
              />
            </a>

            <a
              href="https://bit.ly/SubscribeSoloTravelTV"
              target="_blank"
              rel="noopener noreferrer"
              className="block transition-opacity hover:opacity-90"
            >
              <img
                src="https://travelfunbiz.com/wp-content/uploads/2021/11/YouTube-Subscribe-300x139-1.jpg"
                alt="Subscribe to YouTube Channel"
                className="w-full rounded"
              />
            </a>

            <a
              href="https://www.tiktok.com/@travelfunjoel"
              target="_blank"
              rel="noopener noreferrer"
              className="block transition-opacity hover:opacity-90"
            >
              <img
                src="https://travelfunbiz.com/wp-content/uploads/2022/01/600x282-tiktok.png"
                alt="Follow us on TikTok"
                className="w-full rounded"
              />
            </a>
          </div>

          <div>
            <div className="mb-4 bg-[#e31e24] px-6 py-3 text-center">
              <p className="text-2xl font-bold leading-tight">
                NOTIFY ME OF
                <br />
                TRAVEL DEALS
              </p>
            </div>
            <div className="rounded-lg bg-white p-6">
              <form className="space-y-4">
                <div>
                  <label htmlFor="fullName" className="mb-1 block text-sm font-medium text-gray-900">
                    What is Your Full Name *
                  </label>
                  <Input
                    id="fullName"
                    type="text"
                    placeholder="Full Name"
                    required
                    className="border-gray-300 bg-gray-100"
                  />
                </div>

                <div>
                  <label htmlFor="email" className="mb-1 block text-sm font-medium text-gray-900">
                    Enter Your Email *
                  </label>
                  <Input id="email" type="email" placeholder="Email" required className="border-gray-300 bg-gray-100" />
                </div>

                <div>
                  <label htmlFor="phone" className="mb-1 block text-sm font-medium text-gray-900">
                    Mobile Phone *
                  </label>
                  <Input id="phone" type="tel" placeholder="Phone" required className="border-gray-300 bg-gray-100" />
                </div>

                <div>
                  <label htmlFor="deals" className="mb-1 block text-sm font-medium text-gray-900">
                    Which Deals you like? (multi-select) *
                  </label>
                  <select
                    id="deals"
                    multiple
                    className="w-full rounded-md border border-gray-300 bg-gray-100 p-2 text-sm text-gray-900"
                  >
                    <option>All-Inclusive Resorts</option>
                    <option>Cruises</option>
                    <option>European Tours</option>
                    <option>Adventure Travel</option>
                    <option>Luxury Escapes</option>
                  </select>
                </div>

                <Button type="submit" className="w-full bg-[#e31e24] py-6 text-lg font-bold hover:bg-[#c01a1f]">
                  SUBMIT
                </Button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}
