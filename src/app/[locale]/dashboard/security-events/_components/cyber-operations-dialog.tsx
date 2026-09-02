"use client";

import { ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CyberStateSection } from "../../_components/user/cyber-state-section";

export function CyberOperationsDialog({
  userId,
  userName,
  userEnabled,
}: {
  userId: number;
  userName: string;
  userEnabled: boolean;
}) {
  const t = useTranslations("dashboard.securityEvents.actions");
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <ShieldAlert className="h-3.5 w-3.5" />
          {t("containment")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("containmentTitle", { user: userName })}</DialogTitle>
          <DialogDescription>{t("containmentDescription")}</DialogDescription>
        </DialogHeader>
        <CyberStateSection userId={userId} userEnabled={userEnabled} />
      </DialogContent>
    </Dialog>
  );
}
