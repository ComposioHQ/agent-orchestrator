import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModelFamilyOptions } from "./ModelFamilyOptions";
import { OptionMenu, OptionMenuContent, OptionMenuTrigger } from "./ui/option-menu";

describe("AO model versions", () => {
 it("opens a family without changing settings and selects the exact version", async () => {
  const select=vi.fn(); const user=userEvent.setup();
  render(<OptionMenu><OptionMenuTrigger>Models</OptionMenuTrigger><OptionMenuContent><ModelFamilyOptions models={[{id:"opus",label:"Opus"},{id:"claude-opus-4-8",label:"Opus 4.8"},{id:"claude-opus-5[1m]",label:"Opus 5 (1M)"}]} value="opus" onSelect={select}/></OptionMenuContent></OptionMenu>);
  await user.click(screen.getByRole("button",{name:"Models"}));
  await user.hover(screen.getByRole("menuitem",{name:"Opus"}));
  expect(await screen.findByText("Opus (provider alias)")).toBeVisible();
  expect(select).not.toHaveBeenCalled();
  screen.getByRole("menuitem", {name: /^Opus 4.8/}).focus();
  await user.keyboard("{Enter}");
  expect(select).toHaveBeenCalledWith("claude-opus-4-8");
 });
 it("keeps custom provider selectors selectable", async () => {
  const select=vi.fn();const user=userEvent.setup();
  render(<OptionMenu><OptionMenuTrigger>Models</OptionMenuTrigger><OptionMenuContent><ModelFamilyOptions models={[{id:"private/custom",label:"My model"}]} onSelect={select}/></OptionMenuContent></OptionMenu>);
  await user.click(screen.getByRole("button",{name:"Models"}));
  await user.click(screen.getByText("My model"));
  expect(select).toHaveBeenCalledWith("private/custom");
 });
});
