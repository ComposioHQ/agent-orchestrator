import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { CloudBrowser } from "./CloudBrowser";

it("routes localhost URLs through the selected VM browser proxy", () => {
  render(<CloudBrowser organizationId="org-1" sessionId="session-1" />);

  fireEvent.change(screen.getByLabelText("VM browser URL"), {
    target: { value: "localhost:3000/app" },
  });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);

  const frame = screen.getByTitle("VM browser");
  expect(frame).toHaveAttribute(
    "src",
    expect.stringMatching(/^\/api\/cloud\/v1\/orgs\/org-1\/sessions\/session-1\/browser\/.+\/app$/),
  );
});
