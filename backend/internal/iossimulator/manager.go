// Package iossimulator manages AO's single shared iOS Simulator through
// Apple's xcrun simctl command-line interface.
package iossimulator

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"sync"
)

type CommandRunner func(name string, args ...string) ([]byte, error)

type Status struct {
	Available bool   `json:"available"`
	DeviceID  string `json:"deviceId,omitempty"`
	Name      string `json:"name,omitempty"`
	State     string `json:"state"`
	Error     string `json:"error,omitempty"`
}

type Manager struct {
	mu     sync.Mutex
	run    CommandRunner
	device Status
}

func (m *Manager) Screenshot() ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.device.DeviceID == "" {
		return nil, fmt.Errorf("iOS Simulator is not started")
	}
	data, err := m.run("xcrun", "simctl", "io", m.device.DeviceID, "screenshot", "-")
	if err != nil {
		return nil, fmt.Errorf("capture simulator screenshot: %w", err)
	}
	return data, nil
}

func New() *Manager { return &Manager{run: defaultRunner} }

func NewWithRunner(run CommandRunner) *Manager {
	if run == nil {
		run = defaultRunner
	}
	return &Manager{run: run}
}

func defaultRunner(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).CombinedOutput()
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.device.DeviceID == "" {
		return Status{State: "uninitialized"}
	}
	state, err := m.deviceState(m.device.DeviceID)
	if err != nil {
		m.device.Error = err.Error()
		return m.device
	}
	m.device.State = state
	m.device.Error = ""
	return m.device
}

func (m *Manager) Start() (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.device.DeviceID == "" {
		device, err := m.ensureDevice()
		if err != nil {
			return Status{}, err
		}
		m.device = device
	}
	state, err := m.deviceState(m.device.DeviceID)
	if err != nil {
		return m.device, err
	}
	if state != "Booted" {
		if _, err := m.run("xcrun", "simctl", "boot", m.device.DeviceID); err != nil && !strings.Contains(err.Error(), "already booted") {
			return m.device, err
		}
		// Simulator.app owns the visible window; simctl only boots the device.
		_, _ = m.run("open", "-a", "Simulator")
		if _, err := m.run("xcrun", "simctl", "bootstatus", m.device.DeviceID, "-b"); err != nil {
			return m.device, fmt.Errorf("wait for simulator boot: %w", err)
		}
	}
	m.device.State = "Booted"
	return m.device, nil
}

func (m *Manager) Stop() (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.device.DeviceID == "" {
		return Status{State: "stopped"}, nil
	}
	state, err := m.deviceState(m.device.DeviceID)
	if err != nil {
		return m.device, err
	}
	if state == "Booted" {
		if _, err := m.run("xcrun", "simctl", "shutdown", m.device.DeviceID); err != nil {
			return m.device, err
		}
	}
	m.device.State = "Shutdown"
	return m.device, nil
}

func (m *Manager) ensureDevice() (Status, error) {
	devtypes, err := m.run("xcrun", "simctl", "list", "devicetypes", "-j")
	if err != nil {
		return Status{}, fmt.Errorf("list simulator device types: %w", err)
	}
	runtimes, err := m.run("xcrun", "simctl", "list", "runtimes", "-j")
	if err != nil {
		return Status{}, fmt.Errorf("list simulator runtimes: %w", err)
	}
	typeID, typeName, err := newestIPhoneType(devtypes)
	if err != nil {
		return Status{}, err
	}
	runtimeID, err := newestIOSRuntime(runtimes)
	if err != nil {
		return Status{}, err
	}
	name := "AO iPhone"
	out, err := m.run("xcrun", "simctl", "create", name, typeID, runtimeID)
	if err != nil {
		return Status{}, fmt.Errorf("create simulator: %w", err)
	}
	return Status{Available: true, DeviceID: strings.TrimSpace(string(out)), Name: typeName, State: "Shutdown"}, nil
}

func (m *Manager) deviceState(id string) (string, error) {
	out, err := m.run("xcrun", "simctl", "list", "devices", "-j")
	if err != nil {
		return "", fmt.Errorf("list simulator devices: %w", err)
	}
	var payload struct {
		Devices map[string][]struct {
			UDID  string `json:"udid"`
			State string `json:"state"`
		} `json:"devices"`
	}
	if err := json.Unmarshal(out, &payload); err != nil {
		return "", fmt.Errorf("decode simulator devices: %w", err)
	}
	for _, devices := range payload.Devices {
		for _, device := range devices {
			if device.UDID == id {
				return device.State, nil
			}
		}
	}
	return "", fmt.Errorf("simulator %s not found", id)
}

func newestIPhoneType(out []byte) (string, string, error) {
	var payload struct {
		Devicetypes []struct {
			Identifier string `json:"identifier"`
			Name       string `json:"name"`
		} `json:"devicetypes"`
	}
	if err := json.Unmarshal(out, &payload); err != nil {
		return "", "", fmt.Errorf("decode device types: %w", err)
	}
	var matches []struct{ id, name string }
	for _, d := range payload.Devicetypes {
		if strings.HasPrefix(d.Name, "iPhone") && !strings.Contains(d.Name, "Pro") {
			matches = append(matches, struct{ id, name string }{d.Identifier, d.Name})
		}
	}
	if len(matches) == 0 {
		return "", "", fmt.Errorf("no iPhone simulator device type installed")
	}
	sort.Slice(matches, func(i, j int) bool { return matches[i].name > matches[j].name })
	return matches[0].id, matches[0].name, nil
}

func newestIOSRuntime(out []byte) (string, error) {
	var payload struct {
		Runtimes []struct {
			Identifier string `json:"identifier"`
			Name       string `json:"name"`
			Available  bool   `json:"isAvailable"`
		} `json:"runtimes"`
	}
	if err := json.Unmarshal(out, &payload); err != nil {
		return "", fmt.Errorf("decode simulator runtimes: %w", err)
	}
	var matches []string
	for _, r := range payload.Runtimes {
		if r.Available && strings.HasPrefix(r.Identifier, "com.apple.CoreSimulator.SimRuntime.iOS-") {
			matches = append(matches, r.Identifier)
		}
	}
	if len(matches) == 0 {
		return "", fmt.Errorf("no available iOS simulator runtime installed")
	}
	sort.Strings(matches)
	return matches[len(matches)-1], nil
}
