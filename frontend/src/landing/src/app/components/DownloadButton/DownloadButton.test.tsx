import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DownloadButton } from "./DownloadButton";

describe("DownloadButton", () => {
  it("renders one stable download label at every viewport", () => {
    const $ = load(renderToStaticMarkup(<DownloadButton />));
    const link = $("a");

    expect(link.attr("href")).toBe("/download");
    expect(link.find("span")).toHaveLength(1);
    expect(link.find("span").text()).toBe("Download AO");
  });
});
