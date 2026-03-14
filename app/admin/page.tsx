import { getAdminSession } from "@/lib/session"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

export default function AdminHomePage() {
  const session = getAdminSession()

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Welcome back</CardTitle>
          <CardDescription>Only authorized administrators can access these tools.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Signed in as {session?.email ?? "admin"}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Future releases will expose AI package automation, affiliate tools, and SEO workflows here.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
