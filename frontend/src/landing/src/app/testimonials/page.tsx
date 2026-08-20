import type { Metadata } from "next";
import Image from "next/image";
import { MessageSquareQuote, Quote } from "lucide-react";
import { TestimonialForm } from "./TestimonialForm";

export const metadata: Metadata = {
  title: "Share Your AO Story",
  description:
    "Submit your Agent Orchestrator testimonial for the AO website.",
};

const testimonialExamples = [
  "AO really changes the way you develop. The orchestrator and kanban have been a game changer. I’m no longer confused about what agent is doing what; scoping tasks and spawning them off has been a breeze.",
  "With AO Mobile, I’m able to ship things on the fly, and my agents are never blocked on my input anymore.",
  "Before AO, I would ship at most 2–3 PRs a day. Now I consistently ship 5+ PRs every day at work.",
  "There hasn’t been a day in the last two months when I opened another IDE or ran a coding agent in a terminal app. AO really changes how you think about work. It’s a mindset shift you can’t go back from.",
];

export default function TestimonialsPage() {
  return (
    <main className="min-h-[100dvh] bg-background text-foreground">
      <section className="px-4 py-10 sm:px-8 sm:py-14 lg:px-[30px] lg:py-20">
        <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(400px,480px)] lg:items-start xl:gap-8">
          <div className="relative order-2 overflow-hidden rounded-2xl border border-border bg-card lg:order-1 lg:h-[760px]">
            <Image
              src="/optimized/feature2.webp"
              alt="AO desktop showing agent work moving toward review"
              fill
              priority
              sizes="(max-width: 1023px) 100vw, 58vw"
              className="object-cover opacity-55"
            />
            <div className="absolute inset-0 bg-gradient-to-br from-background via-background/80 to-background/30" />
            <Quote
              className="absolute -right-8 top-14 size-44 rotate-6 text-foreground/[0.04] sm:size-64"
              strokeWidth={1}
              aria-hidden="true"
            />

            <div className="relative flex min-h-[680px] flex-col justify-between p-5 sm:min-h-[650px] sm:p-8 lg:h-full lg:min-h-0 lg:p-10">
              <div className="max-w-3xl">
                <p className="inline-flex items-center gap-2 rounded-full border border-border bg-background/80 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground backdrop-blur">
                  <MessageSquareQuote className="size-3.5" aria-hidden="true" />
                  Community stories
                </p>
                <h1 className="mt-5 max-w-4xl text-4xl font-semibold leading-[1.02] text-foreground sm:mt-6 sm:text-5xl lg:text-6xl">
                  Put your AO experience into words.
                </h1>
                <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
                  Tell other builders what changed when you started orchestrating
                  coding agents with AO. We&apos;ll feature selected stories in the
                  testimonials section of our website.
                </p>
              </div>

            </div>
          </div>

          <aside className="order-1 flex w-full flex-col rounded-2xl border border-border bg-card p-6 sm:p-8 lg:order-2 lg:min-h-[760px]">
            <div className="mb-6">
              <h2 className="text-2xl font-semibold text-foreground">
                Submit a testimonial
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                The most useful testimonials name a before, an after, and one
                concrete result.
              </p>
            </div>
            <TestimonialForm />
          </aside>
        </div>

        <section className="mx-auto mt-6 max-w-7xl overflow-hidden rounded-2xl border border-border bg-card p-6 sm:p-8 lg:p-10">
          <div className="grid gap-4 border-b border-border pb-7 sm:grid-cols-[minmax(0,1fr)_minmax(280px,420px)] sm:items-end">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
                A useful starting point
              </p>
              <h2 className="mt-3 text-2xl font-semibold text-foreground sm:text-3xl">
                Examples of good testimonials
              </h2>
            </div>
            <p className="text-sm leading-6 text-muted-foreground sm:text-right">
              Specific outcomes, honest before-and-after moments, and concrete
              changes are more useful than generic praise.
            </p>
          </div>

          <div className="grid md:grid-cols-2">
            {testimonialExamples.map((example, index) => (
              <blockquote
                key={example}
                className={`group relative border-border py-7 first:pt-8 ${
                  index > 0 ? "border-t" : ""
                } ${index < 2 ? "md:border-t-0" : "md:border-t"} ${
                  index % 2 === 1 ? "md:border-l md:pl-8" : "md:pr-8"
                }`}
              >
                <div className="flex items-center justify-between gap-4">
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    Example {String(index + 1).padStart(2, "0")}
                  </span>
                  <Quote
                    className="size-5 text-foreground/10 transition-colors group-hover:text-foreground/20"
                    aria-hidden="true"
                  />
                </div>
                <p className="mt-5 max-w-2xl text-base leading-7 text-foreground/90 sm:text-lg sm:leading-8">
                  “{example}”
                </p>
              </blockquote>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
