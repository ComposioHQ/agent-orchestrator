import { describe, it, expect, vi } from "vitest";
import { sendResizeMessage } from "@/components/TerminalResize";

describe("sendResizeMessage", () => {
  it("sends a JSON resize message when WebSocket is open", () => {
    const send = vi.fn();
    const mockWs = {
      readyState: WebSocket.OPEN,
      send,
    } as unknown as WebSocket;

    sendResizeMessage(mockWs, 120, 40);

    expect(send).toHaveBeenCalledOnce();
    const parsed = JSON.parse(send.mock.calls[0][0] as string);
    expect(parsed).toEqual({ type: "resize", cols: 120, rows: 40 });
  });

  it("does not send when WebSocket is null", () => {
    // Should not throw
    sendResizeMessage(null, 80, 24);
  });

  it("does not send when WebSocket is not open", () => {
    const send = vi.fn();
    const mockWs = {
      readyState: WebSocket.CONNECTING,
      send,
    } as unknown as WebSocket;

    sendResizeMessage(mockWs, 80, 24);

    expect(send).not.toHaveBeenCalled();
  });

  it("does not send when WebSocket is closing", () => {
    const send = vi.fn();
    const mockWs = {
      readyState: WebSocket.CLOSING,
      send,
    } as unknown as WebSocket;

    sendResizeMessage(mockWs, 80, 24);

    expect(send).not.toHaveBeenCalled();
  });

  it("does not send when WebSocket is closed", () => {
    const send = vi.fn();
    const mockWs = {
      readyState: WebSocket.CLOSED,
      send,
    } as unknown as WebSocket;

    sendResizeMessage(mockWs, 80, 24);

    expect(send).not.toHaveBeenCalled();
  });

  it("sends correct column and row values", () => {
    const send = vi.fn();
    const mockWs = {
      readyState: WebSocket.OPEN,
      send,
    } as unknown as WebSocket;

    sendResizeMessage(mockWs, 200, 50);

    const parsed = JSON.parse(send.mock.calls[0][0] as string);
    expect(parsed.cols).toBe(200);
    expect(parsed.rows).toBe(50);
    expect(parsed.type).toBe("resize");
  });
});
