//go:build windows

package conpty

import (
	"fmt"
	"os"
	"sync"
	"unsafe"

	gopty "github.com/aymanbagabas/go-pty"
	"golang.org/x/sys/windows"
)

// conptyConn is the real ptyConn implementation backed by go-pty's ConPty
// (Windows ConPTY API). Only compiled on Windows.
type conptyConn struct {
	pty gopty.ConPty
	cmd *gopty.Cmd

	// job groups the ConPTY child and every process it spawns (e.g. the
	// "agent-process supervise" wrapper and, under that, the actual agent
	// binary) so Close can terminate the whole tree atomically. Without this,
	// killing only cmd.Process (TerminateProcess, no signal, no propagation)
	// orphans grandchildren, which can keep holding open file handles in the
	// session's git worktree well past its removal retry budget, failing
	// orchestrator replacement with "process cannot access the file". See
	// windows.INVALID_HANDLE_VALUE check in newConPTY: job stays 0 if it
	// could not be created/assigned, and Close falls back to the old
	// single-process kill so a job-object failure never blocks teardown.
	job windows.Handle

	once     sync.Once
	doneC    chan struct{}
	exitCode int
	exited   bool
	exitMu   sync.Mutex
}

// newConPTY creates a ConPTY session running shellCmd in cwd with shellArgs.
// It starts the process and returns a ptyConn ready for use.
func newConPTY(cwd, shellCmd string, shellArgs []string) (ptyConn, error) {
	// go-pty's New() returns a ConPty on Windows.
	p, err := gopty.New()
	if err != nil {
		return nil, fmt.Errorf("conpty: create pty: %w", err)
	}
	cp, ok := p.(gopty.ConPty)
	if !ok {
		_ = p.Close()
		return nil, fmt.Errorf("conpty: expected ConPty on windows, got %T", p)
	}

	// Set an initial size matching node-pty defaults from pty-host.ts.
	if err := cp.Resize(initialConPTYColumns, initialConPTYRows); err != nil {
		_ = cp.Close()
		return nil, fmt.Errorf("conpty: initial resize: %w", err)
	}

	cmd := cp.Command(shellCmd, shellArgs...)
	cmd.Dir = cwd
	// Inherit parent env so PATH, HOME, etc. are available.
	cmd.Env = os.Environ()

	if err := cmd.Start(); err != nil {
		_ = cp.Close()
		return nil, fmt.Errorf("conpty: start command: %w", err)
	}

	c := &conptyConn{
		pty:   cp,
		cmd:   cmd,
		doneC: make(chan struct{}),
	}
	// Best-effort: a job-object failure (permissions, exotic sandboxing) must
	// not fail the session start. c.job stays its zero value and Close falls
	// back to killing only cmd.Process, matching the pre-job-object behavior.
	c.job = newKillOnCloseJob(cmd.Process.Pid)

	go c.wait()
	return c, nil
}

// newKillOnCloseJob creates a Windows Job Object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and assigns pid to it, so every process
// pid spawns (and every process those spawn, recursively) dies together when
// the job is terminated or its last handle closes. Returns 0 if the job
// could not be created or the process could not be assigned — the caller
// treats that as "no job", not a fatal error.
func newKillOnCloseJob(pid int) windows.Handle {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		_ = windows.CloseHandle(job)
		return 0
	}
	// PROCESS_TERMINATE + PROCESS_SET_QUOTA are the documented minimum rights
	// AssignProcessToJobObject requires. This handle is only needed for the
	// assignment call itself; the job keeps the process bound after it closes.
	proc, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.PROCESS_SET_QUOTA, false, uint32(pid))
	if err != nil {
		_ = windows.CloseHandle(job)
		return 0
	}
	defer windows.CloseHandle(proc)
	if err := windows.AssignProcessToJobObject(job, proc); err != nil {
		_ = windows.CloseHandle(job)
		return 0
	}
	return job
}

func (c *conptyConn) wait() {
	_ = c.cmd.Wait()
	code := 0
	if c.cmd.ProcessState != nil {
		code = c.cmd.ProcessState.ExitCode()
	}
	c.exitMu.Lock()
	c.exitCode = code
	c.exited = true
	c.exitMu.Unlock()
	c.once.Do(func() { close(c.doneC) })
}

func (c *conptyConn) Read(b []byte) (int, error)  { return c.pty.Read(b) }
func (c *conptyConn) Write(b []byte) (int, error) { return c.pty.Write(b) }
func (c *conptyConn) Close() error {
	err := c.pty.Close()
	// Best-effort kill: a child that ignores ConPTY EOF still gets terminated
	// so Done() fires. Mirrors pty.kill() in pty-host.ts.
	//
	// Prefer the job object: TerminateJobObject kills cmd.Process AND every
	// process it spawned (e.g. "agent-process supervise" and, under that, the
	// actual agent binary) atomically. cmd.Process.Kill() alone only reaches
	// the direct child — TerminateProcess does not propagate to descendants,
	// so on Windows the actual agent process is orphaned, keeps running, and
	// can hold the session's worktree files open well past the caller's
	// force-remove retry budget (surfaces as "process cannot access the
	// file" when replacing/retiring the session). Falls back to the old
	// single-process kill when no job was created (see newKillOnCloseJob).
	if c.job != 0 {
		_ = windows.TerminateJobObject(c.job, 1)
		_ = windows.CloseHandle(c.job)
	} else if c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
	return err
}
func (c *conptyConn) Resize(cols, rows int) error { return c.pty.Resize(cols, rows) }
func (c *conptyConn) Done() <-chan struct{}       { return c.doneC }
func (c *conptyConn) PID() int {
	if c.cmd.Process == nil {
		return 0
	}
	return c.cmd.Process.Pid
}
func (c *conptyConn) ExitCode() (int, bool) {
	c.exitMu.Lock()
	defer c.exitMu.Unlock()
	return c.exitCode, c.exited
}
