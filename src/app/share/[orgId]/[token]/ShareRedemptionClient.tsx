"use client";

import { CloudApiError } from "@aoagents/cloud-client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { savePendingShareRedemption } from "@/lib/cloud-client";

export function ShareRedemptionClient({
  orgId,
  token,
}: {
  orgId: string;
  token: string;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("Opening shared project…");

  useEffect(() => {
    let active = true;
    void fetch("/api/cloud/v1/share-links/redeem", {
      method: "POST",
      headers: {
        Authorization: "Bearer same-origin-session",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ orgId, token }),
    })
      .then(async (response) => {
        if (response.ok) return;
        const body = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new CloudApiError(response.status, {
          error: response.statusText,
          code: "SHARE_REDEMPTION_FAILED",
          message: body?.message ?? "This share link could not be opened.",
          requestId: "",
        });
      })
      .then(() => {
        if (active) router.replace("/app");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof CloudApiError && cause.status === 401) {
          savePendingShareRedemption(orgId, token);
          router.replace("/");
          return;
        }
        setMessage(
          cause instanceof CloudApiError
            ? cause.message
            : "This share link could not be opened.",
        );
      });
    return () => {
      active = false;
    };
  }, [orgId, router, token]);

  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--color-bg-primary)] p-6 text-[var(--foreground)]">
      <div className="max-w-sm text-center">
        <p className="text-sm">{message}</p>
      </div>
    </main>
  );
}
