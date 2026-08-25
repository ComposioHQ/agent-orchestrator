import { withAuth } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";

import { cloudWebMode } from "@/lib/cloud-config";
import { ShareRedemptionClient } from "./ShareRedemptionClient";

export const dynamic = "force-dynamic";

export default async function ShareRedemptionPage({
  params,
}: {
  params: Promise<{ orgId: string; token: string }>;
}) {
  const { orgId, token } = await params;
  if (cloudWebMode() === "local") {
    return <ShareRedemptionClient orgId={orgId} token={token} />;
  }

  const returnTo = `/app?shareOrg=${encodeURIComponent(orgId)}&share=${encodeURIComponent(token)}`;
  const auth = await withAuth();
  if (!auth.user) {
    redirect(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
  }
  redirect(returnTo);
}
