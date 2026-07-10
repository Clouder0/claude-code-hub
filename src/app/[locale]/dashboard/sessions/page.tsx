import { redirect } from "@/i18n/routing";
import { getSession } from "@/lib/auth";
import { ActiveSessionsClient } from "./_components/active-sessions-client";

export const dynamic = "force-dynamic";

export default async function ActiveSessionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await getSession();

  if (!session) {
    return redirect({ href: "/login", locale });
  }

  return <ActiveSessionsClient />;
}
