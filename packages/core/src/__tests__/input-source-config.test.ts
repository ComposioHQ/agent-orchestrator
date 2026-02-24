import { describe, it, expect } from "vitest";
import { validateConfig } from "../config.js";

describe("InputSource config validation", () => {
  it("accepts project with defaultInputSource", () => {
    const config = {
      projects: {
        test: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          defaultInputSource: "linear",
        },
      },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("accepts project with inputSources", () => {
    const config = {
      projects: {
        test: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          inputSources: {
            linear: {
              type: "linear",
              token: "lin_api_xxx",
            },
          },
        },
      },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("accepts generic input source with url and auth", () => {
    const config = {
      projects: {
        test: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          inputSources: {
            notion: {
              type: "generic",
              url: "http://localhost:8080/mcp",
              auth: { type: "bearer", token: "ntn_xxx" },
            },
          },
        },
      },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("rejects invalid input source type", () => {
    const config = {
      projects: {
        test: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          inputSources: {
            bad: {
              type: "invalid-type",
            },
          },
        },
      },
    };
    expect(() => validateConfig(config)).toThrow();
  });

  it("rejects invalid URL in input source", () => {
    const config = {
      projects: {
        test: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          inputSources: {
            notion: {
              type: "generic",
              url: "not-a-url",
            },
          },
        },
      },
    };
    expect(() => validateConfig(config)).toThrow();
  });
});
