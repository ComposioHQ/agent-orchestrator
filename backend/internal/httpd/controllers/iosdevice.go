package controllers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/iossdk"
	"github.com/aoagents/agent-orchestrator/backend/internal/iossimulator"
)

type IOSDeviceController struct{ Simulator *iossimulator.Manager }

func (c *IOSDeviceController) Status(w http.ResponseWriter, r *http.Request) {
	envelope.WriteJSON(w, http.StatusOK, iosStatusResponse(iossdk.DetectToolchain()))
}

func (c *IOSDeviceController) Recheck(w http.ResponseWriter, r *http.Request) {
	envelope.WriteJSON(w, http.StatusOK, iosStatusResponse(iossdk.DetectToolchain()))
}

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

func (c *IOSDeviceController) SimulatorStatus(w http.ResponseWriter, r *http.Request) {
	if c.Simulator == nil {
		envelope.WriteJSON(w, http.StatusNotImplemented, map[string]string{"error": "iOS Simulator is not wired"})
		return
	}
	envelope.WriteJSON(w, http.StatusOK, simulatorStatusResponse(c.Simulator.Status()))
}

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

func (c *IOSDeviceController) Register(r chi.Router) {
	r.Get("/ios-device/toolchain/status", c.Status)
	r.Post("/ios-device/toolchain/recheck", c.Recheck)
	r.Post("/ios-device/toolchain/fetch-runtime", c.FetchRuntime)
	r.Get("/ios-device/status", c.SimulatorStatus)
	r.Post("/ios-device/start", c.StartSimulator)
	r.Post("/ios-device/stop", c.StopSimulator)
}
