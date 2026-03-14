import { AdminLoginForm } from "@/components/admin-login-form"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

interface AdminLoginPageProps {
  searchParams: { [key: string]: string | string[] | undefined }
}

export default function AdminLoginPage({ searchParams }: AdminLoginPageProps) {
  const redirectParam = typeof searchParams?.redirect === "string" ? searchParams.redirect : undefined

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/20 px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Admin Sign In</CardTitle>
          <CardDescription>Access travel automation tools</CardDescription>
        </CardHeader>
        <CardContent>
          <AdminLoginForm redirectPath={redirectParam || "/admin"} />
        </CardContent>
      </Card>
    </div>
  )
}
