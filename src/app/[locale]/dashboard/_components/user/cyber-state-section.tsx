"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2, RotateCcw, ShieldAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getUserCyberState,
  releaseUserBioRestriction,
  resetUserCyberClientInstance,
  resetUserCyberPrincipal,
  setUserCyberManualClientRestriction,
} from "@/lib/api-client/v1/actions/users";
import type { ActiveRestriction, ClientInstanceCyberState } from "@/lib/cyber-check/types";
import { getErrorMessage } from "@/lib/utils/error-messages";

interface CyberStateSectionProps {
  userId: number;
  userEnabled: boolean;
  onPrincipalEnabled?: () => void;
}

export function CyberStateSection({
  userId,
  userEnabled,
  onPrincipalEnabled,
}: CyberStateSectionProps) {
  const t = useTranslations("dashboard.userManagement.editDialog.cyberState");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const locale = useLocale();
  const [resetting, setResetting] = useState<string | null>(null);
  const [manualInstallation, setManualInstallation] = useState("");
  const [manualReason, setManualReason] = useState("");
  const stateQuery = useQuery({
    queryKey: ["userCyberState", userId],
    queryFn: () => getUserCyberState(userId),
    retry: false,
  });

  const formatTime = (timestamp?: number) =>
    timestamp === undefined
      ? t("never")
      : new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(timestamp));

  const resetError = (result: {
    error?: string;
    errorCode?: string;
    errorParams?: Record<string, string | number>;
  }) =>
    result.errorCode
      ? getErrorMessage(tErrors, result.errorCode, result.errorParams)
      : result.error || t("resetFailed");

  const handlePrincipalReset = async () => {
    setResetting("principal");
    try {
      const enableUser = !userEnabled;
      const result = await resetUserCyberPrincipal(userId, enableUser);
      if (!result.ok) {
        toast.error(resetError(result));
        return;
      }
      toast.success(enableUser ? t("principalResetAndEnabled") : t("principalReset"));
      if (enableUser) onPrincipalEnabled?.();
      await stateQuery.refetch();
    } catch {
      toast.error(t("resetFailed"));
    } finally {
      setResetting(null);
    }
  };

  const handleClientReset = async (clientInstanceId: string) => {
    setResetting(clientInstanceId);
    try {
      const result = await resetUserCyberClientInstance(userId, clientInstanceId);
      if (!result.ok) {
        toast.error(resetError(result));
        return;
      }
      toast.success(t("installationReset"));
      await stateQuery.refetch();
    } catch {
      toast.error(t("resetFailed"));
    } finally {
      setResetting(null);
    }
  };

  const handleManualRestriction = async (
    clientInstanceId: string,
    restricted: boolean,
    reason: string
  ) => {
    setResetting(`manual:${clientInstanceId}`);
    try {
      const result = await setUserCyberManualClientRestriction(
        userId,
        clientInstanceId,
        reason,
        restricted
      );
      if (!result.ok) {
        toast.error(resetError(result));
        return;
      }
      toast.success(restricted ? t("manualBlocked") : t("manualReleased"));
      if (restricted) {
        setManualInstallation("");
        setManualReason("");
      }
      await stateQuery.refetch();
    } catch {
      toast.error(t("resetFailed"));
    } finally {
      setResetting(null);
    }
  };

  const handleBioRelease = async (restriction: ActiveRestriction, reason: string) => {
    setResetting(`bio:${restriction.scope}:${restriction.subject_id}`);
    try {
      const result = await releaseUserBioRestriction(
        userId,
        restriction.scope,
        restriction.subject_id,
        reason,
        restriction.scope === "principal" && !userEnabled
      );
      if (!result.ok) {
        toast.error(resetError(result));
        return;
      }
      toast.success(t("bioReleased"));
      if (result.data?.enabled) onPrincipalEnabled?.();
      await stateQuery.refetch();
    } finally {
      setResetting(null);
    }
  };

  const state = stateQuery.data?.state;
  return (
    <section className="rounded-lg border border-muted p-4 space-y-3" data-testid="cyber-state">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 text-amber-600" aria-hidden="true" />
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{t("title")}</h3>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
      </div>

      {stateQuery.isPending && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("loading")}
        </div>
      )}
      {stateQuery.isError && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <span>{t("unavailable")}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => stateQuery.refetch()}>
            {t("retry")}
          </Button>
        </div>
      )}
      {stateQuery.data && !stateQuery.data.configured && (
        <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
          {t("notConfigured")}
        </p>
      )}
      {state && (
        <>
          <div className="rounded-md border p-3 space-y-3">
            <div>
              <h4 className="text-sm font-medium">{t("manualTitle")}</h4>
              <p className="text-xs text-muted-foreground">{t("manualDescription")}</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <Input
                value={manualInstallation}
                onChange={(event) => setManualInstallation(event.target.value)}
                placeholder={t("installationPlaceholder")}
                maxLength={256}
              />
              <Input
                value={manualReason}
                onChange={(event) => setManualReason(event.target.value)}
                placeholder={t("reasonPlaceholder")}
                maxLength={1024}
              />
              <Button
                type="button"
                variant="destructive"
                disabled={
                  !manualInstallation.trim() ||
                  !manualReason.trim() ||
                  resetting?.startsWith("manual:")
                }
                onClick={() =>
                  void handleManualRestriction(manualInstallation.trim(), true, manualReason.trim())
                }
              >
                {t("manualBlock")}
              </Button>
            </div>
          </div>
          <div className="rounded-md border p-3 space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-medium">{t("principal")}</h4>
                  <CyberStatusBadge restricted={state.principal.restricted} t={t} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("strikes", {
                    count: state.principal.current_strikes,
                    threshold: state.disable_threshold,
                    days: Math.max(1, Math.round(state.strike_window_seconds / 86_400)),
                  })}
                </p>
                {state.principal.last_hit_at_ms !== undefined && (
                  <p className="text-xs text-muted-foreground">
                    {t("lastHit", { date: formatTime(state.principal.last_hit_at_ms) })}
                  </p>
                )}
                {state.principal.last_reset_at_ms !== undefined && (
                  <p className="text-xs text-muted-foreground">
                    {t("lastReset", { date: formatTime(state.principal.last_reset_at_ms) })}
                  </p>
                )}
              </div>
              {(state.principal.restricted || state.principal.current_strikes > 0) && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button type="button" size="sm" variant="outline">
                      <RotateCcw className="h-3.5 w-3.5" />
                      {userEnabled ? t("resetPrincipal") : t("resetPrincipalAndEnable")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("confirmPrincipalTitle")}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {userEnabled
                          ? t("confirmPrincipalDescription")
                          : t("confirmPrincipalAndEnableDescription")}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={resetting === "principal"}>
                        {tCommon("cancel")}
                      </AlertDialogCancel>
                      <AlertDialogAction
                        type="button"
                        disabled={resetting === "principal"}
                        onClick={(event) => {
                          event.preventDefault();
                          void handlePrincipalReset();
                        }}
                      >
                        {resetting === "principal" && (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        )}
                        {t("confirmReset")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium">{t("installations")}</h4>
            {state.client_instances.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noInstallations")}</p>
            ) : (
              state.client_instances.map((client) => (
                <ClientInstanceRow
                  key={client.client_instance_id}
                  client={client}
                  threshold={state.disable_threshold}
                  windowSeconds={state.strike_window_seconds}
                  resetting={resetting === client.client_instance_id}
                  formatTime={formatTime}
                  onReset={handleClientReset}
                  onManualRestriction={handleManualRestriction}
                  t={t}
                  tCommon={tCommon}
                />
              ))
            )}
          </div>
          <div className="space-y-2">
            <h4 className="text-sm font-medium">{t("bioRestrictions")}</h4>
            {(state.bio_restrictions ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noBioRestrictions")}</p>
            ) : (
              (state.bio_restrictions ?? []).map((restriction) => (
                <BioRestrictionRow
                  key={`${restriction.scope}:${restriction.subject_id}`}
                  restriction={restriction}
                  resetting={resetting === `bio:${restriction.scope}:${restriction.subject_id}`}
                  onRelease={handleBioRelease}
                  t={t}
                  tCommon={tCommon}
                />
              ))
            )}
          </div>
        </>
      )}
    </section>
  );
}

