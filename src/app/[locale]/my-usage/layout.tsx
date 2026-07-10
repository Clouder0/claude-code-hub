import { connection } from "next/server";
import type { ReactNode } from "react";
import { redirect } from "@/i18n/routing";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export default async function MyUsageLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  await connection();
  const session = await getSession({ allowReadOnlyAccess: true });

  if (!session) {
    return redirect({ href: "/login?from=/my-usage", locale });
  }

  if (session.key.canLoginWebUi) {
    return redirect({ href: "/dashboard", locale });
  }

  return (
    <div className="min-h-[var(--cch-viewport-height,100vh)] bg-background">
      <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}
