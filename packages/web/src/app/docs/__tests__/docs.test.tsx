import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// ── Fumadocs mocks ──────────────────────────────────────────────────────────
vi.mock("fumadocs-ui/layouts/docs", () => ({
  DocsLayout: ({
    children,
    sidebar,
    links,
  }: {
    children: React.ReactNode;
    sidebar?: { banner?: React.ReactNode; footer?: React.ReactNode };
    links?: unknown[];
    [key: string]: unknown;
  }) => (
    <div data-testid="docs-layout">
      {sidebar?.banner && (
        <div data-testid="sidebar-banner">{sidebar.banner}</div>
      )}
      {children}
      {links && (
        <div data-testid="sidebar-links" data-count={links.length} />
      )}
    </div>
  ),
}));

vi.mock("fumadocs-ui/provider", () => ({
  RootProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="docs-root-provider">{children}</div>
  ),
}));

vi.mock("fumadocs-ui/page", () => ({
  DocsPage: ({
    children,
    editOnGithub,
    breadcrumb,
    footer,
  }: {
    children: React.ReactNode;
    editOnGithub?: { owner: string; repo: string; path: string };
    breadcrumb?: { enabled: boolean };
    footer?: { enabled: boolean };
    [key: string]: unknown;
  }) => (
    <article data-testid="docs-page">
      {breadcrumb?.enabled && <nav data-testid="breadcrumb" />}
      {children}
      {editOnGithub && (
        <a
          data-testid="edit-on-github"
          href={`https://github.com/${editOnGithub.owner}/${editOnGithub.repo}`}
        />
      )}
      {footer?.enabled && <footer data-testid="page-footer" />}
    </article>
  ),
  DocsBody: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="docs-body">{children}</div>
  ),
  DocsTitle: ({ children }: { children: React.ReactNode }) => (
    <h1 data-testid="docs-title">{children}</h1>
  ),
  DocsDescription: ({ children }: { children: React.ReactNode }) => (
    <p data-testid="docs-description">{children}</p>
  ),
}));

vi.mock("fumadocs-ui/mdx", () => ({
  default: {},
}));

