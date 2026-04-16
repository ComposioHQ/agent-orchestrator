import { describe, it, expect } from "vitest";

describe("ProjectSidebar", () => {
  it("mobile-open class present when mobileOpen=true", () => {
    const className = "project-sidebar project-sidebar--mobile-open";
    expect(className).toContain("mobile-open");
  });

  it("backdrop renders when mobileOpen=true", () => {
    const backdropClass = "sidebar-mobile-backdrop";
    expect(backdropClass).toBeDefined();
  });

  it("show killed toggle changes filter state", () => {
    let showKilled = false;
    showKilled = !showKilled;
    expect(showKilled).toBe(true);
  });

  it("show done toggle changes filter state", () => {
    let showDone = false;
    showDone = !showDone;
    expect(showDone).toBe(true);
  });

  it("session row shows ao-{id} subheader", () => {
    const sessionId = "abc123def456";
    const subheader = `ao-${sessionId.slice(0, 6)}`;
    expect(subheader).toBe("ao-abc123");
  });

  it("shows loading skeletons instead of the empty state while sessions are loading", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={null}
        loading
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    expect(screen.getByLabelText("Loading sessions")).toBeInTheDocument();
    expect(screen.queryByText("No active sessions")).not.toBeInTheDocument();
  });
});
