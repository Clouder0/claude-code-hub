import { ChevronLeft, ChevronRight, ExternalLink, ShieldAlert } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link, redirect } from "@/i18n/routing";
import { getSession } from "@/lib/auth";
import { isPolicyRejectionType } from "@/lib/security/security-signals";
import { formatDate } from "@/lib/utils/date-format";
import {
  findRecentSecurityEvents,
  findSecurityEventUserSummaries,
} from "@/repository/security-events";
import { DisableUserButton } from "./_components/disable-user-button";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

function parsePage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const page = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export default async function SecurityEventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const [{ locale }, query, session] = await Promise.all([params, searchParams, getSession()]);
  if (!session) {
    return redirect({ href: "/login?from=/dashboard/security-events", locale });
  }
  if (session.user.role !== "admin") {
    return redirect({ href: "/dashboard", locale });
  }

  const page = parsePage(query.page);
  const t = await getTranslations({ locale, namespace: "dashboard.securityEvents" });
  const [users, eventsPage] = await Promise.all([
    findSecurityEventUserSummaries(),
    findRecentSecurityEvents({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <ShieldAlert className="size-7" />
          {t("title")}
        </h1>
        <p className="mt-2 text-muted-foreground">{t("description")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("users.title")}</CardTitle>
          <CardDescription>{t("users.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {users.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("users.empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.user")}</TableHead>
                  <TableHead>{t("columns.policyBlocks")}</TableHead>
                  <TableHead>{t("columns.safetyChecks")}</TableHead>
                  <TableHead>{t("columns.lastEvent")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="text-right">{t("columns.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.userId}>
                    <TableCell className="font-medium">{user.userName}</TableCell>
                    <TableCell>{user.policyBlockCount}</TableCell>
                    <TableCell>{user.safetyCheckCount}</TableCell>
                    <TableCell>
                      {formatDate(user.lastEventAt, "yyyy-MM-dd HH:mm:ss", locale)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={user.userEnabled ? "outline" : "secondary"}>
                        {user.userEnabled ? t("status.enabled") : t("status.disabled")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/dashboard/logs?userId=${user.userId}`}>
                            {t("actions.view")}
                          </Link>
                        </Button>
                        <DisableUserButton
                          userId={user.userId}
                          userName={user.userName}
                          userEnabled={user.userEnabled}
                          self={user.userId === session.user.id}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("events.title")}</CardTitle>
          <CardDescription>{t("events.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {eventsPage.items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("events.empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.time")}</TableHead>
                  <TableHead>{t("columns.type")}</TableHead>
                  <TableHead>{t("columns.user")}</TableHead>
                  <TableHead>{t("columns.key")}</TableHead>
                  <TableHead>{t("columns.session")}</TableHead>
                  <TableHead>{t("columns.provider")}</TableHead>
                  <TableHead>{t("columns.request")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {eventsPage.items.map((event) => {
                  const requestHref = event.sessionId
                    ? `/dashboard/sessions/${encodeURIComponent(event.sessionId)}/messages?seq=${event.requestSequence ?? 1}`
                    : event.providerId != null
                      ? `/dashboard/logs?userId=${event.userId}&providerId=${event.providerId}`
                      : `/dashboard/logs?userId=${event.userId}`;
                  return (
                    <TableRow key={event.id}>
                      <TableCell>
                        {formatDate(event.createdAt, "yyyy-MM-dd HH:mm:ss", locale)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={isPolicyRejectionType(event.type) ? "destructive" : "outline"}
                        >
                          {event.type === "cyber_policy"
                            ? t("types.cyberPolicy")
                            : event.type === "bio_policy"
                              ? t("types.bioPolicy")
                              : t("types.safetyCheck")}
                        </Badge>
                      </TableCell>
                      <TableCell>{event.userName}</TableCell>
                      <TableCell>{event.keyName ?? t("unknown")}</TableCell>
                      <TableCell className="max-w-44 truncate font-mono text-xs">
                        {event.sessionId ?? t("unknown")}
                      </TableCell>
                      <TableCell>{event.providerName ?? `#${event.providerId}`}</TableCell>
                      <TableCell>
                        <Button asChild size="sm" variant="ghost">
                          <Link href={requestHref}>
                            {event.messageRequestId != null
                              ? `#${event.messageRequestId}`
                              : t("unknown")}
                            <ExternalLink />
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          {(page > 1 || eventsPage.hasMore) && (
            <div className="flex justify-end gap-2">
              {page > 1 ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/dashboard/security-events?page=${page - 1}`}>
                    <ChevronLeft />
                    {t("pagination.previous")}
                  </Link>
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled>
                  <ChevronLeft />
                  {t("pagination.previous")}
                </Button>
              )}
              {eventsPage.hasMore ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/dashboard/security-events?page=${page + 1}`}>
                    {t("pagination.next")}
                    <ChevronRight />
                  </Link>
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled>
                  {t("pagination.next")}
                  <ChevronRight />
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
