"use client";

import { useRouter } from "next/navigation";

import { AOLogo } from "./AOLogo";

import { PrismLogoGrid } from "./auth/PrismLogoGrid";

export default function CloudEntryPage() {
  const router = useRouter();

  return (
    <main className="grid min-h-dvh bg-[#0a0b0d] text-[#f4f5f7] lg:grid-cols-[minmax(420px,0.82fr)_minmax(520px,1.18fr)]">
      <section className="relative flex min-h-dvh animate-[auth-form-enter_600ms_cubic-bezier(0.22,1,0.36,1)_both] flex-col border-white/[0.07] px-6 py-6 motion-reduce:animate-none sm:px-10 sm:py-8 lg:border-r lg:px-[clamp(3rem,7vw,7.5rem)]">
        <AOLogo />

        <div className="my-auto w-full max-w-[380px] py-16">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#646a73]">
            AO Cloud
          </p>
          <h1 className="mt-3 text-[clamp(2rem,4vw,3.25rem)] font-medium leading-none tracking-[-0.055em]">
            Your agents.<br />One workspace.
          </h1>
          <p className="mt-5 max-w-sm text-sm leading-6 text-[#9ba1aa]">
            Sign in securely with WorkOS to open your cloud board.
          </p>

          <button
            type="button"
            className="mt-10 inline-flex h-11 w-full cursor-pointer items-center justify-center rounded-md bg-[#f4f5f7] px-4 text-sm font-medium text-[#0a0b0d] transition-[background-color,transform] hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8bb5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0b0d] active:scale-[0.99] motion-reduce:transform-none"
            onClick={() => router.push("/app")}
          >
            Continue to Cloud
          </button>
        </div>

        <p className="text-[11px] leading-5 text-[#646a73]">
          Your sessions keep running when this window closes.
        </p>
      </section>

      <aside className="hidden min-h-dvh lg:block" aria-label="Agent Orchestrator">
        <PrismLogoGrid />
      </aside>
    </main>
  );
}
