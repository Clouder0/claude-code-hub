"use client";

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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { releaseLocalUnconfirmedBioContainment } from "@/lib/api-client/v1/actions/users";

export function ReleaseUnconfirmedBioButton(props: {
  userId: number;
  messageRequestId: number;
  sessionId: string;
  clientInstanceId: string | null;
}) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="destructive">
          Release local bio block
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Release unconfirmed local bio containment?</AlertDialogTitle>
          <AlertDialogDescription>
            Central Cyber Check has no confirmed restriction. The user remains disabled; any other
            central restriction is preserved.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Audit reason"
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || !reason.trim()}
            onClick={(event) => {
              event.preventDefault();
              setPending(true);
              void releaseLocalUnconfirmedBioContainment(
                props.userId,
                props.messageRequestId,
                props.sessionId,
                props.clientInstanceId,
                reason.trim()
              ).then((result) => {
                if (result.ok) toast.success("Local bio containment released");
                else toast.error(result.error ?? "Release failed");
                setPending(false);
              });
            }}
          >
            Release
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
