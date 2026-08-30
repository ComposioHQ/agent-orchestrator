import * as Dialog from "@radix-ui/react-dialog";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HostSelect } from "./HostSelect";
import { LOCAL_HOST_ID, type Host } from "../hooks/useRemoteHosts";

function trigger() {
	return screen.getByRole("button", { name: /^host:/i });
}

const hosts: Host[] = [
	{ id: LOCAL_HOST_ID, label: "This Mac", url: null, status: "local" },
	{ id: "http://192.0.2.1:3011", label: "workbox", url: "http://192.0.2.1:3011", status: "online" },
	{ id: "http://192.0.2.9:3011", label: "mini", url: "http://192.0.2.9:3011", status: "offline" },
];

describe("HostSelect", () => {
	it("shows the selected host's label on the trigger", () => {
		render(<HostSelect hosts={hosts} value={LOCAL_HOST_ID} onChange={vi.fn()} onAddHost={vi.fn()} />);
		expect(trigger()).toHaveTextContent("This Mac");
	});

	it("reports the chosen host id", async () => {
		const onChange = vi.fn();
		render(<HostSelect hosts={hosts} value={LOCAL_HOST_ID} onChange={onChange} onAddHost={vi.fn()} />);
		await userEvent.click(trigger());
		await userEvent.click(screen.getByRole("button", { name: /^workbox/ }));
		expect(onChange).toHaveBeenCalledWith("http://192.0.2.1:3011");
	});

	it("offers adding a host", async () => {
		const onAddHost = vi.fn();
		render(<HostSelect hosts={hosts} value={LOCAL_HOST_ID} onChange={vi.fn()} onAddHost={onAddHost} />);
		await userEvent.click(trigger());
		await userEvent.click(screen.getByRole("button", { name: /add remote host/i }));
		expect(onAddHost).toHaveBeenCalled();
	});

	// aria-disabled, not disabled: a disabled button is skipped by every keyboard
	// and silent to a screen reader, and this row is the only place the reason it
	// cannot be picked is written down.
	it("does not let an offline host be selected, but keeps it readable", async () => {
		const onChange = vi.fn();
		render(<HostSelect hosts={hosts} value={LOCAL_HOST_ID} onChange={onChange} onAddHost={vi.fn()} />);
		await userEvent.click(trigger());
		const offline = screen.getByRole("button", { name: /^mini/ });
		expect(offline).toHaveAttribute("aria-disabled", "true");
		offline.focus();
		expect(offline).toHaveFocus();
		// The row is pointer-events-none like the SelectItem it replaced, so the
		// path left to guard is the keyboard one.
		await userEvent.keyboard("{Enter}");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("states each remote's status as text, not colour alone", async () => {
		render(<HostSelect hosts={hosts} value={LOCAL_HOST_ID} onChange={vi.fn()} onAddHost={vi.fn()} />);
		await userEvent.click(trigger());
		expect(screen.getByRole("button", { name: /^mini/ })).toHaveTextContent(/disconnected/i);
	});

	it("offers Edit and Remove on each saved host, naming which one", async () => {
		const onEditHost = vi.fn();
		const onRemoveHost = vi.fn();
		const onChange = vi.fn();
		render(
			<HostSelect
				hosts={hosts}
				value={LOCAL_HOST_ID}
				onChange={onChange}
				onAddHost={vi.fn()}
				onEditHost={onEditHost}
				onRemoveHost={onRemoveHost}
			/>,
		);
		await userEvent.click(trigger());

		// "Edit" alone would be three identical buttons to a screen reader.
		await userEvent.click(screen.getByRole("button", { name: /edit workbox/i }));
		expect(onEditHost).toHaveBeenCalledWith({ label: "workbox", url: "http://192.0.2.1:3011" });

		// Both actions close the list, because both open a dialog on top of it.
		expect(screen.queryByRole("button", { name: /remove mini/i })).not.toBeInTheDocument();
		await userEvent.click(trigger());
		await userEvent.click(screen.getByRole("button", { name: /remove mini/i }));
		expect(onRemoveHost).toHaveBeenCalledWith({ label: "mini", url: "http://192.0.2.9:3011" });
		// Neither action may select the row it sits on.
		expect(onChange).not.toHaveBeenCalled();
	});

	// An unreachable host is exactly the one that needs editing, so its actions
	// must survive the row being disabled.
	it("keeps Edit and Remove usable on a host that cannot be reached", async () => {
		const onEditHost = vi.fn();
		render(
			<HostSelect
				hosts={hosts}
				value={LOCAL_HOST_ID}
				onChange={vi.fn()}
				onAddHost={vi.fn()}
				onEditHost={onEditHost}
				onRemoveHost={vi.fn()}
			/>,
		);
		await userEvent.click(trigger());
		await userEvent.click(screen.getByRole("button", { name: /edit mini/i }));
		expect(onEditHost).toHaveBeenCalledWith({ label: "mini", url: "http://192.0.2.9:3011" });
	});

	// The list used to be a Radix Select, which calls preventDefault() on Tab
	// inside its listbox: every one of these actions was mouse-only.
	it("reaches every host action with the keyboard", async () => {
		render(
			<HostSelect
				hosts={hosts}
				value={LOCAL_HOST_ID}
				onChange={vi.fn()}
				onAddHost={vi.fn()}
				onReconnect={vi.fn()}
				onEditHost={vi.fn()}
				onRemoveHost={vi.fn()}
			/>,
		);
		await userEvent.click(trigger());

		const reachable: string[] = [];
		for (let step = 0; step < 12; step += 1) {
			await userEvent.tab();
			const focused = document.activeElement as HTMLElement | null;
			const name = focused?.getAttribute("aria-label") ?? focused?.textContent ?? "";
			if (reachable.includes(name)) break;
			reachable.push(name);
		}

		expect(reachable).toEqual(
			expect.arrayContaining([
				"Edit workbox",
				"Remove workbox",
				"Connect to mini",
				"Edit mini",
				"Remove mini",
			]),
		);
	});

	// The picker's only caller renders it inside the create-project dialog, so
	// the list portals out of a container that is itself trapping focus.
	it("keeps its actions reachable inside a dialog", async () => {
		render(
			<Dialog.Root open>
				<Dialog.Portal>
					<Dialog.Content aria-label="Create project">
						<HostSelect
							hosts={hosts}
							value={LOCAL_HOST_ID}
							onChange={vi.fn()}
							onAddHost={vi.fn()}
							onEditHost={vi.fn()}
							onRemoveHost={vi.fn()}
						/>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog.Root>,
		);
		await userEvent.click(trigger());

		const edit = screen.getByRole("button", { name: "Edit workbox" });
		edit.focus();
		expect(edit).toHaveFocus();
	});

	it("marks the host in use as the current one", async () => {
		render(<HostSelect hosts={hosts} value={LOCAL_HOST_ID} onChange={vi.fn()} onAddHost={vi.fn()} />);
		await userEvent.click(trigger());
		expect(screen.getByRole("button", { name: /^this mac/i })).toHaveAttribute("aria-current", "true");
		expect(screen.getByRole("button", { name: /^workbox/ })).not.toHaveAttribute("aria-current");
	});

	it("offers neither on This Mac, which is not a saved host", async () => {
		render(
			<HostSelect
				hosts={hosts}
				value={LOCAL_HOST_ID}
				onChange={vi.fn()}
				onAddHost={vi.fn()}
				onEditHost={vi.fn()}
				onRemoveHost={vi.fn()}
			/>,
		);
		await userEvent.click(trigger());
		expect(screen.queryByRole("button", { name: /edit this mac/i })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /remove this mac/i })).not.toBeInTheDocument();
	});

	it("offers a Connect action on an unreachable host and re-probes it", async () => {
		const onReconnect = vi.fn();
		const onChange = vi.fn();
		render(
			<HostSelect
				hosts={hosts}
				value={LOCAL_HOST_ID}
				onChange={onChange}
				onAddHost={vi.fn()}
				onReconnect={onReconnect}
			/>,
		);
		await userEvent.click(trigger());
		await userEvent.click(screen.getByRole("button", { name: /^connect to mini$/i }));
		expect(onReconnect).toHaveBeenCalledWith("http://192.0.2.9:3011");
		// The row itself must not get selected by clicking its inline action. The
		// list stays open so the re-probe is visible in place, and Radix aria-hides
		// the trigger while it is — hence `hidden: true` rather than a plain query.
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: /^host:/i, hidden: true })).toHaveTextContent("This Mac");
	});
});
