import {
  ANDROID_TESTER_GROUP_URL,
  ANDROID_TEST_OPT_IN_URL,
} from "@ao/shared/constants";
import { ExternalLink } from "lucide-react";

const STEPS = [
  {
    title: "Join the tester group",
    body: "Join with the same Google account you use in Google Play.",
    href: ANDROID_TESTER_GROUP_URL,
    action: "Join the Google Group",
  },
  {
    title: "Become a tester",
    body: "Open the closed-test invite and tap Become a tester.",
    href: ANDROID_TEST_OPT_IN_URL,
    action: "Open the testing invite",
  },
  {
    title: "Install AO Mobile",
    body: "After opting in, use the Google Play link on that page to install the app.",
  },
] as const;

export function AndroidBetaInstructions() {
  return (
    <>
      <ol className="space-y-5">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex gap-3.5">
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-bold text-background"
            >
              {index + 1}
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">
                {step.title}
              </h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {step.body}
              </p>
              {"href" in step ? (
                <a
                  href={step.href}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-foreground underline underline-offset-4 transition-opacity hover:opacity-75"
                >
                  {step.action}
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-6 rounded-xl border border-border bg-background/40 p-4 text-sm leading-6 text-muted-foreground">
        <p>
          Just joined? Google Play access can take up to an hour to activate.
        </p>
      </div>
    </>
  );
}
