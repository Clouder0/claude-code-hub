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
  disabled,
}: {
  userId: number;
  userName: string;
  disabled: boolean;
}) {
  const t = useTranslations("dashboard.securityEvents");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const disableUser = () => {
    startTransition(async () => {
      try {
        const result = await toggleUserEnabled(userId, false);
        if (!result.ok) {
          toast.error(result.error || t("actions.failed"));
          return;
        }
        toast.success(t("actions.success", { user: userName }));
        setOpen(false);
        router.refresh();
      } catch {
        toast.error(t("actions.failed"));
      }
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="destructive" disabled={disabled || pending}>
          {pending && <Loader2 className="animate-spin" />}
          {disabled ? t("actions.disabled") : t("actions.disable")}
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
              disableUser();
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
