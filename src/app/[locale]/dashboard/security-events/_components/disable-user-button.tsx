"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
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
import { Button } from "@/components/ui/button";
import { toggleUserEnabled } from "@/lib/api-client/v1/actions/users";

export function DisableUserButton({
  userId,
  userName,
  userEnabled,
  self,
}: {
  userId: number;
  userName: string;
  userEnabled: boolean;
  self: boolean;
}) {
  const t = useTranslations("dashboard.securityEvents");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const runToggle = (enabled: boolean) => {
    startTransition(async () => {
      try {
        const result = await toggleUserEnabled(userId, enabled);
        if (!result.ok) {
          toast.error(result.error || t("actions.failed"));
          return;
        }
        toast.success(
          enabled
            ? t("actions.enableSuccess", { user: userName })
            : t("actions.success", { user: userName })
        );
        setOpen(false);
        router.refresh();
      } catch {
        toast.error(t("actions.failed"));
      }
    });
  };

  if (!userEnabled) {
    return (
      <Button size="sm" variant="outline" disabled={pending} onClick={() => runToggle(true)}>
        {pending && <Loader2 className="animate-spin" />}
        {t("actions.enable")}
      </Button>
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="destructive" disabled={self || pending}>
          {pending && <Loader2 className="animate-spin" />}
          {t("actions.disable")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("actions.confirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("actions.confirmDescription", { user: userName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              runToggle(false);
            }}
            disabled={pending}
          >
            {t("actions.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
