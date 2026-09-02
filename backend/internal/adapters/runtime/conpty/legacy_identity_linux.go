//go:build linux

package conpty

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

func collectLegacyHostIdentity(ctx context.Context, sess *hostSession, status StatusPayload) (legacyHostIdentityEvidence, error) {
	listenerPID, err := linuxTCP4ListenerPID(sess.addr, sess.pid)
	if err != nil {
		return legacyHostIdentityEvidence{}, err
	}
	host, err := linuxLegacyProcessIdentity(ctx, sess.pid)
	if err != nil {
		return legacyHostIdentityEvidence{}, fmt.Errorf("inspect recorded host pid %d: %w", sess.pid, err)
	}
	evidence := legacyHostIdentityEvidence{listenerPID: listenerPID, host: host}
	if status.Alive {
		child, childErr := linuxLegacyProcessIdentity(ctx, status.PID)
		if childErr != nil {
			return legacyHostIdentityEvidence{}, fmt.Errorf("inspect status child pid %d: %w", status.PID, childErr)
		}
		evidence.child = &child
	}
	return evidence, nil
}

func revalidateLegacyHostIdentity(ctx context.Context, sess *hostSession, status StatusPayload, proof legacyHostIdentityFingerprint) error {
	listenerPID, err := linuxTCP4ListenerPID(sess.addr, sess.pid)
	if err != nil {
		return err
	}
	if listenerPID != sess.pid || proof.hostPID != sess.pid {
		return fmt.Errorf("listener/host pid no longer matches recorded pid %d", sess.pid)
	}
	host, err := linuxLegacyProcessIdentity(ctx, sess.pid)
	if err != nil {
		return fmt.Errorf("revalidate recorded host pid %d: %w", sess.pid, err)
	}
	if !host.startedAt.Equal(proof.hostStartedAt) {
		return fmt.Errorf("recorded host pid %d changed process incarnation", sess.pid)
	}
	if !status.Alive {
		return nil
	}
	if status.PID != proof.childPID || proof.childPID <= 0 {
		return fmt.Errorf("legacy status child pid changed from %d to %d", proof.childPID, status.PID)
	}
	child, err := linuxLegacyProcessIdentity(ctx, status.PID)
	if err != nil {
		return fmt.Errorf("revalidate status child pid %d: %w", status.PID, err)
	}
	if child.ppid != sess.pid || !child.startedAt.Equal(proof.childStartedAt) {
		return fmt.Errorf("status child pid %d changed process incarnation or parent", status.PID)
	}
	return nil
}

func linuxLegacyProcessIdentity(ctx context.Context, pid int) (legacyProcessIdentity, error) {
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return legacyProcessIdentity{}, err
	}
	closeIndex := bytes.LastIndexByte(stat, ')')
	if closeIndex < 0 || closeIndex+2 >= len(stat) {
		return legacyProcessIdentity{}, errors.New("malformed /proc stat")
	}
	fields := strings.Fields(string(stat[closeIndex+2:]))
	if len(fields) < 20 {
		return legacyProcessIdentity{}, errors.New("truncated /proc stat")
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return legacyProcessIdentity{}, fmt.Errorf("parse /proc parent pid: %w", err)
	}
	startTicks, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return legacyProcessIdentity{}, fmt.Errorf("parse /proc process start: %w", err)
	}
	startedAt, err := linuxProcessStartTime(ctx, startTicks)
	if err != nil {
		return legacyProcessIdentity{}, err
	}
	executable, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return legacyProcessIdentity{}, err
	}
	executable = normalizeLinuxProcExecutable(executable)
	commandLine, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return legacyProcessIdentity{}, err
	}
	parts := bytes.Split(bytes.TrimRight(commandLine, "\x00"), []byte{0})
	argv := make([]string, 0, len(parts))
	for _, part := range parts {
		argv = append(argv, string(part))
	}
	if len(argv) == 0 || argv[0] == "" {
		return legacyProcessIdentity{}, errors.New("empty /proc process command line")
	}
	return legacyProcessIdentity{
		pid: pid, ppid: ppid, startedAt: startedAt,
		executable: executable, argv: argv,
	}, nil
}

var (
	linuxClockTicksMu sync.Mutex
	linuxClockTicks   uint64
)

