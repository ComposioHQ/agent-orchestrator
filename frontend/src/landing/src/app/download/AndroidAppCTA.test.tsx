import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../hooks/useOS", () => ({
  Platform: { Mobile: "mobile" },
  usePlatform: () => ({ platform: "mobile", mobileOS: "ios" }),
}));

import { AndroidAppCTA, androidCtaMode } from "./AndroidAppCTA";

describe("AndroidAppCTA", () => {
  it("routes any mobile visitor to the direct-install sheet trigger", () => {
    expect(androidCtaMode("mobile")).toBe("sheet");

    const $ = load(renderToStaticMarkup(<AndroidAppCTA />));
    const trigger = $("button");

    expect(trigger.attr("type")).toBe("button");
    expect(trigger.text()).toContain("Join Android Beta");
    expect($("[role=dialog]")).toHaveLength(0);
  });

  it("keeps the QR dialog handoff on desktop", () => {
    expect(androidCtaMode("windows")).toBe("dialog");
  });
});
