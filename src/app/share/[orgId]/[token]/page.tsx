"use client";

import { CloudApiError } from "@aoagents/cloud-client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { savePendingShareRedemption } from "@/lib/cloud-client";

type RedeemState = "redeeming" | "error";

export default function ShareRedemptionPage() {
  const params = useParams<{ orgId: string; token: string }>();
  const router = useRouter();
  const [state, setState] = useState<RedeemState>("redeeming");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/cloud/v1/share-links/redeem", {
      method: "POST",
      headers: {
        Authorization: "Bearer same-origin-session",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ orgId: params.orgId, token: params.token }),
    })
      .then(async (response) => {
        if (response.ok) return;
        const body = await response.json().catch(() => null) as { message?: string } | null;
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
          savePendingShareRedemption(params.orgId, params.token);
          router.replace("/");
          return;
        }
        setState("error");
        setMessage(
          cause instanceof CloudApiError
            ? cause.message
            : "This share link could not be opened.",
        );
      });
    return () => {
      active = false;
    };
  }, [params.orgId, params.token, router]);

  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--color-bg-primary)] p-6 text-[var(--foreground)]">
      <div className="max-w-sm text-center">
        <p className="text-sm">
          {state === "redeeming"
            ? "Opening shared project…"
            : message}
        </p>
        {state === "error" ? (
          <a
            className="mt-4 inline-block text-xs text-[#8bb5ff] hover:underline"
            href="/app"
          >
            Go to your workspace
          </a>
        ) : null}
      </div>
    </main>
  );
}
