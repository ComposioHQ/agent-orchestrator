import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverMock;
Element.prototype.scrollIntoView ??= () => {};
window.scrollTo ??= () => {};

afterEach(cleanup);
