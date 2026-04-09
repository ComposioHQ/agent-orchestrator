import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };

describe("cli package manifest", () => {
  it("includes built-in GitLab tracker and SCM plugins", () => {
    expect(packageJson.dependencies).toMatchObject({
      "@composio/ao-plugin-tracker-gitlab": "workspace:*",
      "@composio/ao-plugin-scm-gitlab": "workspace:*",
    });
  });
});
