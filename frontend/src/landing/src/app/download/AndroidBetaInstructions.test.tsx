import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AndroidBetaInstructions } from "./AndroidBetaInstructions";

describe("AndroidBetaInstructions", () => {
  it("keeps the closed-test enrollment steps in the required order", () => {
    const $ = load(renderToStaticMarkup(<AndroidBetaInstructions />));

    expect($("ol h3").map((_, element) => $(element).text()).get()).toEqual([
      "Join the tester group",
      "Become a tester",
      "Install AO Mobile",
    ]);
    expect($("a").map((_, element) => $(element).attr("href")).get()).toEqual([
      "https://groups.google.com/g/ao-mobile-testers/about",
      "https://play.google.com/apps/testing/aoagents.dev",
    ]);
  });

  it("sets expectations for access propagation without stale testing copy", () => {
    const html = renderToStaticMarkup(<AndroidBetaInstructions />);

    expect(html).toContain("same Google account you use in Google Play");
    expect(html).toContain("up to an hour");
    expect(html).not.toContain("14 continuous days");
    expect(html).not.toContain("remain opted in");
    expect(html).not.toContain("resets for everyone");
  });
});
