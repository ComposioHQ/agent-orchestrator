import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";

import { cloudWebMode, workosRedirectUri } from "@/lib/cloud-config";

export async function GET() {
  if (cloudWebMode() === "local") {
    redirect("/");
  }
  redirect(
    await getSignInUrl({
      redirectUri: workosRedirectUri(),
      returnTo: "/app",
    }),
  );
}
