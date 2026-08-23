package sandboxruntime

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"

	creackpty "github.com/creack/pty"
)

type PTY interface {
	io.ReadWriteCloser
	Resize(rows, cols uint16) error
	Wait() error
	Terminate(context.Context) error
}

type PTYFactory interface {
	Start(command []string, dir string) (PTY, error)
}

type DirectPTYFactory struct{}

func (DirectPTYFactory) Start(command []string, dir string) (PTY, error) {
	if len(command) == 0 || !filepath.IsAbs(command[0]) {
		return nil, errors.New("sandbox command must use an absolute executable path")
	}
	cmd := exec.Command(command[0], command[1:]...)
	cmd.Dir = dir
	cmd.Env = []string{
		"HOME=/home/ao",
		"LANG=C.UTF-8",
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"TERM=xterm-256color",
	}
	f, err := creackpty.StartWithSize(cmd, &creackpty.Winsize{Rows: 24, Cols: 80})
	if err != nil {
		return nil, err
	}
	return &directPTY{file: f, cmd: cmd}, nil
}

type directPTY struct {
	file     *os.File
	cmd      *exec.Cmd
	waitOnce sync.Once
	waitErr  error
}

func (p *directPTY) Read(b []byte) (int, error)  { return p.file.Read(b) }
func (p *directPTY) Write(b []byte) (int, error) { return p.file.Write(b) }
func (p *directPTY) Close() error                { return p.file.Close() }
func (p *directPTY) Resize(rows, cols uint16) error {
	if rows == 0 || cols == 0 {
		return nil
	}
	return creackpty.Setsize(p.file, &creackpty.Winsize{Rows: rows, Cols: cols})
}
func (p *directPTY) Wait() error {
	p.waitOnce.Do(func() { p.waitErr = p.cmd.Wait() })
	return p.waitErr
}
func (p *directPTY) Terminate(ctx context.Context) error {
	if p.cmd.Process == nil {
		return nil
	}
	_ = p.cmd.Process.Signal(syscall.SIGTERM)
	done := make(chan error, 1)
	go func() { done <- p.Wait() }()
	select {
	case <-ctx.Done():
		_ = p.cmd.Process.Kill()
		<-done
		return ctx.Err()
	case <-done:
		return nil
	}
}
