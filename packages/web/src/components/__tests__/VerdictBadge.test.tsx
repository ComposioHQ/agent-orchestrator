import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  VerdictBadge,
  type Verdict,
  type VerdictNextAction,
} from "../VerdictBadge";

describe("VerdictBadge", () => {
  const verdicts: Array<{
    verdict: Verdict;
    label: string;
    icon: string;
  }> = [
    { verdict: "pass", label: "pass", icon: "\u2713" },
    { verdict: "hard-fail", label: "hard fail", icon: "\u2717" },
    { verdict: "soft-fail", label: "soft fail", icon: "\u26A0" },
    { verdict: "human-review", label: "review", icon: "\u25C6" },
  ];

  it.each(verdicts)(
    "renders $verdict verdict with correct label and icon",
    ({ verdict, label, icon }) => {
      render(<VerdictBadge verdict={verdict} />);
      const badge = screen.getByText(label, { exact: false });
      expect(badge).toBeInTheDocument();
      expect(badge.closest("span")!).toHaveTextContent(icon);
    },
  );

  it("renders next action pill when provided", () => {
    render(
      <VerdictBadge verdict="soft-fail" verdictNextAction="retry-src" />,
    );
    expect(screen.getByText("retry source")).toBeInTheDocument();
  });

  it("does not render next action when omitted", () => {
    render(<VerdictBadge verdict="pass" />);
    // Only the verdict pill text should exist, no next-action text
    expect(screen.queryByText("finish")).not.toBeInTheDocument();
    expect(screen.queryByText("blocked")).not.toBeInTheDocument();
  });

  it("does not render next action when null", () => {
    render(<VerdictBadge verdict="pass" verdictNextAction={null} />);
    expect(screen.queryByText("finish")).not.toBeInTheDocument();
    expect(screen.queryByText("blocked")).not.toBeInTheDocument();
  });

  it("sets title attribute from verdictReason", () => {
    render(
      <VerdictBadge
        verdict="hard-fail"
        verdictReason="CI failed on 3 checks"
      />,
    );
    expect(screen.getByTitle("CI failed on 3 checks")).toBeInTheDocument();
  });

  it("omits title when verdictReason is null", () => {
    render(<VerdictBadge verdict="pass" verdictReason={null} />);
    const wrapper = screen.getByText("pass").closest("span")!.parentElement!;
    expect(wrapper.getAttribute("title")).toBeNull();
  });

  it("applies green styling for pass verdict", () => {
    render(<VerdictBadge verdict="pass" />);
    const badge = screen.getByText("pass").closest("span")!;
    expect(badge.className).toContain("color-accent-green");
  });

  it("applies red styling for hard-fail verdict", () => {
    render(<VerdictBadge verdict="hard-fail" />);
    const badge = screen.getByText("hard fail").closest("span")!;
    expect(badge.className).toContain("color-accent-red");
  });

  it("applies yellow styling for soft-fail verdict", () => {
    render(<VerdictBadge verdict="soft-fail" />);
    const badge = screen.getByText("soft fail").closest("span")!;
    expect(badge.className).toContain("color-accent-yellow");
  });

  it("applies orange styling for human-review verdict", () => {
    render(<VerdictBadge verdict="human-review" />);
    const badge = screen.getByText("review").closest("span")!;
    expect(badge.className).toContain("color-accent-orange");
  });

  const actions: Array<{
    action: VerdictNextAction;
    expected: string;
  }> = [
    { action: "finish", expected: "finish" },
    { action: "retry-oh", expected: "retry orchestrator" },
    { action: "retry-src", expected: "retry source" },
    { action: "wait-human", expected: "awaiting input" },
    { action: "block", expected: "blocked" },
  ];

  it.each(actions)(
    "renders correct label for next action $action",
    ({ action, expected }) => {
      render(<VerdictBadge verdict="pass" verdictNextAction={action} />);
      expect(screen.getByText(expected)).toBeInTheDocument();
    },
  );
});
