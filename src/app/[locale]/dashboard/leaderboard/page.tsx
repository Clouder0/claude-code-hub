import { getTranslations } from "next-intl/server";
import { Section } from "@/components/section";
import { getSession, hasAdminAuthority } from "@/lib/auth";
import { LeaderboardView } from "./_components/leaderboard-view";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  const session = await getSession();
  const isAdmin = hasAdminAuthority(session);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t("title.costRanking")}</h1>
        <p className="mt-2 text-muted-foreground">{t("title.costRankingDescription")}</p>
      </div>
      <Section>
        <LeaderboardView isAdmin={isAdmin} />
      </Section>
    </div>
  );
}
