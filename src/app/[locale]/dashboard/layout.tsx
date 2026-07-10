import { connection } from "next/server";
import type { ReactNode } from "react";
import { redirect } from "@/i18n/routing";

import { getSession, hasAdminAuthority } from "@/lib/auth";
import { DashboardHeader } from "./_components/dashboard-header";
import { DashboardMain } from "./_components/dashboard-main";
import { WebhookMigrationDialog } from "./_components/webhook-migration-dialog";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export default async function DashboardLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  // Await params to ensure locale is available in the async context
  const { locale } = await params;

  await connection();
  const session = await getSession({ allowReadOnlyAccess: true });

  if (!session) {
    return redirect({ href: "/login?from=/dashboard", locale });
  }

  if (!session.key.canLoginWebUi) {
    return redirect({ href: "/my-usage", locale });
  }

  return (
    <div className="min-h-[var(--cch-viewport-height,100vh)] bg-background">
      <DashboardHeader session={session} locale={locale} />
      <DashboardMain>{children}</DashboardMain>
      {hasAdminAuthority(session) ? <WebhookMigrationDialog /> : null}
    </div>
  );
}
