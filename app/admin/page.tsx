import { getAdminSession } from "@/lib/session"
import { verifyToken } from "@/lib/simple-session"
import { cookies } from 'next/headers'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

export default function AdminHomePage() {
  // Try the signed session first
  const session = getAdminSession()
  let email = session?.email

  // If not available, check the simple token cookie
  if (!email) {
    const token = cookies().get('adminToken')?.value
    const tokenEmail = verifyToken(token)
    if (tokenEmail) email = tokenEmail
  }

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Welcome back</CardTitle>
          <CardDescription>Only authorized administrators can access these tools.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Signed in as {email ?? "admin"}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Future releases will expose AI package automation, affiliate tools, and SEO workflows here.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}