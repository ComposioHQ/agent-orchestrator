import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AndroidBetaDialog } from "./AndroidBetaDialog";

describe("AndroidBetaDialog", () => {
  it("renders the closed-beta entry point without opening the modal", () => {
    const $ = load(renderToStaticMarkup(<AndroidBetaDialog />));
    const trigger = $("button");

    expect(trigger.attr("type")).toBe("button");
    expect(trigger.text()).toContain("Join Android Beta");
    expect(trigger.find("svg").attr("aria-hidden")).toBe("true");
    expect($("[role=dialog]")).toHaveLength(0);
  });
});
