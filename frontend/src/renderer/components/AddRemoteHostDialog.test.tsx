import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeRemote } from "../../main/remote-request";
import { fakeDaemon, type Behaviour } from "../test/fake-daemon";
import { AddRemoteHostDialog } from "./AddRemoteHostDialog";

const { addMock, updateMock, captureRendererEventMock } = vi.hoisted(() => ({
	addMock: vi.fn(),
	updateMock: vi.fn(),
	captureRendererEventMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/telemetry", () => ({ captureRendererEvent: captureRendererEventMock }));

// The bridge's `remotes` surface lands with the IPC task; mock the module
// rather than spying on a stub that does not exist yet.
vi.mock("../lib/bridge", () => ({
	aoBridge: { remotes: { add: addMock, update: updateMock } },
}));

beforeEach(() => {
	addMock.mockReset();
	addMock.mockResolvedValue("online");
	updateMock.mockReset();
	updateMock.mockResolvedValue("online");
	captureRendererEventMock.mockClear();
});

async function fillAndSubmit(address = "http://192.0.2.1:3011") {
	await userEvent.type(screen.getByLabelText(/name/i), "workbox");
	// userEvent reads "[" and "{" as key descriptors; doubling them types the
	// literal character, which is what a bracketed IPv6 address needs.
	await userEvent.type(screen.getByLabelText(/address/i), address.replace(/[[{]/g, "$&$&"));
	await userEvent.type(screen.getByLabelText(/password/i), "pw");
	await userEvent.click(screen.getByRole("button", { name: /connect/i }));
}

describe("AddRemoteHostDialog", () => {
	// Reaching the buttons from the last field is four Tab stops away; Enter is
	// what everyone actually presses.
	it("saves on Enter from a field", async () => {
		render(<AddRemoteHostDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />);
		await userEvent.type(screen.getByLabelText(/name/i), "workbox");
		await userEvent.type(screen.getByLabelText(/address/i), "192.0.2.1:3011{Enter}");

		expect(addMock).toHaveBeenCalledWith({ label: "workbox", url: "http://192.0.2.1:3011", password: "" });
	});

	// The close button is positioned absolutely, so moving it after the fields in
	// source order costs nothing visually and stops Close being the first stop.
	it("puts the first field ahead of Close in the tab order", async () => {
		render(<AddRemoteHostDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />);
		await userEvent.tab();
		expect(screen.getByLabelText(/name/i)).toHaveFocus();
	});

	it.each<Behaviour>(["html-catchall", "wrong-shape"])(
		"reports %s as a non-daemon response without throwing",
		async (behaviour) => {
			addMock.mockImplementation((entry) => probeRemote(entry, fakeDaemon(behaviour)));

			expect(() =>
				render(<AddRemoteHostDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />),
			).not.toThrow();
			await fillAndSubmit();
			expect(await screen.findByRole("alert")).toHaveTextContent(/not an AO daemon/i);
		},
	);

	// "Is adding a host working, and which way does it fail?" was unanswerable:
	// a wrong password and an unreachable machine are one dead dialog to a user.
	it("reports which way an add failed, and never the address or the password", async () => {
		addMock.mockResolvedValue("unauthorized");
		render(<AddRemoteHostDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />);
		await fillAndSubmit();

		const [event, properties] = captureRendererEventMock.mock.calls.at(-1) ?? [];
		expect(event).toBe("ao.renderer.host_connect");
		expect(properties).toMatchObject({ source: "add", result: "unauthorized", host_kind: "remote" });
		expect(typeof properties.duration_ms).toBe("number");
		// The raw id is what the sanitizer hashes; nothing else may carry a secret.
		expect(JSON.stringify({ ...properties, host_id: undefined })).not.toContain("pw");
	});

	it("saves and reports the new host when it answers", async () => {
		const onSaved = vi.fn();
		render(<AddRemoteHostDialog open onOpenChange={vi.fn()} onSaved={onSaved} />);
		await fillAndSubmit();
		expect(addMock).toHaveBeenCalledWith({ label: "workbox", url: "http://192.0.2.1:3011", password: "pw" });
		expect(onSaved).toHaveBeenCalledWith("http://192.0.2.1:3011");
	});

	it("distinguishes a wrong password from an unreachable host", async () => {
		addMock.mockResolvedValue("unauthorized");
		const onSaved = vi.fn();
		render(<AddRemoteHostDialog open onOpenChange={vi.fn()} onSaved={onSaved} />);
		await fillAndSubmit();
		expect(await screen.findByRole("alert")).toHaveTextContent(/password/i);
		expect(onSaved).not.toHaveBeenCalled();
	});

	it("says the host is unreachable when it does not answer", async () => {
		addMock.mockResolvedValue("offline");
		render(<AddRemoteHostDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />);
		await fillAndSubmit();
		expect(await screen.findByRole("alert")).toHaveTextContent(/could not reach/i);
	});

	// A bare "host:port" is what people type. It used to reach fetch() unparsed,
	// throw, and come back as "could not reach that host" — sending someone to
	// debug a network when they had only omitted a scheme.
	describe("address normalization", () => {
		const saved = ["schemeless host and port", "192.168.1.250:3011", "http://192.168.1.250:3011"] as const;
		const cases: Array<readonly [string, string, string]> = [
			saved,
			["schemeless host", "workbox", "http://workbox"],
			["bracketed IPv6 and port", "[fe80::1]:3011", "http://[fe80::1]:3011"],
			["an already-schemed url, left alone", "http://192.0.2.1:3011", "http://192.0.2.1:3011"],
			["https, left alone", "https://box.example:3011", "https://box.example:3011"],
			["a trailing slash", "http://192.0.2.1:3011/", "http://192.0.2.1:3011"],
		];

		for (const [name, typed, expected] of cases) {
			it(`saves ${name} as ${expected}`, async () => {
				const onSaved = vi.fn();
				render(<AddRemoteHostDialog open onOpenChange={vi.fn()} onSaved={onSaved} />);
				await fillAndSubmit(typed);
				expect(addMock).toHaveBeenCalledWith({ label: "workbox", url: expected, password: "pw" });
				expect(onSaved).toHaveBeenCalledWith(expected);
			});
		}

		it("shows the address it will actually save before connecting", async () => {
			render(<AddRemoteHostDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />);
			await userEvent.type(screen.getByLabelText(/address/i), "192.168.1.250:3011");
			expect(screen.getByText(/http:\/\/192\.168\.1\.250:3011/)).toBeInTheDocument();
		});

		it("stays quiet when the typed address is already the saved one", async () => {
			render(<AddRemoteHostDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />);
			await userEvent.type(screen.getByLabelText(/address/i), "http://192.0.2.1:3011");
			expect(screen.queryByText(/will connect to/i)).not.toBeInTheDocument();
		});
	});

	// The whole point of the split: a typo and a silent host must not share a
	// sentence, because they send the user to different places.
	it("blames the address, not the network, when the address cannot name a host", async () => {
		render(<AddRemoteHostDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />);
		await fillAndSubmit("not a url");

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/not a valid address/i);
		expect(alert).not.toHaveTextContent(/could not reach/i);
		// Never probed: there was nothing to probe.
		expect(addMock).not.toHaveBeenCalled();
	});

	it("rejects a scheme that is not http or https", async () => {
		render(<AddRemoteHostDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />);
		await fillAndSubmit("ftp://192.0.2.1");
		expect(await screen.findByRole("alert")).toHaveTextContent(/not a valid address/i);
		expect(addMock).not.toHaveBeenCalled();
	});

	it("announces the probe instead of only grinding to a disabled button", async () => {
		let release: (health: string) => void = () => {};
		addMock.mockReturnValue(
			new Promise<string>((resolve) => {
				release = resolve;
			}),
		);
		render(<AddRemoteHostDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />);
		await fillAndSubmit();

		// Conveyed as text in a live region, not by a disabled button alone.
		expect(await screen.findByRole("status")).toHaveTextContent(/connecting/i);
		expect(screen.getByRole("button", { name: /connect/i })).toHaveAttribute("aria-busy", "true");

		release("online");
	});

	it("drops a stale error as soon as the input that caused it changes", async () => {
		addMock.mockResolvedValue("unauthorized");
		render(<AddRemoteHostDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />);
		await fillAndSubmit();
		expect(await screen.findByRole("alert")).toHaveTextContent(/password/i);

		await userEvent.type(screen.getByLabelText(/password/i), "2");
		// A rejection left standing over a corrected password reads as a second one.
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	// Editing a saved host: the reason this exists is a host whose connection
	// password rotated, whose entry had no way to be fixed or thrown away.
	describe("editing a saved host", () => {
		const host = { label: "workbox", url: "http://192.0.2.1:3011" };

		it("prefills the name and address but never the password", async () => {
			render(<AddRemoteHostDialog open host={host} onOpenChange={vi.fn()} onSaved={vi.fn()} />);
			expect(screen.getByLabelText(/name/i)).toHaveValue("workbox");
			expect(screen.getByLabelText(/address/i)).toHaveValue("http://192.0.2.1:3011");
			// The renderer is never handed the password, so there is nothing to show
			// and an empty box has to mean "keep it" — which the hint has to say.
			expect(screen.getByLabelText(/password/i)).toHaveValue("");
			expect(screen.getByText(/leave blank/i)).toBeInTheDocument();
		});

		it("sends no password at all when the field is left blank", async () => {
			const onSaved = vi.fn();
			render(<AddRemoteHostDialog open host={host} onOpenChange={vi.fn()} onSaved={onSaved} />);
			await userEvent.clear(screen.getByLabelText(/name/i));
			await userEvent.type(screen.getByLabelText(/name/i), "the workbox");
			await userEvent.click(screen.getByRole("button", { name: /save/i }));

			expect(updateMock).toHaveBeenCalledWith("http://192.0.2.1:3011", {
				label: "the workbox",
				url: "http://192.0.2.1:3011",
			});
			expect(onSaved).toHaveBeenCalledWith("http://192.0.2.1:3011");
			expect(addMock).not.toHaveBeenCalled();
		});

		it("sends the rotated password when one is typed", async () => {
			render(<AddRemoteHostDialog open host={host} onOpenChange={vi.fn()} onSaved={vi.fn()} />);
			await userEvent.type(screen.getByLabelText(/password/i), "rotated");
			await userEvent.click(screen.getByRole("button", { name: /save/i }));
			expect(updateMock).toHaveBeenCalledWith("http://192.0.2.1:3011", {
				label: "workbox",
				url: "http://192.0.2.1:3011",
				password: "rotated",
			});
		});

		it("targets the old url and normalizes the new one when the address changes", async () => {
			const onSaved = vi.fn();
			render(<AddRemoteHostDialog open host={host} onOpenChange={vi.fn()} onSaved={onSaved} />);
			await userEvent.clear(screen.getByLabelText(/address/i));
			await userEvent.type(screen.getByLabelText(/address/i), "192.0.2.5:3011");
			await userEvent.click(screen.getByRole("button", { name: /save/i }));

			expect(updateMock).toHaveBeenCalledWith("http://192.0.2.1:3011", {
				label: "workbox",
				url: "http://192.0.2.5:3011",
			});
			// The caller needs the url that was written, not the one it passed in.
			expect(onSaved).toHaveBeenCalledWith("http://192.0.2.5:3011");
		});

		it("keeps the same probe-before-save discipline as adding", async () => {
			updateMock.mockResolvedValue("unauthorized");
			const onSaved = vi.fn();
			render(<AddRemoteHostDialog open host={host} onOpenChange={vi.fn()} onSaved={onSaved} />);
			await userEvent.type(screen.getByLabelText(/password/i), "still-wrong");
			await userEvent.click(screen.getByRole("button", { name: /save/i }));

			expect(await screen.findByRole("alert")).toHaveTextContent(/password/i);
			expect(onSaved).not.toHaveBeenCalled();
		});

		it("refuses an address that cannot name a host without probing", async () => {
			render(<AddRemoteHostDialog open host={host} onOpenChange={vi.fn()} onSaved={vi.fn()} />);
			await userEvent.clear(screen.getByLabelText(/address/i));
			await userEvent.type(screen.getByLabelText(/address/i), "not a url");
			await userEvent.click(screen.getByRole("button", { name: /save/i }));
			expect(await screen.findByRole("alert")).toHaveTextContent(/not a valid address/i);
			expect(updateMock).not.toHaveBeenCalled();
		});
	});

	it("rejects a url carrying an embedded credential, as the CLI does", async () => {
		render(<AddRemoteHostDialog open onOpenChange={vi.fn()} onSaved={vi.fn()} />);
		await userEvent.type(screen.getByLabelText(/name/i), "bad");
		await userEvent.type(screen.getByLabelText(/address/i), "http://user:pw@192.0.2.1:3011");
		await userEvent.type(screen.getByLabelText(/password/i), "pw");
		await userEvent.click(screen.getByRole("button", { name: /connect/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/must not carry a username or password/i);
		expect(addMock).not.toHaveBeenCalled();
	});
});
