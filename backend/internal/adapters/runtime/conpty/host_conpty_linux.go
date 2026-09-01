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

	leaderPID       int
	leaderStartTime uint64
}

const linuxPTYCloseGrace = 250 * time.Millisecond

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

	leaderPID := 0
	var leaderStartTime uint64
	if cmd.Process != nil {
		leaderPID = cmd.Process.Pid
		if info, err := readLinuxProcInfo(leaderPID); err == nil {
			leaderStartTime = info.startTime
		}
	}

	c := &linuxPTYConn{
		pty:             f,
		cmd:             cmd,
		doneC:           make(chan struct{}),
		leaderPID:       leaderPID,
		leaderStartTime: leaderStartTime,
	}
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
		if c.leaderPID > 0 && c.leaderStartTime > 0 {
			// The PTY child was started as a session leader (setsid). Discover and
			// reap all validated processes in the session so background jobs cannot
			// outlive teardown, without signaling stale/recycled PIDs.
			killLinuxSession(c.leaderPID, c.leaderStartTime, syscall.SIGTERM)
			if !waitForLinuxSessionExit(c.leaderPID, c.leaderStartTime, linuxPTYCloseGrace) {
				killLinuxSession(c.leaderPID, c.leaderStartTime, syscall.SIGKILL)
				_ = waitForLinuxSessionExit(c.leaderPID, c.leaderStartTime, linuxPTYCloseGrace)
			}
		}
		if c.pty != nil {
			closeErr = c.pty.Close()
		}
	})
	return closeErr
}

type linuxProcInfo struct {
	pid       int
	ppid      int
	pgrp      int
	sid       int
	startTime uint64
	zombie    bool
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
	if len(fields) < 20 {
		return linuxProcInfo{}, errors.New("truncated /proc stat")
	}
	state := fields[0]
	ppid, err1 := strconv.Atoi(fields[1])
	pgrp, err2 := strconv.Atoi(fields[2])
	sid, err3 := strconv.Atoi(fields[3])
	startTime, err4 := strconv.ParseUint(fields[19], 10, 64)
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil {
		return linuxProcInfo{}, errors.New("invalid /proc stat numeric fields")
	}
	return linuxProcInfo{
		pid:       pid,
		ppid:      ppid,
		pgrp:      pgrp,
		sid:       sid,
		startTime: startTime,
		zombie:    state == "Z",
	}, nil
}

func linuxFindSessionProcesses(sid int, leaderStartTime uint64) []linuxProcInfo {
	if sid <= 0 || leaderStartTime == 0 {
		return nil
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	selfPID := os.Getpid()
	procMap := make(map[int]linuxProcInfo)
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
		procMap[pid] = info
		allProcs = append(allProcs, info)
	}

	// Validate the session leader identity if a process with PID sid is currently in /proc.
	if leaderProc, ok := procMap[sid]; ok {
		// If PID sid is occupied by a process with a different start time than our recorded
		// leader start time, the PID has been recycled for an unrelated process or session.
		if leaderProc.startTime != leaderStartTime {
			return nil
		}
	}

	inSession := make(map[int]bool)
	if leaderProc, ok := procMap[sid]; ok && leaderProc.startTime == leaderStartTime {
		inSession[sid] = true
	}

	for _, p := range allProcs {
		if p.sid == sid {
			if p.startTime >= leaderStartTime {
				inSession[p.pid] = true
			}
		}
	}

	for {
		added := false
		for _, p := range allProcs {
			if !inSession[p.pid] && inSession[p.ppid] {
				if p.startTime >= leaderStartTime {
					inSession[p.pid] = true
					added = true
				}
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

func killLinuxSession(sid int, leaderStartTime uint64, sig syscall.Signal) {
	if sid <= 0 || leaderStartTime == 0 {
		return
	}
	// Discover and validate session members BEFORE signaling any PID or PGID.
	// Do NOT unconditionally signal sid or -sid.
	procs := linuxFindSessionProcesses(sid, leaderStartTime)
	if len(procs) == 0 {
		return
	}

	validPIDs := make(map[int]bool, len(procs))
	for _, p := range procs {
		validPIDs[p.pid] = true
	}

	// 1. Signal every individual validated process in the session directly
	for _, p := range procs {
		_ = syscall.Kill(p.pid, sig)
	}

	// 2. Only signal process groups whose group leader is a validated member of our session
	signaledPGRPs := make(map[int]bool)
	for _, p := range procs {
		if p.pgrp > 1 && validPIDs[p.pgrp] && !signaledPGRPs[p.pgrp] {
			signaledPGRPs[p.pgrp] = true
			_ = syscall.Kill(-p.pgrp, sig)
		}
	}
}

func waitForLinuxSessionExit(sid int, leaderStartTime uint64, timeout time.Duration) bool {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if !linuxSessionAlive(sid, leaderStartTime) {
			return true
		}
		select {
		case <-deadline.C:
			return !linuxSessionAlive(sid, leaderStartTime)
		case <-ticker.C:
		}
	}
}

func linuxSessionAlive(sid int, leaderStartTime uint64) bool {
	if sid <= 0 || leaderStartTime == 0 {
		return false
	}
	procs := linuxFindSessionProcesses(sid, leaderStartTime)
	return len(procs) > 0
}

func (c *linuxPTYConn) Done() <-chan struct{} { return c.doneC }

func (c *linuxPTYConn) PID() int {
	return c.leaderPID
}

func (c *linuxPTYConn) ExitCode() (int, bool) {
	c.exitMu.Lock()
	defer c.exitMu.Unlock()
	return c.exitCode, c.exited
}
