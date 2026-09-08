import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskStartupProvider, TaskStartupRoute, useTaskStartupVisibility } from "./TaskStartupContext";

function Owner({ visible }: { visible: boolean }) {
	useTaskStartupVisibility(visible);
	return null;
}

function Shell({ first, second }: { first?: boolean; second?: boolean }) {
	return (
		<TaskStartupProvider>
			<button type="button">Sidebar navigation</button>
			<TaskStartupRoute><button type="button">Underlying session control</button></TaskStartupRoute>
			{first !== undefined ? <Owner visible={first} /> : null}
			{second !== undefined ? <Owner visible={second} /> : null}
		</TaskStartupProvider>
	);
}

describe("startup route coverage", () => {
	it("covers only the underlying route until all visible startup owners release it", () => {
		const view = render(<Shell first second />);
		const route = screen.getByTestId("task-startup-underlying-route");
		expect(route).toHaveAttribute("inert");
		expect(route).toHaveAttribute("aria-hidden", "true");
		expect(route).toHaveClass("invisible");
		expect(screen.getByRole("button", { name: "Sidebar navigation" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Underlying session control" })).not.toBeInTheDocument();
		view.rerender(<Shell first={false} second />);
		expect(route).toHaveAttribute("inert");
		view.rerender(<Shell first={false} />);
		expect(route).not.toHaveAttribute("inert");
		expect(route).not.toHaveAttribute("aria-hidden");
		expect(route).not.toHaveClass("invisible");
		expect(screen.getByRole("button", { name: "Underlying session control" })).toBeInTheDocument();
	});
});
