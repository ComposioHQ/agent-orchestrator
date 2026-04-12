import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect } from "vitest";

expect.extend(matchers);
afterEach(() => {
  cleanup();
});

// jsdom does not implement window.matchMedia. Provide a minimal stub so
// components that call useMediaQuery (e.g. Dashboard) work in unit tests.
// The stub always returns `false` (non-matching), which keeps tests in the
// desktop/non-mobile rendering path and avoids spurious re-renders.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

class MockEventSource {
  url: string;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  close() {
    this.readyState = 2;
  }

  addEventListener() {}

  removeEventListener() {}
}

Object.defineProperty(globalThis, "EventSource", {
  writable: true,
  value: MockEventSource,
});
