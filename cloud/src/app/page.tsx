import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { CloudEntryClient } from "./CloudEntryClient";
import {
  cloudApiBaseUrl,
  cloudWebMode,
  localAuthCookie,
} from "@/lib/cloud-config";

export const dynamic = "force-dynamic";

export default async function CloudEntryPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const mode = cloudWebMode();
  if (mode === "local") {
    const token = (await cookies()).get(localAuthCookie)?.value;
    if (token) {
      const account = await fetch(`${cloudApiBaseUrl()}/api/cloud/v1/me`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      }).catch(() => null);
      if (account?.ok) {
        redirect("/app");
      }
    }
  }
  const params = await searchParams;
  const uiParam = params?.ui;
  const nextUi = Array.isArray(uiParam) ? uiParam.includes("next") : uiParam === "next";
  return <CloudEntryClient mode={mode} nextUi={nextUi} />;
}
