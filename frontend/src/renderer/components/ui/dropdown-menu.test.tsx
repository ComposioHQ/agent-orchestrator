import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";

describe("DropdownMenuItem", () => {
	it("uses CSS hover styling without moving roving focus", () => {
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>Actions</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem>First action</DropdownMenuItem>
					<DropdownMenuItem>Second action</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		);

		const secondAction = screen.getByText("Second action");
		fireEvent.pointerMove(secondAction);

		expect(document.activeElement).not.toBe(secondAction);
		expect(secondAction).toHaveClass("hover:bg-interactive-hover", "hover:text-foreground");
	});

	it("still activates an item on click", () => {
		const select = vi.fn();
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>Actions</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem onSelect={select}>Delete</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		);

		fireEvent.click(screen.getByText("Delete"));

		expect(select).toHaveBeenCalledTimes(1);
	});
});
