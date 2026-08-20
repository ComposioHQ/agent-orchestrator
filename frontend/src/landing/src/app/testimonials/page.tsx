import type { Metadata } from "next";
import Image from "next/image";
import { Linkedin, MessageSquareQuote, Quote } from "lucide-react";
import { TestimonialForm } from "./TestimonialForm";

export const metadata: Metadata = {
  title: "Share Your AO Story",
  description:
    "Submit your Agent Orchestrator testimonial for the AO website.",
};

const notes = [
  {
    icon: MessageSquareQuote,
    label: "Tell the real story",
    text: "Share the moment AO changed how you run or review agent work.",
  },
  {
    icon: Linkedin,
    label: "Add your attribution",
    text: "Your public LinkedIn profile gives the story a face, company, and role.",
  },
  {
    icon: Quote,
    label: "Join the website",
    text: "Selected stories will appear in the testimonials section on aoagents.dev.",
  },
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

              <div className="mt-8 grid gap-3 sm:mt-10 sm:grid-cols-3 lg:mt-12">
                {notes.map((note) => {
                  const Icon = note.icon;
                  return (
                    <div
                      key={note.label}
                      className="rounded-xl border border-border bg-background/80 p-3 backdrop-blur sm:p-4"
                    >
                      <Icon
                        className="size-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <h2 className="mt-3 text-sm font-semibold text-foreground">
                        {note.label}
                      </h2>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {note.text}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <aside className="order-1 flex w-full flex-col rounded-2xl border border-border bg-card p-6 sm:p-8 lg:order-2 lg:min-h-[760px]">
            <div className="mb-6">
              <p className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
                Your perspective
              </p>
              <h2 className="mt-3 text-2xl font-semibold text-foreground">
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
      </section>
    </main>
  );
}
