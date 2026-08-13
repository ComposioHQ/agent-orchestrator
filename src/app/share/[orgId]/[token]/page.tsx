"use client";

import { CloudApiError } from "@aoagents/cloud-client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  browserCloudClient,
  savePendingShareRedemption,
} from "@/lib/cloud-client";

type RedeemState = "redeeming" | "error";

export default function ShareRedemptionPage() {
  const params = useParams<{ orgId: string; token: string }>();
  const router = useRouter();
  const [state, setState] = useState<RedeemState>("redeeming");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    const client = browserCloudClient();
    void client
      .redeemProjectShareLink({ orgId: params.orgId, token: params.token })
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
