import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";

describe("DropdownMenuItem", () => {
	it("moves roving focus to the hovered item and activates it with Enter", () => {
		const firstSelect = vi.fn();
		const secondSelect = vi.fn();
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>Actions</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem onSelect={firstSelect}>First action</DropdownMenuItem>
					<DropdownMenuItem onSelect={secondSelect}>Second action</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		);

		const secondAction = screen.getByText("Second action");
		fireEvent.pointerMove(secondAction, { pointerType: "mouse" });
		fireEvent.keyDown(secondAction, { key: "Enter" });

		expect(document.activeElement).toBe(secondAction);
		expect(firstSelect).not.toHaveBeenCalled();
		expect(secondSelect).toHaveBeenCalledTimes(1);
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