func linuxProcessStartTime(ctx context.Context, startTicks uint64) (time.Time, error) {
	linuxClockTicksMu.Lock()
	clockTicks := linuxClockTicks
	linuxClockTicksMu.Unlock()
	if clockTicks == 0 {
		out, err := exec.CommandContext(ctx, "getconf", "CLK_TCK").Output()
		if err != nil {
			return time.Time{}, fmt.Errorf("resolve Linux clock ticks: %w", err)
		}
		clockTicks, err = strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
		if err != nil {
			return time.Time{}, fmt.Errorf("parse Linux clock ticks: %w", err)
		}
		if clockTicks == 0 {
			return time.Time{}, errors.New("parse Linux clock ticks: value is zero")
		}
		linuxClockTicksMu.Lock()
		if linuxClockTicks == 0 {
			linuxClockTicks = clockTicks
		} else {
			clockTicks = linuxClockTicks
		}
		linuxClockTicksMu.Unlock()
	}
	stat, err := os.ReadFile("/proc/stat")
	if err != nil {
		return time.Time{}, err
	}
	var bootSeconds int64
	for _, line := range strings.Split(string(stat), "\n") {
		if !strings.HasPrefix(line, "btime ") {
			continue
		}
		bootSeconds, err = strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "btime ")), 10, 64)
		break
	}
	if err != nil {
		return time.Time{}, fmt.Errorf("parse Linux boot time: %w", err)
	}
	if bootSeconds <= 0 {
		return time.Time{}, errors.New("parse Linux boot time: btime is missing or invalid")
	}
	wholeSeconds := startTicks / clockTicks
	fractionTicks := startTicks % clockTicks
	if wholeSeconds > uint64(math.MaxInt64-bootSeconds) {
		return time.Time{}, errors.New("parse Linux process start: timestamp overflows int64")
	}
	// This bound makes both the uint64-to-int64 conversion and the subsequent
	// nanosecond multiplication safe. Real CLK_TCK values are several orders of
	// magnitude smaller; an impossible value keeps recovery inconclusive.
	if clockTicks > uint64(math.MaxInt64/int64(time.Second)) {
		return time.Time{}, fmt.Errorf("parse Linux clock ticks: value %d is too large", clockTicks)
	}
	seconds := int64(wholeSeconds)   // #nosec G115 -- bounded against MaxInt64 above
	fraction := int64(fractionTicks) // #nosec G115 -- fraction is below bounded clockTicks
	tickRate := int64(clockTicks)    // #nosec G115 -- clockTicks is explicitly bounded above
	nanos := fraction * int64(time.Second) / tickRate
	return time.Unix(bootSeconds+seconds, nanos), nil
}

func linuxTCP4ListenerPID(addr string, expectedPID int) (int, error) {
	host, portText, err := net.SplitHostPort(addr)
	if err != nil || host != "127.0.0.1" {
		return 0, fmt.Errorf("legacy pty-host address %q is not an exact IPv4 loopback endpoint", addr)
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || port == 0 {
		return 0, fmt.Errorf("parse legacy pty-host port %q", portText)
	}
	wantLocal := fmt.Sprintf("0100007F:%04X", port)
	tcp, err := os.ReadFile("/proc/net/tcp")
	if err != nil {
		return 0, err
	}
	inode := ""
	for _, line := range strings.Split(string(tcp), "\n") {
		fields := strings.Fields(line)
		if len(fields) > 9 && fields[1] == wantLocal && fields[3] == "0A" {
			if inode != "" && inode != fields[9] {
				return 0, errors.New("legacy pty-host endpoint has multiple listener sockets")
			}
			inode = fields[9]
		}
	}
	if inode == "" {
		return 0, errors.New("legacy pty-host endpoint has no listening socket")
	}
	fds, err := os.ReadDir(fmt.Sprintf("/proc/%d/fd", expectedPID))
	if err != nil {
		return 0, err
	}
	wantSocket := "socket:[" + inode + "]"
	for _, fd := range fds {
		target, readErr := os.Readlink(fmt.Sprintf("/proc/%d/fd/%s", expectedPID, fd.Name()))
		if readErr == nil && target == wantSocket {
			return expectedPID, nil
		}
	}
	return 0, fmt.Errorf("legacy pty-host listener is not owned by recorded pid %d", expectedPID)
}
