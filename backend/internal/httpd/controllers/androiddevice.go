package controllers

import (
	"context"
	"net/http"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

// AndroidDeviceService is the daemon-side SDK acquisition surface
// AndroidDeviceController depends on. The concrete implementation (daemon
// wiring) closes over AO's fixed manifest/download URLs, host platform, and
// target API level/tag, so Setup's only caller-supplied input is consent.
type AndroidDeviceService interface {
	Status() AndroidSDKStatusResponse
	// Setup starts (or reports the outcome of) downloading and installing the
	// Android SDK. acceptLicenses must be true or the caller should not call
	// this at all — the controller itself rejects false before reaching here.
	Setup(ctx context.Context, acceptLicenses bool) error

	// DeviceStatus reports the lifecycle state of AO's single, shared,
	// persistent emulator process (distinct from Status, which reports SDK
	// install state).
	DeviceStatus() AndroidEmulatorStatusResponse
	// StartDevice boots the emulator; returns immediately, poll DeviceStatus
	// for progress.
	StartDevice(ctx context.Context) error
	// StopDevice kills the running emulator, if any.
	StopDevice(ctx context.Context) error

	// SubscribeFrames returns a live channel of PNG frames from the running
	// device, or an error if it isn't currently subscribable (e.g. not
	// running). The returned unsubscribe func must be called when the caller
	// stops watching (e.g. the WebSocket client disconnects).
	SubscribeFrames() (frames <-chan []byte, unsubscribe func(), err error)
	// SendInput forwards one input action (tap/swipe/key/text) to the
	// running device.
	SendInput(ctx context.Context, action AndroidInputActionRequest) error

	// Screenshot returns a single on-demand PNG capture of the current
	// screen (distinct from SubscribeFrames' live stream) -- the agent's
	// "eyes" for a one-shot "what does the screen look like right now".
	Screenshot(ctx context.Context) ([]byte, error)
	// InspectUI returns the current on-screen UI hierarchy, structured
	// rather than a flat image -- the agent's "what's tappable" tool.
	InspectUI(ctx context.Context) (AndroidUINode, error)
}

// AndroidDeviceController exposes the loopback-only Android SDK setup API.
type AndroidDeviceController struct {
	Svc AndroidDeviceService
}

// Register adds the Android SDK status/setup and device lifecycle routes to
// the API router.
func (c *AndroidDeviceController) Register(r chi.Router) {
	r.Get("/android-device/sdk/status", c.status)
	r.Post("/android-device/sdk/setup", c.setup)
	r.Get("/android-device/status", c.deviceStatus)
	r.Post("/android-device/start", c.startDevice)
	r.Post("/android-device/stop", c.stopDevice)
	r.Get("/android-device/stream", c.stream)
	r.Post("/android-device/input", c.input)
	r.Get("/android-device/screenshot", c.screenshot)
	r.Get("/android-device/ui-tree", c.uiTree)
}

func (c *AndroidDeviceController) status(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodGet, "/api/v1/android-device/sdk/status")
		return
	}
	envelope.WriteJSON(w, http.StatusOK, c.Svc.Status())
}

func (c *AndroidDeviceController) setup(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodPost, "/api/v1/android-device/sdk/setup")
		return
	}
	var in AndroidSDKSetupRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if !in.AcceptLicenses {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "LICENSE_ACCEPTANCE_REQUIRED",
			"acceptLicenses must be true: AO downloads and installs the Android SDK, including accepting its license, only on explicit request", nil)
		return
	}
	if err := c.Svc.Setup(r.Context(), true); err != nil {
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "ANDROID_SDK_SETUP_CONFLICT", err.Error(), nil)
		return
	}
	envelope.WriteJSON(w, http.StatusAccepted, c.Svc.Status())
}

func (c *AndroidDeviceController) deviceStatus(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodGet, "/api/v1/android-device/status")
		return
	}
	envelope.WriteJSON(w, http.StatusOK, c.Svc.DeviceStatus())
}

func (c *AndroidDeviceController) startDevice(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodPost, "/api/v1/android-device/start")
		return
	}
	if err := c.Svc.StartDevice(r.Context()); err != nil {
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "ANDROID_DEVICE_START_CONFLICT", err.Error(), nil)
		return
	}
	envelope.WriteJSON(w, http.StatusAccepted, c.Svc.DeviceStatus())
}

func (c *AndroidDeviceController) stopDevice(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodPost, "/api/v1/android-device/stop")
		return
	}
	if err := c.Svc.StopDevice(r.Context()); err != nil {
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "ANDROID_DEVICE_STOP_CONFLICT", err.Error(), nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, c.Svc.DeviceStatus())
}

// stream upgrades to a WebSocket and relays PNG frames from the running
// device as binary messages, one per frame, until the client disconnects.
// The subscribe check happens before the WebSocket upgrade so a "not
// running" refusal can still be a normal HTTP error response (once upgraded,
// only the WS close frame remains available to signal an error).
func (c *AndroidDeviceController) stream(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodGet, "/api/v1/android-device/stream")
		return
	}
	frames, unsubscribe, err := c.Svc.SubscribeFrames()
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "ANDROID_DEVICE_STREAM_UNAVAILABLE", err.Error(), nil)
		return
	}
	defer unsubscribe()

	// InsecureSkipVerify: the daemon binds loopback only and the desktop
	// renderer's origin differs from the loopback host, mirroring the
	// terminal mux's same reasoning (see terminal_mux.go).
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "stream closed")

	// This connection is write-only from the server's side (frames out, no
	// client messages expected), so r.Context() alone won't observe the
	// client disconnecting -- the WS upgrade takes the connection out of the
	// normal HTTP request lifecycle. CloseRead starts a background reader
	// that both keeps control frames (ping/pong/close) flowing and cancels
	// the returned context as soon as the peer closes, which is exactly the
	// signal this loop needs to stop promptly instead of blocking forever.
	ctx := conn.CloseRead(r.Context())
	for {
		select {
		case <-ctx.Done():
			return
		case frame, ok := <-frames:
			if !ok {
				return
			}
			if err := conn.Write(ctx, websocket.MessageBinary, frame); err != nil {
				return
			}
		}
	}
}

func (c *AndroidDeviceController) input(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodPost, "/api/v1/android-device/input")
		return
	}
	var in AndroidInputActionRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if err := c.Svc.SendInput(r.Context(), in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "ANDROID_DEVICE_INPUT_CONFLICT", err.Error(), nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, AndroidInputActionResponse{OK: true})
}

func (c *AndroidDeviceController) screenshot(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodGet, "/api/v1/android-device/screenshot")
		return
	}
	png, err := c.Svc.Screenshot(r.Context())
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "ANDROID_DEVICE_SCREENSHOT_CONFLICT", err.Error(), nil)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(png)
}

func (c *AndroidDeviceController) uiTree(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodGet, "/api/v1/android-device/ui-tree")
		return
	}
	tree, err := c.Svc.InspectUI(r.Context())
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "ANDROID_DEVICE_UI_TREE_CONFLICT", err.Error(), nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, tree)
}
