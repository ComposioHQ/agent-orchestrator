import { authkitMiddleware } from "@workos-inc/authkit-nextjs";
import { NextResponse } from "next/server";

const redirectUri =
  process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ??
  new URL(
    "/callback",
    process.env.NEXT_PUBLIC_WEB_URL ?? "http://localhost:3000",
  ).toString();

export default process.env.NEXT_PUBLIC_AO_AUTH_MODE === "workos"
  ? authkitMiddleware({ redirectUri })
  : () => NextResponse.next();
