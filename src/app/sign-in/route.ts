import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { cloudWebMode, workosRedirectUri } from "@/lib/cloud-config";
import { cloudAuthReturnTo } from "@/lib/auth-return-to";

export async function GET(request: NextRequest) {
  if (cloudWebMode() === "local") {
    redirect("/");
  }
  redirect(
    await getSignInUrl({
      redirectUri: workosRedirectUri(),
      returnTo: cloudAuthReturnTo(request.nextUrl.searchParams.get("returnTo")),
    }),
  );
}