vi.mock("fumadocs-ui/style.css", () => ({}));
vi.mock("../docs.css", () => ({}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

// ── Source mock ─────────────────────────────────────────────────────────────
const mockPage = {
  data: {
    title: "Test Page",
    description: "A test doc page",
    toc: [{ title: "Section 1", url: "#section-1", depth: 2 }],
    body: () => <div data-testid="mdx-body">MDX content</div>,
    full: false,
  },
  file: {
    path: "test-page.mdx",
    flattenedPath: "test-page",
  },
  url: "/docs/test-page",
};

const mockPages = [
  mockPage,
  {
    data: {
      title: "Installation",
      description: "Install guide",
      toc: [],
      body: () => <div>Install content</div>,
      full: false,
    },
    file: { path: "installation.mdx", flattenedPath: "installation" },
    url: "/docs/installation",
  },
  {
    data: {
      title: "CLI Reference",
      description: "CLI docs",
      toc: [],
      body: () => <div>CLI content</div>,
      full: false,
    },
    file: { path: "cli.mdx", flattenedPath: "cli" },
    url: "/docs/cli",
  },
];

vi.mock("@/lib/source", () => ({
  source: {
    pageTree: [{ type: "page", url: "/docs", name: "Home" }],
    getPage: (slug: string[] | undefined) => {
      if (slug && slug.join("/") === "missing") return undefined;
      if (slug && slug.join("/") === "installation")
        return mockPages[1];
      return mockPage;
    },
    getPages: () => mockPages,
    generateParams: () => [
      { slug: ["installation"] },
      { slug: ["getting-started"] },
      { slug: ["cli"] },
    ],
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────
import DocsLayout from "../layout";
import DocsSlugPage, {
  generateStaticParams,
  generateMetadata,
} from "../[[...slug]]/page";
import DocsNotFound from "../not-found";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DocsLayout module", () => {
  it("exports a default function component", () => {
    expect(typeof DocsLayout).toBe("function");
  });
});

describe("DocsSlugPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a found page with title and body", async () => {
    const node = await DocsSlugPage({
      params: Promise.resolve({ slug: ["installation"] }),
    });
    render(node as React.ReactElement);
    expect(screen.getByTestId("docs-page")).toBeInTheDocument();
    expect(screen.getByTestId("docs-title")).toHaveTextContent("Installation");
    expect(screen.getByTestId("docs-description")).toHaveTextContent(
      "Install guide",
    );
  });

  it("renders the /docs root page (no slug)", async () => {
    const node = await DocsSlugPage({
      params: Promise.resolve({ slug: undefined }),
    });
    render(node as React.ReactElement);
    expect(screen.getByTestId("docs-page")).toBeInTheDocument();
  });

  it("calls notFound for an unknown slug", async () => {
    await expect(
      DocsSlugPage({ params: Promise.resolve({ slug: ["missing"] }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("includes edit-on-github link", async () => {
    const node = await DocsSlugPage({
      params: Promise.resolve({ slug: ["installation"] }),
    });
    render(node as React.ReactElement);
    const editLink = screen.getByTestId("edit-on-github");
    expect(editLink).toBeInTheDocument();
    expect(editLink).toHaveAttribute(
      "href",
      "https://github.com/ComposioHQ/agent-orchestrator",
    );
  });

  it("renders breadcrumbs", async () => {
    const node = await DocsSlugPage({
      params: Promise.resolve({ slug: ["installation"] }),
    });
    render(node as React.ReactElement);
    expect(screen.getByTestId("breadcrumb")).toBeInTheDocument();
  });

  it("renders footer navigation", async () => {
    const node = await DocsSlugPage({
      params: Promise.resolve({ slug: ["installation"] }),
    });
    render(node as React.ReactElement);
    expect(screen.getByTestId("page-footer")).toBeInTheDocument();
  });

  it("passes MDX components to body", async () => {
    const node = await DocsSlugPage({
      params: Promise.resolve({ slug: ["installation"] }),
    });
    render(node as React.ReactElement);
    expect(screen.getByTestId("docs-body")).toBeInTheDocument();
  });
});

describe("generateStaticParams", () => {
  it("returns a list of slug arrays", async () => {
    const params = await generateStaticParams();
    expect(params).toEqual([
      { slug: ["installation"] },
      { slug: ["getting-started"] },
      { slug: ["cli"] },
    ]);
  });

  it("returns non-empty params list", async () => {
    const params = await generateStaticParams();
    expect(params.length).toBeGreaterThan(0);
  });
});

describe("generateMetadata", () => {
  it("returns title and description for a found page", async () => {
    const meta = await generateMetadata({
      params: Promise.resolve({ slug: ["installation"] }),
    });
    expect(meta).toMatchObject({
      title: "Installation",
      description: "Install guide",
    });
  });

  it("includes openGraph metadata", async () => {
    const meta = await generateMetadata({
      params: Promise.resolve({ slug: ["installation"] }),
    });
    expect(meta.openGraph).toMatchObject({
      title: "Installation",
      description: "Install guide",
    });
  });

  it("throws for an unknown slug", async () => {
    await expect(
      generateMetadata({ params: Promise.resolve({ slug: ["missing"] }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("DocsNotFound", () => {
  it("renders the 404 page with browse docs and home links", () => {
    render(<DocsNotFound />);
    expect(screen.getByText("404")).toBeInTheDocument();
    const browseLink = screen.getByText("Browse docs");
    expect(browseLink).toHaveAttribute("href", "/docs");
    const homeLink = screen.getByText("Home");
    expect(homeLink).toHaveAttribute("href", "/");
  });

  it("displays an explanatory message", () => {
    render(<DocsNotFound />);
    expect(
      screen.getByText(/this docs page doesn't exist/i),
    ).toBeInTheDocument();
  });
});
