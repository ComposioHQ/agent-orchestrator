package portscan

import (
	"reflect"
	"testing"
)

// procNetTCPSample is a real /proc/net/tcp table: a header row, two listening
// sockets (st 0A) and one established connection that must not be reported.
const procNetTCPSample = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 3600007F:0035 00000000:0000 0A 00000000:00000000 00:00000000 00000000   974        0 1706 1 00000000a430142f 100 0 0 10 5
   1: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 30594 1 000000001064da26 100 0 0 10 0
   2: 0100007F:1435 0100007F:C1A2 01 00000000:00000000 00:00000000 00000000  1000        0 30777 1 00000000b282d564 100 0 0 10 0
`

// procNetTCP6Sample is the IPv6 table for the same machine. Its address column
// is four times wider, which must not shift the st or inode columns.
const procNetTCP6Sample = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 30595 1 00000000cbaa7f01 100 0 0 10 5
`

func TestParseProcNetTCPKeepsOnlyListeningRows(t *testing.T) {
	got := parseProcNetTCP(procNetTCPSample)
	want := map[uint64]int{1706: 53, 30594: 5173}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseProcNetTCP = %#v, want %#v", got, want)
	}
}

func TestParseProcNetTCP6ColumnsAreNotShifted(t *testing.T) {
	got := parseProcNetTCP(procNetTCP6Sample)
	want := map[uint64]int{30595: 5173}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseProcNetTCP = %#v, want %#v", got, want)
	}
}

func TestParseProcNetTCPTolerance(t *testing.T) {
	for name, table := range map[string]string{
		"empty":         "",
		"header only":   "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n",
		"short row":     "   0: 0100007F:1435 00000000:0000 0A\n",
		"bad port":      "   0: 0100007F:ZZZZ 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 30594 1\n",
		"port zero":     "   0: 0100007F:0000 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 30594 1\n",
		"bad inode":     "   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 nope 1\n",
		"inode zero":    "   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 0 1\n",
		"no port colon": "   0: 0100007F 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 30594 1\n",
	} {
		t.Run(name, func(t *testing.T) {
			if got := parseProcNetTCP(table); len(got) != 0 {
				t.Fatalf("parseProcNetTCP = %#v, want empty", got)
			}
		})
	}
}

func TestParseSocketLink(t *testing.T) {
	for name, tc := range map[string]struct {
		target string
		inode  uint64
		ok     bool
	}{
		"socket":          {target: "socket:[30594]", inode: 30594, ok: true},
		"regular file":    {target: "/home/dev/app/log.txt"},
		"pipe":            {target: "pipe:[30594]"},
		"anon inode":      {target: "anon_inode:[eventpoll]"},
		"missing bracket": {target: "socket:[30594"},
		"not a number":    {target: "socket:[abc]"},
		"zero inode":      {target: "socket:[0]"},
		"empty":           {target: ""},
	} {
		t.Run(name, func(t *testing.T) {
			inode, ok := parseSocketLink(tc.target)
			if ok != tc.ok || inode != tc.inode {
				t.Fatalf("parseSocketLink(%q) = %d, %t; want %d, %t", tc.target, inode, ok, tc.inode, tc.ok)
			}
		})
	}
}

// lsofSample is lsof -F pn output for two processes. process 812 holds the same
// server on IPv4 and IPv6; 900 is a second server; 4242 was never asked for and
// must be dropped even though lsof reported it.
const lsofSample = `p812
n127.0.0.1:5173
n[::1]:5173
p900
n*:8080
p4242
n127.0.0.1:9999
`

func TestParseLsofAttributesPortsToTheirProcess(t *testing.T) {
	got := parseLsof(lsofSample, map[int]bool{812: true, 900: true})
	want := []boundPort{
		{PID: 812, Port: 5173},
		{PID: 812, Port: 5173},
		{PID: 900, Port: 8080},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseLsof = %#v, want %#v", got, want)
	}
}

func TestParseLsofIgnoresUnrelatedLines(t *testing.T) {
	// lsof writes its warnings to stderr, but a build that mixes them into
	// stdout must not derail the field parse either.
	out := "lsof: WARNING: can't stat() overlay file system /var/lib/docker\np812\nf23\nn127.0.0.1:5173\n"
	got := parseLsof(out, map[int]bool{812: true})
	want := []boundPort{{PID: 812, Port: 5173}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseLsof = %#v, want %#v", got, want)
	}
}

func TestParseListenPort(t *testing.T) {
	for name, tc := range map[string]struct {
		name string
		port int
		ok   bool
	}{
		"ipv4":            {name: "127.0.0.1:5173", port: 5173, ok: true},
		"ipv6":            {name: "[::1]:5173", port: 5173, ok: true},
		"wildcard":        {name: "*:8080", port: 8080, ok: true},
		"trailing state":  {name: "*:8080 (LISTEN)", port: 8080, ok: true},
		"named port":      {name: "127.0.0.1:http"},
		"no colon":        {name: "127.0.0.1"},
		"port zero":       {name: "127.0.0.1:0"},
		"port over range": {name: "127.0.0.1:70000"},
	} {
		t.Run(name, func(t *testing.T) {
			port, ok := parseListenPort(tc.name)
			if ok != tc.ok || port != tc.port {
				t.Fatalf("parseListenPort(%q) = %d, %t; want %d, %t", tc.name, port, ok, tc.port, tc.ok)
			}
		})
	}
}

func TestLsofArgsRestrictsToRequestedPIDs(t *testing.T) {
	got := lsofArgs([]int{900, 812})
	want := []string{"-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", "812,900", "-F", "pn"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("lsofArgs = %#v, want %#v", got, want)
	}
}

func TestDedupeCollapsesDualStackAndSorts(t *testing.T) {
	got := dedupe([]boundPort{
		{PID: 812, Port: 5173},
		{PID: 900, Port: 8080},
		{PID: 812, Port: 5173},
		{PID: 700, Port: 8080},
	})
	want := []boundPort{
		{PID: 812, Port: 5173},
		{PID: 700, Port: 8080},
		{PID: 900, Port: 8080},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("dedupe = %#v, want %#v", got, want)
	}
}

func TestOwnedListenersWithoutUsablePIDsScansNothing(t *testing.T) {
	if got := ownedListeners(t.Context(), nil); got != nil {
		t.Fatalf("ownedListeners(nil) = %#v, want nil", got)
	}
	if got := ownedListeners(t.Context(), []int{0, -1}); got != nil {
		t.Fatalf("ownedListeners(invalid) = %#v, want nil", got)
	}
}
