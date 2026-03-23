import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TerminalEmbed } from "@/components/TerminalEmbed";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/DirectTerminal", () => ({
  DirectTerminal: (props: Record<string, unknown>) => (
    <div data-testid="direct-terminal" data-session-id={props.sessionId} />
  ),
}));

describe("TerminalEmbed", () => {
  const defaultProps = {
    sessionId: "s-1",
    startFullscreen: false,
    isOrchestrator: false,
    activityColor: "var(--color-status-working)",
    isOpenCodeSession: false,
    hasPR: false,
  };

  it("renders terminal label", () => {
    render(<TerminalEmbed {...defaultProps} />);
    expect(screen.getByText("Terminal")).toBeInTheDocument();
  });

  it("renders DirectTerminal with session id", () => {
    render(<TerminalEmbed {...defaultProps} />);
    const terminal = screen.getByTestId("direct-terminal");
    expect(terminal).toHaveAttribute("data-session-id", "s-1");
  });

  it("adds mt-6 class when hasPR is true", () => {
    const { container } = render(<TerminalEmbed {...defaultProps} hasPR />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("mt-6");
  });

  it("does not add mt-6 class when hasPR is false", () => {
    const { container } = render(<TerminalEmbed {...defaultProps} hasPR={false} />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).not.toContain("mt-6");
  });
});
