//go:build linux

package conpty

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

// linuxPTYConn is a native Linux pseudoterminal owned by the detached host.
// The child starts in its own session/process group (creack/pty's StartWithSize
// sets Setsid: true), so teardown can reap the whole launched process tree
// and session rather than leaving background jobs or altered process groups behind.
type linuxPTYConn struct {
	pty *os.File
	cmd *exec.Cmd

	closeOnce sync.Once
	doneC     chan struct{}
	exitMu    sync.Mutex
	exitCode  int
	exited    bool
}

const linuxPTYCloseGrace = 500 * time.Millisecond

func newConPTY(cwd, shellCmd string, shellArgs []string) (ptyConn, error) {
	// shellCmd and shellArgs are the runtime launch argv assembled by AO's
	// trusted agent adapter, not input interpreted by a shell.
	cmd := exec.Command(shellCmd, shellArgs...) // #nosec G702 -- intentional direct argv execution
	cmd.Dir = cwd
	cmd.Env = os.Environ()

	f, err := pty.StartWithSize(cmd, &pty.Winsize{
		Cols: initialConPTYColumns,
		Rows: initialConPTYRows,
	})
	if err != nil {
		return nil, fmt.Errorf("linux pty: start command: %w", err)
	}

	c := &linuxPTYConn{pty: f, cmd: cmd, doneC: make(chan struct{})}
	go c.wait()
	return c, nil
}

func (c *linuxPTYConn) wait() {
	err := c.cmd.Wait()
	code := 0
	if c.cmd.ProcessState != nil {
		code = c.cmd.ProcessState.ExitCode()
	} else if err != nil {
		code = -1
	}
	c.exitMu.Lock()
	c.exitCode = code
	c.exited = true
	c.exitMu.Unlock()
	close(c.doneC)
}

func (c *linuxPTYConn) Read(b []byte) (int, error)  { return c.pty.Read(b) }
func (c *linuxPTYConn) Write(b []byte) (int, error) { return c.pty.Write(b) }

func (c *linuxPTYConn) Resize(cols, rows int) error {
	if cols <= 0 || rows <= 0 || cols > math.MaxUint16 || rows > math.MaxUint16 {
		return fmt.Errorf("linux pty: invalid size %dx%d", cols, rows)
	}
	return pty.Setsize(c.pty, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

func (c *linuxPTYConn) Close() error {
	var closeErr error
	c.closeOnce.Do(func() {
		if c.cmd.Process != nil && c.cmd.Process.Pid > 0 {
			sid := c.cmd.Process.Pid
			// The PTY child was started as a session leader (setsid). Reap all
			// descendant processes and process groups in the session so background
			// jobs and shells with job control cannot outlive terminal teardown.
			killLinuxSession(sid, syscall.SIGTERM)
			if !waitForLinuxSessionExit(sid, linuxPTYCloseGrace) {
				killLinuxSession(sid, syscall.SIGKILL)
				_ = waitForLinuxSessionExit(sid, linuxPTYCloseGrace)
			}
		}
		closeErr = c.pty.Close()
	})
	return closeErr
}

type linuxProcInfo struct {
	pid    int
	ppid   int
	pgrp   int
	sid    int
	zombie bool
}

func readLinuxProcInfo(pid int) (linuxProcInfo, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return linuxProcInfo{}, err
	}
	// /proc/[pid]/stat format: pid (comm) state ppid pgrp session ...
	// The comm field is enclosed in parentheses and may contain spaces or ')'.
	closeIdx := bytes.LastIndexByte(data, ')')
	if closeIdx == -1 || closeIdx+2 >= len(data) {
		return linuxProcInfo{}, errors.New("malformed /proc stat")
	}
	fields := strings.Fields(string(data[closeIdx+2:]))
	if len(fields) < 4 {
		return linuxProcInfo{}, errors.New("truncated /proc stat")
	}
	state := fields[0]
	ppid, err1 := strconv.Atoi(fields[1])
	pgrp, err2 := strconv.Atoi(fields[2])
	sid, err3 := strconv.Atoi(fields[3])
	if err1 != nil || err2 != nil || err3 != nil {
		return linuxProcInfo{}, errors.New("invalid /proc stat numeric fields")
	}
	return linuxProcInfo{
		pid:    pid,
		ppid:   ppid,
		pgrp:   pgrp,
		sid:    sid,
		zombie: state == "Z",
	}, nil
}

func linuxFindSessionProcesses(sid int) []linuxProcInfo {
	if sid <= 0 {
		return nil
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	selfPID := os.Getpid()
	var allProcs []linuxProcInfo
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 1 || pid == selfPID {
			continue
		}
		info, err := readLinuxProcInfo(pid)
		if err != nil {
			continue
		}
		allProcs = append(allProcs, info)
	}

	inSession := make(map[int]bool)
	inSession[sid] = true

	for _, p := range allProcs {
		if p.sid == sid || p.pgrp == sid {
			inSession[p.pid] = true
		}
	}

	for {
		added := false
		for _, p := range allProcs {
			if !inSession[p.pid] && inSession[p.ppid] {
				inSession[p.pid] = true
				added = true
			}
		}
		if !added {
			break
		}
	}

	var sessionProcs []linuxProcInfo
	for _, p := range allProcs {
		if inSession[p.pid] && !p.zombie {
			sessionProcs = append(sessionProcs, p)
		}
	}
	return sessionProcs
}

func killLinuxSession(sid int, sig syscall.Signal) {
	if sid <= 0 {
		return
	}
	_ = syscall.Kill(-sid, sig)
	_ = syscall.Kill(sid, sig)

	procs := linuxFindSessionProcesses(sid)
	for _, p := range procs {
		_ = syscall.Kill(p.pid, sig)
		if p.pgrp > 1 {
			_ = syscall.Kill(-p.pgrp, sig)
		}
	}
}

func waitForLinuxSessionExit(sid int, timeout time.Duration) bool {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if !linuxSessionAlive(sid) {
			return true
		}
		select {
		case <-deadline.C:
			return !linuxSessionAlive(sid)
		case <-ticker.C:
		}
	}
}

func linuxSessionAlive(sid int) bool {
	if sid <= 0 {
		return false
	}
	procs := linuxFindSessionProcesses(sid)
	if len(procs) > 0 {
		return true
	}
	return linuxProcessGroupAlive(sid)
}

func linuxProcessGroupAlive(pgid int) bool {
	if pgid <= 0 {
		return false
	}
	err := syscall.Kill(-pgid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func (c *linuxPTYConn) Done() <-chan struct{} { return c.doneC }

func (c *linuxPTYConn) PID() int {
	if c.cmd.Process == nil {
		return 0
	}
	return c.cmd.Process.Pid
}

func (c *linuxPTYConn) ExitCode() (int, bool) {
	c.exitMu.Lock()
	defer c.exitMu.Unlock()
	return c.exitCode, c.exited
}
