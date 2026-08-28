package portscan

import (
	"reflect"
	"testing"
)

// devServerTree is a session shell that ran `bun run dev`, which spawned turbo,
// which spawned two Next.js servers. All the ancestors hold each listening
// descriptor because a child inherits it.
const devServerTree = `100 1 /bin/zsh -i
101 100 bun run dev
102 101 turbo run dev
103 102 /usr/bin/node /work/node_modules/next/dist/bin/next dev --port 3000
104 102 /usr/bin/node /work/node_modules/next/dist/bin/next dev --port 3001
900 1 /usr/bin/unrelated-daemon
`

func table(t *testing.T) []process {
	t.Helper()
	procs := parseProcessTable(devServerTree)
	if len(procs) != 6 {
		t.Fatalf("parseProcessTable returned %d rows, want 6", len(procs))
	}
	return procs
}

func TestParseProcessTableSkipsUnparseableRows(t *testing.T) {
	procs := parseProcessTable("100 1 /bin/zsh\nnope 1 /bin/sh\n101 bad /bin/sh\n102\n103 100 vite\n")
	want := []process{
		{PID: 100, PPID: 1, Command: "/bin/zsh"},
		{PID: 103, PPID: 100, Command: "vite"},
	}
	if !reflect.DeepEqual(procs, want) {
		t.Fatalf("parseProcessTable = %#v, want %#v", procs, want)
	}
}

func TestDescendantsAreScopedToTheRoot(t *testing.T) {
	tree := descendants(table(t), 100)
	for _, pid := range []int{100, 101, 102, 103, 104} {
		if !tree[pid] {
			t.Fatalf("descendants missing pid %d", pid)
		}
	}
	// The whole point of the feature: another app on the machine is not ours.
	if tree[900] {
		t.Fatal("descendants adopted an unrelated process")
	}
}

func TestAttributeCreditsTheDeepestProcessHoldingAPort(t *testing.T) {
	got := attribute(table(t), 100, []boundPort{
		{PID: 100, Port: 3000},
		{PID: 101, Port: 3000},
		{PID: 103, Port: 3000},
		{PID: 102, Port: 3000},
	})
	want := []Detected{{Port: 3000, PID: 103, Command: "next"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("attribute = %#v, want %#v", got, want)
	}
}

func TestAttributeSortsByPort(t *testing.T) {
	got := attribute(table(t), 100, []boundPort{
		{PID: 104, Port: 3001},
		{PID: 103, Port: 3000},
	})
	want := []Detected{
		{Port: 3000, PID: 103, Command: "next"},
		{Port: 3001, PID: 104, Command: "next"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("attribute = %#v, want %#v", got, want)
	}
}

// A pid whose ancestry does not reach the root (its parent was reaped between
// the process snapshot and the socket scan) must never outrank a known
// descendant.
func TestAttributeIgnoresUnreachableAncestry(t *testing.T) {
	got := attribute(table(t), 100, []boundPort{
		{PID: 103, Port: 3000},
		{PID: 900, Port: 3000},
	})
	want := []Detected{{Port: 3000, PID: 103, Command: "next"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("attribute = %#v, want %#v", got, want)
	}
}

func TestAttributeCapsTheSuggestionList(t *testing.T) {
	listeners := make([]boundPort, 0, maxDetected+5)
	for i := range maxDetected + 5 {
		listeners = append(listeners, boundPort{PID: 103, Port: 3000 + i})
	}
	if got := attribute(table(t), 100, listeners); len(got) != maxDetected {
		t.Fatalf("attribute returned %d entries, want %d", len(got), maxDetected)
	}
}

func TestAttributeWithoutListenersIsEmpty(t *testing.T) {
	if got := attribute(table(t), 100, nil); got != nil {
		t.Fatalf("attribute = %#v, want nil", got)
	}
}

func TestCommandLabel(t *testing.T) {
	for name, tc := range map[string]struct{ command, want string }{
		// A bare runtime name says nothing about what is being served, so the
		// first real argument is the informative half.
		"node script":      {command: "/usr/bin/node /work/node_modules/next/dist/bin/next dev", want: "next"},
		"bun script":       {command: "bun run dev", want: "run"},
		"python module":    {command: "python3 -m http.server 8000", want: "http.server"},
		"runtime only":     {command: "/usr/bin/node", want: "node"},
		"runtime flagonly": {command: "node --inspect", want: "node"},
		"named binary":     {command: "/usr/local/bin/next-server --port 3000", want: "next-server"},
		"bare name":        {command: "vite", want: "vite"},
		"js entry point":   {command: "node /work/node_modules/.bin/vite.js --host", want: "vite"},
		"empty":            {command: "", want: ""},
		"whitespace":       {command: "   ", want: ""},
	} {
		t.Run(name, func(t *testing.T) {
			if got := commandLabel(tc.command); got != tc.want {
				t.Fatalf("commandLabel(%q) = %q, want %q", tc.command, got, tc.want)
			}
		})
	}
}

func TestUnderWorkspace(t *testing.T) {
	for name, tc := range map[string]struct {
		cwd, workspace string
		want           bool
	}{
		"exact match":     {cwd: "/w/app", workspace: "/w/app", want: true},
		"nested":          {cwd: "/w/app/packages/web", workspace: "/w/app", want: true},
		"trailing slash":  {cwd: "/w/app/src", workspace: "/w/app/", want: true},
		"sibling prefix":  {cwd: "/w/app-old", workspace: "/w/app"},
		"parent":          {cwd: "/w", workspace: "/w/app"},
		"unrelated":       {cwd: "/opt/other", workspace: "/w/app"},
		"empty cwd":       {workspace: "/w/app"},
		"empty workspace": {cwd: "/w/app"},
		"both empty":      {},
	} {
		t.Run(name, func(t *testing.T) {
			if got := underWorkspace(tc.cwd, tc.workspace); got != tc.want {
				t.Fatalf("underWorkspace(%q, %q) = %t, want %t", tc.cwd, tc.workspace, got, tc.want)
			}
		})
	}
}
