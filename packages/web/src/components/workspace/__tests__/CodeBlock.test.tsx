import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeBlock } from "../CodeBlock";

describe("CodeBlock", () => {
  const writeText = vi.fn();
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  });

  it("renders a header with the language label extracted from the code className", () => {
    render(
      <CodeBlock>
        <code className="language-typescript">const x = 1;</code>
      </CodeBlock>,
    );

    expect(screen.getByText("typescript")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("falls back to 'text' when no language class is present", () => {
    render(
      <CodeBlock>
        <code>plain content</code>
      </CodeBlock>,
    );

    expect(screen.getByText("text")).toBeInTheDocument();
  });

  it("copies raw code text to the clipboard and flips the button to ✓ Copied", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(
      <CodeBlock>
        <code className="language-ts">
          <span className="hljs-keyword">const</span>
          <span> </span>
          <span className="hljs-variable">x</span>
          <span> = 42;</span>
        </code>
      </CodeBlock>,
    );

    const button = screen.getByRole("button", { name: /copy/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("const x = 42;");
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /copy/i })).toHaveTextContent("✓ Copied");
    });

    vi.advanceTimersByTime(1600);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /copy/i })).toHaveTextContent(/^Copy$/);
    });
  });

  it("short-circuits mermaid blocks so no header wrapper is rendered", () => {
    const { container } = render(
      <CodeBlock>
        <code className="language-mermaid">{"graph TD; A-->B;"}</code>
      </CodeBlock>,
    );

    // No header, no copy button — mermaid renders through untouched.
    expect(container.querySelector(".workspace-md-code-block")).toBeNull();
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
    // The code element still exists as passthrough so the parent `code`
    // component override can swap it for <MermaidDiagram />.
    expect(container.querySelector("code.language-mermaid")).not.toBeNull();
  });
});
