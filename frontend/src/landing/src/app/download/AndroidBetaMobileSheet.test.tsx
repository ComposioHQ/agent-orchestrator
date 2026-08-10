import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/analytics", () => ({ track: vi.fn() }));

import { AndroidBetaMobileSheet } from "./AndroidBetaMobileSheet";

describe("AndroidBetaMobileSheet", () => {
  it("gives Android visitors the complete closed-test flow without a QR", () => {
    const $ = load(
      renderToStaticMarkup(
        <AndroidBetaMobileSheet open onClose={() => undefined} />,
      ),
    );

    expect($("[role=dialog]").attr("aria-labelledby")).toBe(
      "android-beta-sheet-title",
    );
    expect($("#android-beta-sheet-title").text()).toBe(
      "Get AO on this Android",
    );
    expect($("ol li p.font-semibold").map((_, el) => $(el).text()).get()).toEqual([
      "Join the tester group",
      "Become a tester",
      "Install AO Mobile",
    ]);
    expect($("ol a").map((_, el) => $(el).attr("href")).get()).toEqual([
      "https://groups.google.com/g/ao-mobile-testers/about",
      "https://play.google.com/apps/testing/aoagents.dev",
    ]);
    expect($.html()).toContain("up to an hour");
    expect($.html()).not.toContain("14 continuous days");
    expect($.html()).not.toContain("remain opted in");
    expect($("svg").filter((_, el) => $(el).attr("viewBox") === "0 0 21 21")).toHaveLength(0);
  });

  it("renders no dialog while closed", () => {
    const $ = load(
      renderToStaticMarkup(
        <AndroidBetaMobileSheet open={false} onClose={() => undefined} />,
      ),
    );

    expect($("[role=dialog]")).toHaveLength(0);
  });
});
