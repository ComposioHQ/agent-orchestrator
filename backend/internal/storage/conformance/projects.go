package conformance

import (
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// registeredAt is a fixed instant with microsecond precision. PostgreSQL
// timestamps are microsecond-resolution, so a nanosecond in a fixture would
// fail on one engine and pass on the other for a reason that has nothing to do
// with the behaviour under test.
var registeredAt = time.Date(2026, 3, 14, 15, 9, 26, 535000000, time.UTC)

func runProjects(t *testing.T, newHarness Factory) {
	t.Helper()

	t.Run("upsert then read back round-trips every field", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		want := domain.ProjectRecord{
			ID:            "acme",
			Path:          "/repos/acme",
			RepoOriginURL: "https://github.com/acme/acme.git",
			DisplayName:   "Acme",
			RegisteredAt:  registeredAt,
			Kind:          domain.ProjectKindSingleRepo,
			Config: domain.ProjectConfig{
				DefaultBranch: "main",
				SessionPrefix: "acme",
				Env:           map[string]string{"FOO": "bar"},
				Symlinks:      []string{".env"},
				PostCreate:    []string{"npm ci"},
				AgentRules:    "be surgical",
				AutoReview:    true,
			},
		}
		if err := h.Projects.UpsertProject(ctx, want); err != nil {
			t.Fatalf("UpsertProject: %v", err)
		}
		got, ok, err := h.Projects.GetProject(ctx, "acme")
		if err != nil || !ok {
			t.Fatalf("GetProject = %#v, %v, %v", got, ok, err)
		}
		assertProjectEqual(t, got, want)
	})

	t.Run("upsert replaces an existing row rather than duplicating it", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		base := newProject("acme", "/repos/acme")
		mustUpsertProject(t, h, base)
		renamed := base
		renamed.DisplayName = "Acme Renamed"
		renamed.RepoOriginURL = "https://github.com/acme/renamed.git"
		mustUpsertProject(t, h, renamed)

		list, err := h.Projects.ListProjects(ctx)
		if err != nil {
			t.Fatalf("ListProjects: %v", err)
		}
		if len(list) != 1 {
			t.Fatalf("ListProjects returned %d rows, want 1: %#v", len(list), list)
		}
		if list[0].DisplayName != "Acme Renamed" || list[0].RepoOriginURL != renamed.RepoOriginURL {
			t.Fatalf("upsert did not replace: %#v", list[0])
		}
	})

	t.Run("an unset config round-trips as a zero config", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		got, ok, err := h.Projects.GetProject(ctx, "acme")
		if err != nil || !ok {
			t.Fatalf("GetProject = %v, %v", ok, err)
		}
		if !got.Config.IsZero() {
			t.Fatalf("unset config read back as %#v, want zero", got.Config)
		}
	})

	t.Run("missing lookups report absence without an error", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		if got, ok, err := h.Projects.GetProject(ctx, "nope"); ok || err != nil {
			t.Fatalf("GetProject(missing) = %#v, %v, %v", got, ok, err)
		}
		if got, ok, err := h.Projects.FindProjectByPath(ctx, "/nowhere"); ok || err != nil {
			t.Fatalf("FindProjectByPath(missing) = %#v, %v, %v", got, ok, err)
		}
	})

	t.Run("FindProjectByPath ignores archived rows so a path can be re-registered", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		got, ok, err := h.Projects.FindProjectByPath(ctx, "/repos/acme")
		if err != nil || !ok || got.ID != "acme" {
			t.Fatalf("FindProjectByPath = %#v, %v, %v", got, ok, err)
		}
		if _, err := h.Projects.ArchiveProject(ctx, "acme", registeredAt); err != nil {
			t.Fatalf("ArchiveProject: %v", err)
		}
		if got, ok, err := h.Projects.FindProjectByPath(ctx, "/repos/acme"); ok || err != nil {
			t.Fatalf("FindProjectByPath(archived) = %#v, %v, %v, want absent", got, ok, err)
		}
		if got, ok, err := h.Projects.GetProject(ctx, "acme"); !ok || err != nil || got.ArchivedAt.IsZero() {
			t.Fatalf("GetProject(archived) = %#v, %v, %v, want the archived row", got, ok, err)
		}
	})

	t.Run("ListProjects hides archived rows and orders by id", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		for _, id := range []string{"charlie", "alpha", "bravo"} {
			mustUpsertProject(t, h, newProject(id, "/repos/"+id))
		}
		archived, err := h.Projects.ArchiveProject(ctx, "bravo", registeredAt)
		if err != nil || !archived {
			t.Fatalf("ArchiveProject = %v, %v", archived, err)
		}
		list, err := h.Projects.ListProjects(ctx)
		if err != nil {
			t.Fatalf("ListProjects: %v", err)
		}
		ids := projectIDs(list)
		if len(ids) != 2 || ids[0] != "alpha" || ids[1] != "charlie" {
			t.Fatalf("ListProjects ids = %v, want [alpha charlie]", ids)
		}
	})

	t.Run("CountProjectsIncludingArchived counts archived rows too", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		if n, err := h.Projects.CountProjectsIncludingArchived(ctx); err != nil || n != 0 {
			t.Fatalf("count on empty store = %d, %v", n, err)
		}
		mustUpsertProject(t, h, newProject("alpha", "/repos/alpha"))
		mustUpsertProject(t, h, newProject("bravo", "/repos/bravo"))
		if _, err := h.Projects.ArchiveProject(ctx, "bravo", registeredAt); err != nil {
			t.Fatalf("ArchiveProject: %v", err)
		}
		n, err := h.Projects.CountProjectsIncludingArchived(ctx)
		if err != nil || n != 2 {
			t.Fatalf("CountProjectsIncludingArchived = %d, %v, want 2", n, err)
		}
	})

	t.Run("ArchiveProject reports whether it changed anything", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		if ok, err := h.Projects.ArchiveProject(ctx, "acme", registeredAt); err != nil || !ok {
			t.Fatalf("first ArchiveProject = %v, %v", ok, err)
		}
		if ok, err := h.Projects.ArchiveProject(ctx, "acme", registeredAt); err != nil || ok {
			t.Fatalf("re-archive = %v, %v, want false, nil", ok, err)
		}
		if ok, err := h.Projects.ArchiveProject(ctx, "ghost", registeredAt); err != nil || ok {
			t.Fatalf("archive missing = %v, %v, want false, nil", ok, err)
		}
	})

	t.Run("UpdateProjectSettings refuses missing and archived projects", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		cfg := domain.ProjectConfig{DefaultBranch: "trunk", Env: map[string]string{"A": "1"}}
		ok, err := h.Projects.UpdateProjectSettings(ctx, "acme", "Acme Inc", cfg)
		if err != nil || !ok {
			t.Fatalf("UpdateProjectSettings = %v, %v", ok, err)
		}
		got, found, err := h.Projects.GetProject(ctx, "acme")
		if err != nil || !found {
			t.Fatalf("GetProject = %v, %v", found, err)
		}
		if got.DisplayName != "Acme Inc" || got.Config.DefaultBranch != "trunk" || got.Config.Env["A"] != "1" {
			t.Fatalf("settings not applied: %#v", got)
		}

		if ok, err := h.Projects.UpdateProjectSettings(ctx, "ghost", "Ghost", cfg); err != nil || ok {
			t.Fatalf("update missing = %v, %v, want false, nil", ok, err)
		}
		if _, err := h.Projects.ArchiveProject(ctx, "acme", registeredAt); err != nil {
			t.Fatalf("ArchiveProject: %v", err)
		}
		if ok, err := h.Projects.UpdateProjectSettings(ctx, "acme", "Nope", cfg); err != nil || ok {
			t.Fatalf("update archived = %v, %v, want false, nil", ok, err)
		}
	})

	t.Run("workspace children are replaced wholesale in one transaction", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		parent := newProject("mono", "/repos/mono")
		parent.Kind = domain.ProjectKindWorkspace
		first := []domain.WorkspaceRepoRecord{
			newWorkspaceRepo("mono", "web", "packages/web"),
			newWorkspaceRepo("mono", "api", "packages/api"),
		}
		if err := h.Projects.UpsertWorkspaceProject(ctx, parent, first); err != nil {
			t.Fatalf("UpsertWorkspaceProject: %v", err)
		}
		repos, err := h.Projects.ListWorkspaceRepos(ctx, "mono")
		if err != nil {
			t.Fatalf("ListWorkspaceRepos: %v", err)
		}
		if names := repoNames(repos); len(names) != 2 || names[0] != "api" || names[1] != "web" {
			t.Fatalf("repo names = %v, want [api web]", names)
		}

		second := []domain.WorkspaceRepoRecord{newWorkspaceRepo("mono", "web", "packages/web-v2")}
		if err := h.Projects.UpsertWorkspaceProject(ctx, parent, second); err != nil {
			t.Fatalf("second UpsertWorkspaceProject: %v", err)
		}
		repos, err = h.Projects.ListWorkspaceRepos(ctx, "mono")
		if err != nil {
			t.Fatalf("ListWorkspaceRepos: %v", err)
		}
		if len(repos) != 1 || repos[0].Name != "web" || repos[0].RelativePath != "packages/web-v2" {
			t.Fatalf("children not replaced: %#v", repos)
		}
	})

	t.Run("workspace replacement rolls back as one transaction", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		parent := newProject("mono", "/repos/mono")
		parent.Kind = domain.ProjectKindWorkspace
		original := []domain.WorkspaceRepoRecord{newWorkspaceRepo("mono", "api", "packages/api")}
		if err := h.Projects.UpsertWorkspaceProject(ctx, parent, original); err != nil {
			t.Fatalf("seed workspace: %v", err)
		}

		invalid := parent
		invalid.Kind = domain.ProjectKind("not-a-project-kind")
		err := h.Projects.UpsertWorkspaceProject(ctx, invalid, []domain.WorkspaceRepoRecord{
			newWorkspaceRepo("mono", "web", "packages/web"),
		})
		if err == nil {
			t.Fatal("invalid workspace replacement succeeded")
		}
		repos, err := h.Projects.ListWorkspaceRepos(ctx, "mono")
		if err != nil {
			t.Fatalf("ListWorkspaceRepos after rollback: %v", err)
		}
		if len(repos) != 1 || repos[0].Name != "api" {
			t.Fatalf("failed replacement changed children: %#v", repos)
		}
	})

	t.Run("workspace children round-trip every field", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		parent := newProject("mono", "/repos/mono")
		parent.Kind = domain.ProjectKindWorkspace
		want := domain.WorkspaceRepoRecord{
			ProjectID:     "mono",
			Name:          "api",
			RelativePath:  "packages/api",
			RepoOriginURL: "https://github.com/acme/api.git",
			DefaultBranch: "develop",
			RegisteredAt:  registeredAt,
			GitStatus:     domain.GitStatusNeedsInit,
		}
		if err := h.Projects.UpsertWorkspaceProject(ctx, parent, []domain.WorkspaceRepoRecord{want}); err != nil {
			t.Fatalf("UpsertWorkspaceProject: %v", err)
		}
		repos, err := h.Projects.ListWorkspaceRepos(ctx, "mono")
		if err != nil || len(repos) != 1 {
			t.Fatalf("ListWorkspaceRepos = %#v, %v", repos, err)
		}
		got := repos[0]
		if got.ProjectID != want.ProjectID || got.Name != want.Name ||
			got.RelativePath != want.RelativePath || got.RepoOriginURL != want.RepoOriginURL ||
			got.DefaultBranch != want.DefaultBranch || got.GitStatus != want.GitStatus {
			t.Fatalf("workspace repo = %#v, want %#v", got, want)
		}
		if !got.RegisteredAt.Equal(want.RegisteredAt) {
			t.Fatalf("RegisteredAt = %v, want %v", got.RegisteredAt, want.RegisteredAt)
		}
	})

	t.Run("ListWorkspaceRepos on a non-workspace project is empty, not an error", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		repos, err := h.Projects.ListWorkspaceRepos(ctx, "acme")
		if err != nil {
			t.Fatalf("ListWorkspaceRepos: %v", err)
		}
		if len(repos) != 0 {
			t.Fatalf("repos = %#v, want none", repos)
		}
	})
}

