//go:build windows

// spawn_windows.go - real detached pty-host spawner for Windows using
// DETACHED_PROCESS so the host survives daemon exit. Deliberately without
// CREATE_NEW_PROCESS_GROUP — see ptyHostSysProcAttr.
package conpty

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/windows"
)

// readyRE matches the "READY:<pid> <port>" line printed by RunHost.
var readyRE = regexp.MustCompile(`READY:(\d+) (\d+)`)

// ptyHostSysProcAttr returns the Windows process-creation attributes for the
// detached pty-host.
//
// DETACHED_PROCESS keeps the child console-less so it survives the parent's
// console closing; HideWindow suppresses the console flash.
//
// CREATE_NEW_PROCESS_GROUP must NOT be set here, even though it would
// "insulate" the host from Ctrl+C sent to the parent. pty-host is the process
// that calls CreatePseudoConsole, and conhost can only deliver a synthesized
// CTRL_C_EVENT (from a 0x03 byte written to the ConPTY input pipe) to
// processes in its own console process group — isolating pty-host's group
// severs that delivery, so Ctrl+C in AO terminals never interrupts foreground
// processes (ping -t keeps running). DETACHED_PROCESS already provides the
// insulation: a process attached to no console receives no console control
// events. See https://learn.microsoft.com/en-us/answers/questions/5832200/
func ptyHostSysProcAttr() *windows.SysProcAttr {
	return &windows.SysProcAttr{
		CreationFlags: windows.DETACHED_PROCESS,
		HideWindow:    true,
	}
}

const spawnReadyTimeout = 10 * time.Second

// maxCapturedStderr bounds how much pty-host stderr we retain for diagnostics.
const maxCapturedStderr = 8192

// boundedBuffer is a thread-safe io.Writer that retains up to max bytes of what
// is written and discards the rest. It always consumes its input (never blocks
// or errors), so it is a safe stderr sink for the detached pty-host — matching
// the previous io.Discard behavior while keeping a capped copy so a startup
// failure (e.g. newConPTY) can be reported instead of only "exited without
// printing READY".
type boundedBuffer struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if room := b.max - len(b.buf); room > 0 {
		if len(p) < room {
			room = len(p)
		}
		b.buf = append(b.buf, p[:room]...)
	}
	return len(p), nil
}

func (b *boundedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.buf)
}

// defaultSpawnHost resolves the current executable, builds the pty-host argv,
// and spawns it detached on Windows. It reads stdout for "READY:<pid> <port>"
// with a 10s timeout, then unrefs (detaches) the child. Returns the loopback
// address and the pty-host OS PID.
func defaultSpawnHost(ctx context.Context, sessionID, cwd string, argv []string, env map[string]string) (string, int, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", 0, fmt.Errorf("conpty spawn: resolve executable: %w", err)
	}

	// Translate a leading `env NAME=VALUE ...` prefix into real child env vars.
	// Windows has no `env` binary and the pty-host execs argv[0] directly, so an
	// adapter that emits `env KEY=value <bin>` (e.g. opencode, to set
	// OPENCODE_CONFIG) would otherwise fail with "env: executable file not
	// found". The assignments are added to the pty-host environment below, which
	// the ConPTY child inherits (host_conpty_windows.go passes os.Environ()).
	envAssignments, argv := stripEnvAssignments(argv)

	// Build: <exe> pty-host <sessionID> <cwd> <shellCmd> <shellArgs...>
	args := append([]string{"pty-host", sessionID, cwd}, argv...)

	// Merge env: inherit parent, overlay caller-provided vars, then apply the
	// assignments stripped from the argv prefix.
	merged := os.Environ()
	for k, v := range env {
		merged = append(merged, k+"="+v)
	}
	merged = append(merged, envAssignments...)

	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.Dir = cwd
	cmd.Env = merged

	cmd.SysProcAttr = ptyHostSysProcAttr()

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", 0, fmt.Errorf("conpty spawn: stdout pipe: %w", err)
	}
	// Capture a bounded copy of the pty-host's stderr. It writes its startup
	// diagnostics there (listen/newConPTY failures) before exiting without
	// printing READY; retaining them lets us report the real cause below.
	stderr := &boundedBuffer{max: maxCapturedStderr}
	cmd.Stderr = stderr

	if err := cmd.Start(); err != nil {
		return "", 0, fmt.Errorf("conpty spawn: start: %w", err)
	}

	// Read READY line with a timeout.
	readyC := make(chan struct {
		addr string
		pid  int
		err  error
	}, 1)

	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			m := readyRE.FindStringSubmatch(line)
			if m != nil {
				pid, _ := strconv.Atoi(m[1])
				port, _ := strconv.Atoi(m[2])
				readyC <- struct {
					addr string
					pid  int
					err  error
				}{"127.0.0.1:" + strconv.Itoa(port), pid, nil}
				return
			}
		}
		msg := "conpty spawn: pty-host exited without printing READY"
		if diag := strings.TrimSpace(stderr.String()); diag != "" {
			msg += ": " + diag
		}
		readyC <- struct {
			addr string
			pid  int
			err  error
		}{"", 0, fmt.Errorf("%s", msg)}
	}()

	timer := time.NewTimer(spawnReadyTimeout)
	defer timer.Stop()

	select {
	case r := <-readyC:
		if r.err != nil {
			_ = cmd.Process.Kill()
			return "", 0, r.err
		}
		// Unref: detach stdout so the child is not blocked, then release reference
		// so our process can exit while the child keeps running.
		stdout.Close()
		cmd.Process.Release() // nolint: errcheck - best-effort detach
		return r.addr, cmd.Process.Pid, nil
	case <-timer.C:
		_ = cmd.Process.Kill()
		return "", 0, fmt.Errorf("conpty spawn: pty-host startup timeout (%s)", spawnReadyTimeout)
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		return "", 0, ctx.Err()
	}
}
