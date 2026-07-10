import { redirect } from "@/i18n/routing";
import { getSession } from "@/lib/auth";
import { SessionMessagesClient } from "./_components/session-messages-client";

export const dynamic = "force-dynamic";

export default async function SessionMessagesPage({
  params,
}: {
  params: Promise<{ locale: string; sessionId: string }>;
}) {
  const { locale } = await params;
  const session = await getSession();

  if (!session) {
    return redirect({ href: "/login", locale });
  }

  return <SessionMessagesClient />;
}
