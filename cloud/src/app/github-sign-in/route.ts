import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";

import { workosRedirectUri } from "@/lib/cloud-config";

export async function GET() {
  const authorizationURL = await getSignInUrl({
    redirectUri: workosRedirectUri(),
    returnTo: "/app?settings=providers",
  });
  redirect(authorizationURL);
}