function BioRestrictionRow({
  restriction,
  resetting,
  onRelease,
  t,
  tCommon,
}: {
  restriction: ActiveRestriction;
  resetting: boolean;
  onRelease: (restriction: ActiveRestriction, reason: string) => Promise<void>;
  t: ReturnType<typeof useTranslations>;
  tCommon: ReturnType<typeof useTranslations>;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="flex flex-col gap-2 rounded-md border border-destructive/30 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <Badge variant="destructive">bio_policy · {restriction.scope}</Badge>
        <code className="ml-2 text-xs">{restriction.subject_id}</code>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button type="button" size="sm" variant="outline">
            {t("releaseBio")}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmBioReleaseTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("confirmBioReleaseDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("reasonPlaceholder")}
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetting}>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={resetting || !reason.trim()}
              onClick={(event) => {
                event.preventDefault();
                void onRelease(restriction, reason.trim());
              }}
            >
              {t("releaseBio")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface ClientInstanceRowProps {
  client: ClientInstanceCyberState;
  threshold: number;
  windowSeconds: number;
  resetting: boolean;
  formatTime: (timestamp?: number) => string;
  onReset: (clientInstanceId: string) => Promise<void>;
  onManualRestriction: (
    clientInstanceId: string,
    restricted: boolean,
    reason: string
  ) => Promise<void>;
  t: ReturnType<typeof useTranslations>;
  tCommon: ReturnType<typeof useTranslations>;
}

function ClientInstanceRow({
  client,
  threshold,
  windowSeconds,
  resetting,
  formatTime,
  onReset,
  onManualRestriction,
  t,
  tCommon,
}: ClientInstanceRowProps) {
  const [releaseReason, setReleaseReason] = useState("");
  const status = client.restricted
    ? client.expires_at_ms === undefined
      ? t("permanent")
      : t("temporary", { date: formatTime(client.expires_at_ms) })
    : t("notRestricted");
  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <code className="block truncate text-xs" title={client.client_instance_id}>
            {client.client_instance_id}
          </code>
          <div className="flex flex-wrap items-center gap-2">
            <CyberStatusBadge restricted={client.restricted} t={t} />
            {client.automatic_restricted && <Badge variant="outline">{t("automatic")}</Badge>}
            {client.manual_restricted && <Badge variant="destructive">{t("manual")}</Badge>}
            <span className="text-xs text-muted-foreground">{status}</span>
          </div>
          {client.manual_restricted && (
            <p className="text-xs text-muted-foreground">
              {t("manualDetail", {
                actor: client.manual_actor ?? t("unknown"),
                reason: client.manual_reason ?? t("unknown"),
              })}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t("strikes", {
              count: client.current_strikes,
              threshold,
              days: Math.max(1, Math.round(windowSeconds / 86_400)),
            })}
          </p>
          {client.last_hit_at_ms !== undefined && (
            <p className="text-xs text-muted-foreground">
              {t("lastHit", { date: formatTime(client.last_hit_at_ms) })}
            </p>
          )}
          {client.last_reset_at_ms !== undefined && (
            <p className="text-xs text-muted-foreground">
              {t("lastReset", { date: formatTime(client.last_reset_at_ms) })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {client.manual_restricted && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" size="sm" variant="outline" disabled={resetting}>
                  {t("manualRelease")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("confirmManualReleaseTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("confirmManualReleaseDescription")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <Input
                  value={releaseReason}
                  onChange={(event) => setReleaseReason(event.target.value)}
                  placeholder={t("reasonPlaceholder")}
                  maxLength={1024}
                />
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={resetting}>{tCommon("cancel")}</AlertDialogCancel>
                  <AlertDialogAction
                    type="button"
                    disabled={resetting || !releaseReason.trim()}
                    onClick={(event) => {
                      event.preventDefault();
                      void onManualRestriction(
                        client.client_instance_id,
                        false,
                        releaseReason.trim()
                      );
                    }}
                  >
                    {t("manualRelease")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" size="sm" variant="outline">
                <RotateCcw className="h-3.5 w-3.5" />
                {t("resetInstallation")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("confirmInstallationTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("confirmInstallationDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={resetting}>{tCommon("cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  type="button"
                  disabled={resetting}
                  onClick={(event) => {
                    event.preventDefault();
                    void onReset(client.client_instance_id);
                  }}
                >
                  {resetting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t("confirmReset")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  );
}

function CyberStatusBadge({
  restricted,
  t,
}: {
  restricted: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Badge variant={restricted ? "destructive" : "secondary"}>
      {restricted ? t("restricted") : t("notRestricted")}
    </Badge>
  );
}
