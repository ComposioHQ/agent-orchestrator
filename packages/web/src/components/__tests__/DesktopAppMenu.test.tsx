import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { DesktopAppMenu } from "../DesktopAppMenu";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("DesktopAppMenu", () => {
  it("opens app navigation links instead of toggling the project sidebar", () => {
    render(
      <DesktopAppMenu
        activeTab="dashboard"
        dashboardHref="/?project=my-app"
        prsHref="/prs?project=my-app"
        phasesHref="/phases?project=my-app"
        orchestratorHref="/sessions/my-app-orchestrator"
      />,
    );

    expect(screen.queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "href",
      "/?project=my-app",
    );
    expect(screen.getByRole("link", { name: "Kanban" })).toHaveAttribute(
      "href",
      "/phases?project=my-app",
    );
    expect(screen.getByRole("link", { name: "PRs" })).toHaveAttribute(
      "href",
      "/prs?project=my-app",
    );
    expect(screen.getByRole("link", { name: "Orchestrator" })).toHaveAttribute(
      "href",
      "/sessions/my-app-orchestrator",
    );
  });
});
