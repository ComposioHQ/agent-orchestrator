package controllers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/iossdk"
)

type IOSDeviceController struct{}

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
}
