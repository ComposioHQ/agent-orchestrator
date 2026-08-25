import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { CloudNewSessionDialog } from "./CloudNewSessionDialog";

it("creates a task with an agent choice and no model selector", async () => {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  render(
    <CloudNewSessionDialog
      connectedProviders={["claude-code"]}
      onClose={vi.fn()}
      onCreate={onCreate}
      open
      projectName="Cloud platform"
    />,
  );

  expect(screen.getByRole("button", { name: /Claude Code/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Claude Sonnet/ })).not.toBeInTheDocument();
  expect(screen.queryByText("Model")).not.toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText("Describe the task…"), {
    target: { value: "Fix repository access" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Start/ }));

  await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
    displayName: "Fix repository access",
    harness: "claude-code",
    prompt: "Fix repository access",
  }));
});
