import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Modal } from "@/components/Modal";

describe("Modal", () => {
  it("renders with correct aria attributes when open", () => {
    render(
      <Modal open onClose={vi.fn()} title="Test Modal">
        <button type="button">Inner Button</button>
      </Modal>,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "Test Modal");
  });

  it("does not render when closed", () => {
    render(
      <Modal open={false} onClose={vi.fn()} title="Hidden">
        <p>Content</p>
      </Modal>,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Escapable">
        <button type="button">Focus me</button>
      </Modal>,
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps focus within the modal", () => {
    render(
      <Modal open onClose={vi.fn()} title="Trap Test">
        <button type="button">First</button>
        <button type="button">Second</button>
      </Modal>,
    );

    const _firstButton = screen.getByText("First");
    const closeButton = screen.getByLabelText("Close");

    // Focus the close button (last focusable in header)
    closeButton.focus();
    expect(document.activeElement).toBe(closeButton);

    // Tab forward from last element should wrap to first focusable (Close button is in header, First and Second are in body)
    // The focusable order is: Close button -> First -> Second
    // When on Second (last), Tab should wrap to Close (first)
    const secondButton = screen.getByText("Second");
    secondButton.focus();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    // After tab from last, should wrap to first focusable
    expect(document.activeElement).toBe(closeButton);
  });

  it("traps focus backward with Shift+Tab", () => {
    render(
      <Modal open onClose={vi.fn()} title="Trap Back">
        <button type="button">Only Button</button>
      </Modal>,
    );

    const closeButton = screen.getByLabelText("Close");
    closeButton.focus();

    // Shift+Tab from first focusable should wrap to last
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText("Only Button"));
  });
});
