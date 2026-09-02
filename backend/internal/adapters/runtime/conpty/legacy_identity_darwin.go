//go:build darwin

package conpty

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

func collectLegacyHostIdentity(ctx context.Context, sess *hostSession, status StatusPayload) (legacyHostIdentityEvidence, error) {
	listenerPID, err := darwinTCPListenerPID(ctx, sess.addr)
	if err != nil {
		return legacyHostIdentityEvidence{}, err
	}
	host, err := darwinProcessIdentity(sess.pid)
	if err != nil {
		return legacyHostIdentityEvidence{}, fmt.Errorf("inspect recorded host pid %d: %w", sess.pid, err)
	}
	evidence := legacyHostIdentityEvidence{listenerPID: listenerPID, host: host}
	if status.Alive {
		child, childErr := darwinProcessIdentity(status.PID)
		if childErr != nil {
			return legacyHostIdentityEvidence{}, fmt.Errorf("inspect status child pid %d: %w", status.PID, childErr)
		}
		evidence.child = &child
	}
	return evidence, nil
}

func revalidateLegacyHostIdentity(ctx context.Context, sess *hostSession, status StatusPayload, proof legacyHostIdentityFingerprint) error {
	if proof.hostPID != sess.pid {
		return fmt.Errorf("cached host pid %d does not match registry pid %d", proof.hostPID, sess.pid)
	}
	host, err := unix.SysctlKinfoProc("kern.proc.pid", sess.pid)
	if err != nil {
		return fmt.Errorf("revalidate recorded host pid %d: %w", sess.pid, err)
	}
	hostStartedAt := time.Unix(
		host.Proc.P_starttime.Sec,
		int64(host.Proc.P_starttime.Usec)*int64(time.Microsecond),
	)
	if int(host.Proc.P_pid) != sess.pid || !hostStartedAt.Equal(proof.hostStartedAt) {
		return fmt.Errorf("recorded host pid %d changed process incarnation", sess.pid)
	}
	if !status.Alive {
		listenerPID, err := darwinTCPListenerPID(ctx, sess.addr)
		if err != nil {
			return err
		}
		if listenerPID != sess.pid {
			return fmt.Errorf("listener owner pid = %d, want recorded host pid %d", listenerPID, sess.pid)
		}
		return nil
	}
	if status.PID != proof.childPID || proof.childPID <= 0 {
		return fmt.Errorf("legacy status child pid changed from %d to %d", proof.childPID, status.PID)
	}
	child, err := unix.SysctlKinfoProc("kern.proc.pid", status.PID)
	if err != nil {
		return fmt.Errorf("revalidate status child pid %d: %w", status.PID, err)
	}
	childStartedAt := time.Unix(
		child.Proc.P_starttime.Sec,
		int64(child.Proc.P_starttime.Usec)*int64(time.Microsecond),
	)
	if int(child.Proc.P_pid) != status.PID || int(child.Eproc.Ppid) != sess.pid ||
		!childStartedAt.Equal(proof.childStartedAt) {
		return fmt.Errorf("status child pid %d changed process incarnation or parent", status.PID)
	}
	return nil
}

func darwinTCPListenerPID(ctx context.Context, addr string) (int, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil || host != "127.0.0.1" {
		return 0, fmt.Errorf("legacy pty-host address %q is not an exact IPv4 loopback endpoint", addr)
	}
	if _, err := strconv.ParseUint(port, 10, 16); err != nil {
		return 0, fmt.Errorf("parse legacy pty-host port %q: %w", port, err)
	}
	// lsof is part of macOS and asks the kernel which process owns this exact
	// listening endpoint. -F emits stable machine-readable fields.
	out, err := exec.CommandContext(
		ctx,
		"/usr/sbin/lsof",
		"-nP",
		"-a",
		"-iTCP@"+host+":"+port,
		"-sTCP:LISTEN",
		"-Fp",
	).Output()
	if err != nil {
		return 0, fmt.Errorf("resolve legacy pty-host listener owner: %w", err)
	}
	owner := 0
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.HasPrefix(line, "p") {
			continue
		}
		pid, parseErr := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "p")))
		if parseErr != nil || pid <= 0 {
			return 0, fmt.Errorf("parse lsof listener owner %q", line)
		}
		if owner != 0 && owner != pid {
			return 0, fmt.Errorf("legacy pty-host endpoint has multiple listener owners")
		}
		owner = pid
	}
	if owner == 0 {
		return 0, fmt.Errorf("legacy pty-host endpoint has no listening owner")
	}
	return owner, nil
}

func darwinProcessIdentity(pid int) (legacyProcessIdentity, error) {
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return legacyProcessIdentity{}, err
	}
	if int(info.Proc.P_pid) != pid {
		return legacyProcessIdentity{}, fmt.Errorf("kernel returned pid %d", info.Proc.P_pid)
	}
	executable, argv, err := darwinProcessArgs(pid)
	if err != nil {
		return legacyProcessIdentity{}, err
	}
	return legacyProcessIdentity{
		pid:        pid,
		ppid:       int(info.Eproc.Ppid),
		startedAt:  time.Unix(info.Proc.P_starttime.Sec, int64(info.Proc.P_starttime.Usec)*int64(time.Microsecond)),
		executable: executable,
		argv:       argv,
	}, nil
}

func darwinProcessArgs(pid int) (string, []string, error) {
	raw, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil {
		return "", nil, err
	}
	if len(raw) < 5 {
		return "", nil, fmt.Errorf("kernel returned a short process-args payload")
	}
	argc := int(int32(binary.LittleEndian.Uint32(raw[:4])))
	if argc <= 0 || argc > 4096 {
		return "", nil, fmt.Errorf("kernel returned invalid argc %d", argc)
	}
	rest := raw[4:]
	executableEnd := bytes.IndexByte(rest, 0)
	if executableEnd <= 0 {
		return "", nil, fmt.Errorf("kernel process-args payload has no executable path")
	}
	executable := string(rest[:executableEnd])
	rest = rest[executableEnd+1:]
	for len(rest) > 0 && rest[0] == 0 {
		rest = rest[1:]
	}
	argv := make([]string, 0, argc)
	for len(argv) < argc {
		end := bytes.IndexByte(rest, 0)
		if end < 0 {
			return "", nil, fmt.Errorf("kernel process-args payload ended after %d/%d argv entries", len(argv), argc)
		}
		argv = append(argv, string(rest[:end]))
		rest = rest[end+1:]
	}
	return executable, argv, nil
}
