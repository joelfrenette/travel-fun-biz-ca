import { redirect } from "next/navigation"

// The old Destinations screen (a blurb editor plus the guide list) is now ONE screen, Guide Pages, at /admin/guides.
// This address stays so old bookmarks keep working. Stored blurbs are untouched and the public destination pages
// still read them (lib/destination-blurbs.ts); the /api/admin/destinations routes remain.
export default function DestinationsAdminRedirect() {
  redirect("/admin/guides")
}
