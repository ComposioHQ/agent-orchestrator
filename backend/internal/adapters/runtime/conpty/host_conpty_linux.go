//go:build linux

package conpty

import (
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

// linuxPTYConn is a native Linux pseudoterminal owned by the detached host.
// The child starts in its own session/process group (creack/pty's StartWithSize
// does this), so teardown can reap the whole launched process tree rather than
// leaving dev servers or other descendants behind.
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
		if c.cmd.Process != nil {
			select {
			case <-c.doneC:
			default:
				// The PTY child is a session leader. Signal its process group so
				// descendants cannot outlive a terminal AO explicitly destroys.
				pgid := c.cmd.Process.Pid
				_ = syscall.Kill(-pgid, syscall.SIGTERM)
				if !waitForLinuxProcessGroupExit(pgid, linuxPTYCloseGrace) {
					_ = syscall.Kill(-pgid, syscall.SIGKILL)
					select {
					case <-c.doneC:
					case <-time.After(linuxPTYCloseGrace):
					}
				}
			}
		}
		closeErr = c.pty.Close()
	})
	return closeErr
}

func waitForLinuxProcessGroupExit(pgid int, timeout time.Duration) bool {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if !linuxProcessGroupAlive(pgid) {
			return true
		}
		select {
		case <-deadline.C:
			return !linuxProcessGroupAlive(pgid)
		case <-ticker.C:
		}
	}
}

func linuxProcessGroupAlive(pgid int) bool {
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
