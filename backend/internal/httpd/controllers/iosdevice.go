package controllers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/iossdk"
	"github.com/aoagents/agent-orchestrator/backend/internal/iossimulator"
)

// IOSDeviceController exposes the iOS Simulator HTTP API.
type IOSDeviceController struct{ Simulator *iossimulator.Manager }

// Status reports the detected iOS toolchain.
func (c *IOSDeviceController) Status(w http.ResponseWriter, r *http.Request) {
	envelope.WriteJSON(w, http.StatusOK, iosStatusResponse(iossdk.DetectToolchain()))
}

// Recheck refreshes the detected iOS toolchain status.
func (c *IOSDeviceController) Recheck(w http.ResponseWriter, r *http.Request) {
	envelope.WriteJSON(w, http.StatusOK, iosStatusResponse(iossdk.DetectToolchain()))
}

// FetchRuntime explains how to acquire an iOS runtime.
func (c *IOSDeviceController) FetchRuntime(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AcceptAppleID bool `json:"acceptAppleID"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, FetchRuntimeResponse{Success: false, Message: "AO cannot download Xcode. Install Xcode from the Mac App Store or Apple Developer downloads, then recheck the toolchain."})
}

// SimulatorStatus reports the managed simulator state.
func (c *IOSDeviceController) SimulatorStatus(w http.ResponseWriter, r *http.Request) {
	if c.Simulator == nil {
		envelope.WriteJSON(w, http.StatusNotImplemented, map[string]string{"error": "iOS Simulator is not wired"})
		return
	}
	envelope.WriteJSON(w, http.StatusOK, simulatorStatusResponse(c.Simulator.Status()))
}

// StartSimulator boots the managed simulator.
func (c *IOSDeviceController) StartSimulator(w http.ResponseWriter, r *http.Request) {
	if c.Simulator == nil {
		envelope.WriteJSON(w, http.StatusNotImplemented, map[string]string{"error": "iOS Simulator is not wired"})
		return
	}
	status, err := c.Simulator.Start()
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "IOS_SIMULATOR_START", err.Error(), nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, simulatorStatusResponse(status))
}

// StopSimulator shuts down the managed simulator.
func (c *IOSDeviceController) StopSimulator(w http.ResponseWriter, r *http.Request) {
	if c.Simulator == nil {
		envelope.WriteJSON(w, http.StatusNotImplemented, map[string]string{"error": "iOS Simulator is not wired"})
		return
	}
	status, err := c.Simulator.Stop()
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "IOS_SIMULATOR_STOP", err.Error(), nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, simulatorStatusResponse(status))
}

// Screenshot captures the managed simulator display.
func (c *IOSDeviceController) Screenshot(w http.ResponseWriter, r *http.Request) {
	if c.Simulator == nil {
		envelope.WriteJSON(w, http.StatusNotImplemented, map[string]string{"error": "iOS Simulator is not wired"})
		return
	}
	data, err := c.Simulator.Screenshot()
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "IOS_SIMULATOR_SCREENSHOT", err.Error(), nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, SimulatorScreenshotResponse{Data: base64.StdEncoding.EncodeToString(data), MimeType: "image/png"})
}

// Permissions reports macOS permissions relevant to simulator control.
func (c *IOSDeviceController) Permissions(w http.ResponseWriter, r *http.Request) {
	status := iossimulator.PermissionsStatus()
	envelope.WriteJSON(w, http.StatusOK, SimulatorPermissionsResponse{ScreenRecording: status.ScreenRecording, Accessibility: status.Accessibility, Supported: status.Supported})
}

// Input sends tap, swipe, text, or key input to the simulator.
func (c *IOSDeviceController) Input(w http.ResponseWriter, r *http.Request) {
	if c.Simulator == nil {
		envelope.WriteJSON(w, http.StatusNotImplemented, map[string]string{"error": "iOS Simulator is not wired"})
		return
	}
	var request SimulatorInputRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	err := c.Simulator.Input(iossimulator.Input{Action: request.Action, X: request.X, Y: request.Y, X2: request.X2, Y2: request.Y2, Text: request.Text, KeyCode: request.KeyCode})
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "IOS_SIMULATOR_INPUT", err.Error(), nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, SimulatorInputResponse{Accepted: true})
}

// Stream sends periodic simulator screenshots over WebSocket.
func (c *IOSDeviceController) Stream(w http.ResponseWriter, r *http.Request) {
	if c.Simulator == nil {
		http.Error(w, "iOS Simulator is not wired", http.StatusNotImplemented)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "stream ended") }()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			data, captureErr := c.Simulator.NativeScreenshot()
			if captureErr != nil {
				data, captureErr = c.Simulator.Screenshot()
			}
			if captureErr != nil {
				_ = wsjson.Write(context.Background(), conn, map[string]string{"error": captureErr.Error()})
				continue
			}
			if err := wsjson.Write(context.Background(), conn, SimulatorScreenshotResponse{Data: base64.StdEncoding.EncodeToString(data), MimeType: "image/png"}); err != nil {
				return
			}
		}
	}
}

// InstallApp installs an app bundle on the managed simulator.
func (c *IOSDeviceController) InstallApp(w http.ResponseWriter, r *http.Request) {
	var q SimulatorAppRequest
	if json.NewDecoder(r.Body).Decode(&q) != nil || q.AppPath == "" {
		envelope.WriteAPIError(w, r, 400, "bad_request", "INVALID_APP", "appPath is required", nil)
		return
	}
	if err := c.Simulator.Install(q.AppPath); err != nil {
		envelope.WriteAPIError(w, r, 409, "conflict", "IOS_INSTALL", err.Error(), nil)
		return
	}
	envelope.WriteJSON(w, 200, SimulatorInputResponse{Accepted: true})
}

// LaunchApp launches an installed app by bundle identifier.
func (c *IOSDeviceController) LaunchApp(w http.ResponseWriter, r *http.Request) {
	var q SimulatorAppRequest
	if json.NewDecoder(r.Body).Decode(&q) != nil || q.BundleID == "" {
		envelope.WriteAPIError(w, r, 400, "bad_request", "INVALID_BUNDLE_ID", "bundleId is required", nil)
		return
	}
	if err := c.Simulator.Launch(q.BundleID); err != nil {
		envelope.WriteAPIError(w, r, 409, "conflict", "IOS_LAUNCH", err.Error(), nil)
		return
	}
	envelope.WriteJSON(w, 200, SimulatorInputResponse{Accepted: true})
}

// TerminateApp stops an app by bundle identifier.
func (c *IOSDeviceController) TerminateApp(w http.ResponseWriter, r *http.Request) {
	var q SimulatorAppRequest
	if json.NewDecoder(r.Body).Decode(&q) != nil || q.BundleID == "" {
		envelope.WriteAPIError(w, r, 400, "bad_request", "INVALID_BUNDLE_ID", "bundleId is required", nil)
		return
	}
	if err := c.Simulator.Terminate(q.BundleID); err != nil {
		envelope.WriteAPIError(w, r, 409, "conflict", "IOS_TERMINATE", err.Error(), nil)
		return
	}
	envelope.WriteJSON(w, 200, SimulatorInputResponse{Accepted: true})
}

// BuildApp builds, installs, and optionally launches an iOS app.
func (c *IOSDeviceController) BuildApp(w http.ResponseWriter, r *http.Request) {
	var q SimulatorBuildRequest
	if json.NewDecoder(r.Body).Decode(&q) != nil || q.Scheme == "" {
		envelope.WriteAPIError(w, r, 400, "bad_request", "INVALID_BUILD", "scheme is required", nil)
		return
	}
	app, err := iossimulator.BuildApp(q.Project, q.Workspace, q.Scheme, q.DerivedData)
	if err != nil {
		envelope.WriteAPIError(w, r, 409, "conflict", "IOS_BUILD", err.Error(), nil)
		return
	}
	if c.Simulator == nil {
		http.Error(w, "not wired", http.StatusNotImplemented)
		return
	}
	if err := c.Simulator.Install(app); err != nil {
		envelope.WriteAPIError(w, r, 409, "conflict", "IOS_INSTALL", err.Error(), nil)
		return
	}
	if q.BundleID != "" {
		if err := c.Simulator.Launch(q.BundleID); err != nil {
			envelope.WriteAPIError(w, r, 409, "conflict", "IOS_LAUNCH", err.Error(), nil)
			return
		}
	}
	envelope.WriteJSON(w, 200, SimulatorBuildResponse{AppPath: app, Accepted: true})
}

func simulatorStatusResponse(status iossimulator.Status) SimulatorStatusResponse {
	return SimulatorStatusResponse{Available: status.Available, DeviceID: status.DeviceID, Name: status.Name, State: status.State, Error: status.Error}
}

func iosStatusResponse(status iossdk.ToolchainStatus) StatusResponse {
	res := StatusResponse{XcodeDetected: status.XcodeDetected, CLTOnly: status.CLTOnly, SimctlAvailable: status.SimctlAvailable, DefaultRuntimeAvailable: status.DefaultRuntimeAvailable}
	if !status.XcodeDetected {
		res.GuidanceAppStoreURL = iossdk.DefaultGuidance.AppStoreURL
		res.GuidanceDeveloperURL = iossdk.DefaultGuidance.DeveloperURL
		res.GuidanceWhyMissing = iossdk.DefaultGuidance.WhyMissing
	}
	return res
}

// Register mounts the iOS Simulator routes on a Chi router.
func (c *IOSDeviceController) Register(r chi.Router) {
	r.Get("/ios-device/toolchain/status", c.Status)
	r.Post("/ios-device/toolchain/recheck", c.Recheck)
	r.Post("/ios-device/toolchain/fetch-runtime", c.FetchRuntime)
	r.Get("/ios-device/status", c.SimulatorStatus)
	r.Post("/ios-device/start", c.StartSimulator)
	r.Post("/ios-device/stop", c.StopSimulator)
	r.Get("/ios-device/screenshot", c.Screenshot)
	r.Get("/ios-device/permissions", c.Permissions)
	r.Post("/ios-device/input", c.Input)
	r.Get("/ios-device/stream", c.Stream)
	r.Post("/ios-device/app/install", c.InstallApp)
	r.Post("/ios-device/app/launch", c.LaunchApp)
	r.Post("/ios-device/app/terminate", c.TerminateApp)
	r.Post("/ios-device/app/build", c.BuildApp)
}