func newProject(id, path string) domain.ProjectRecord {
	return domain.ProjectRecord{
		ID:            id,
		Path:          path,
		RepoOriginURL: "https://github.com/acme/" + id + ".git",
		DisplayName:   id,
		RegisteredAt:  registeredAt,
		Kind:          domain.ProjectKindSingleRepo,
	}
}

func newWorkspaceRepo(projectID domain.ProjectID, name, relativePath string) domain.WorkspaceRepoRecord {
	return domain.WorkspaceRepoRecord{
		ProjectID:     projectID,
		Name:          name,
		RelativePath:  relativePath,
		RepoOriginURL: "https://github.com/acme/" + name + ".git",
		DefaultBranch: "main",
		RegisteredAt:  registeredAt,
		GitStatus:     domain.GitStatusReady,
	}
}

func mustUpsertProject(t *testing.T, h Harness, rec domain.ProjectRecord) {
	t.Helper()
	if err := h.Projects.UpsertProject(h.ctx(), rec); err != nil {
		t.Fatalf("UpsertProject(%s): %v", rec.ID, err)
	}
}

func assertProjectEqual(t *testing.T, got, want domain.ProjectRecord) {
	t.Helper()
	if got.ID != want.ID || got.Path != want.Path || got.RepoOriginURL != want.RepoOriginURL ||
		got.DisplayName != want.DisplayName || got.Kind.WithDefault() != want.Kind.WithDefault() {
		t.Fatalf("project identity = %#v, want %#v", got, want)
	}
	if !got.RegisteredAt.Equal(want.RegisteredAt) {
		t.Fatalf("RegisteredAt = %v, want %v", got.RegisteredAt, want.RegisteredAt)
	}
	if !got.ArchivedAt.Equal(want.ArchivedAt) {
		t.Fatalf("ArchivedAt = %v, want %v", got.ArchivedAt, want.ArchivedAt)
	}
	assertProjectConfigEqual(t, got.Config, want.Config)
}

func assertProjectConfigEqual(t *testing.T, got, want domain.ProjectConfig) {
	t.Helper()
	if got.DefaultBranch != want.DefaultBranch || got.SessionPrefix != want.SessionPrefix ||
		got.AgentRules != want.AgentRules || got.AutoReview != want.AutoReview {
		t.Fatalf("config scalars = %#v, want %#v", got, want)
	}
	if len(got.Env) != len(want.Env) {
		t.Fatalf("config env = %#v, want %#v", got.Env, want.Env)
	}
	for k, v := range want.Env {
		if got.Env[k] != v {
			t.Fatalf("config env[%s] = %q, want %q", k, got.Env[k], v)
		}
	}
	if len(got.Symlinks) != len(want.Symlinks) || len(got.PostCreate) != len(want.PostCreate) {
		t.Fatalf("config lists = %#v, want %#v", got, want)
	}
}

func projectIDs(rows []domain.ProjectRecord) []string {
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.ID)
	}
	return out
}

func repoNames(rows []domain.WorkspaceRepoRecord) []string {
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.Name)
	}
	return out
}
