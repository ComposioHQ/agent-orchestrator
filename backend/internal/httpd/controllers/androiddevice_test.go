package controllers_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
)

type fakeAndroidDeviceService struct {
	status       controllers.AndroidSDKStatusResponse
	setupErr     error
	setupCalls   int
	lastAccepted bool

	deviceStatus controllers.AndroidEmulatorStatusResponse
	startErr     error
	startCalls   int
	stopErr      error
	stopCalls    int

	frames        chan []byte
	subscribeErr  error
	unsubscribed  bool
	sendInputErr  error
	lastInput     controllers.AndroidInputActionRequest
	sendInputCall int

	screenshotBytes []byte
	screenshotErr   error
	uiTree          controllers.AndroidUINode
	uiTreeErr       error
}

func (f *fakeAndroidDeviceService) Screenshot(_ context.Context) ([]byte, error) {
	return f.screenshotBytes, f.screenshotErr
}

func (f *fakeAndroidDeviceService) InspectUI(_ context.Context) (controllers.AndroidUINode, error) {
	return f.uiTree, f.uiTreeErr
}

func (f *fakeAndroidDeviceService) Status() controllers.AndroidSDKStatusResponse { return f.status }

func (f *fakeAndroidDeviceService) Setup(_ context.Context, acceptLicenses bool) error {
	f.setupCalls++
	f.lastAccepted = acceptLicenses
	return f.setupErr
}

func (f *fakeAndroidDeviceService) DeviceStatus() controllers.AndroidEmulatorStatusResponse {
	return f.deviceStatus
}

func (f *fakeAndroidDeviceService) StartDevice(_ context.Context) error {
	f.startCalls++
	return f.startErr
}

func (f *fakeAndroidDeviceService) StopDevice(_ context.Context) error {
	f.stopCalls++
	return f.stopErr
}

func (f *fakeAndroidDeviceService) SubscribeFrames() (<-chan []byte, func(), error) {
	if f.subscribeErr != nil {
		return nil, nil, f.subscribeErr
	}
	return f.frames, func() { f.unsubscribed = true }, nil
}

func (f *fakeAndroidDeviceService) SendInput(_ context.Context, action controllers.AndroidInputActionRequest) error {
	f.sendInputCall++
	f.lastInput = action
	return f.sendInputErr
}

func androidDeviceServer(t *testing.T, svc controllers.AndroidDeviceService) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Sessions:      newFakeSessionService(),
		AndroidDevice: svc,
	}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

func TestAndroidDeviceStatus(t *testing.T) {
	svc := &fakeAndroidDeviceService{status: controllers.AndroidSDKStatusResponse{State: "not_installed"}}
	srv := androidDeviceServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/android-device/sdk/status", "")
	if status != http.StatusOK || !containsAll(body, `"state":"not_installed"`) {
		t.Fatalf("status = %d body=%s", status, body)
	}
}

func TestAndroidDeviceSetupRequiresAcceptLicenses(t *testing.T) {
	svc := &fakeAndroidDeviceService{}
	srv := androidDeviceServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/android-device/sdk/setup", `{"acceptLicenses":false}`)
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s, want 400 when acceptLicenses is false", status, body)
	}
	if svc.setupCalls != 0 {
		t.Errorf("Setup was called %d times, want 0 (request must be rejected before reaching the service)", svc.setupCalls)
	}
}

func TestAndroidDeviceSetupForwardsAcceptedConsent(t *testing.T) {
	svc := &fakeAndroidDeviceService{}
	srv := androidDeviceServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/android-device/sdk/setup", `{"acceptLicenses":true}`)
	if status != http.StatusAccepted {
		t.Fatalf("status = %d body=%s, want 202 Accepted (async setup)", status, body)
	}
	if svc.setupCalls != 1 || !svc.lastAccepted {
		t.Errorf("Setup calls=%d lastAccepted=%v, want 1 call with true", svc.setupCalls, svc.lastAccepted)
	}
}

func TestAndroidDeviceSetupPropagatesServiceError(t *testing.T) {
	svc := &fakeAndroidDeviceService{setupErr: errors.New("install already in progress")}
	srv := androidDeviceServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/android-device/sdk/setup", `{"acceptLicenses":true}`)
	if status != http.StatusConflict {
		t.Fatalf("status = %d body=%s, want 409 Conflict", status, body)
	}
}

func TestAndroidDeviceDeviceStatus(t *testing.T) {
	svc := &fakeAndroidDeviceService{deviceStatus: controllers.AndroidEmulatorStatusResponse{State: "running", AccelAvailable: true}}
	srv := androidDeviceServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/android-device/status", "")
	if status != http.StatusOK || !containsAll(body, `"state":"running"`, `"accelAvailable":true`) {
		t.Fatalf("status = %d body=%s", status, body)
	}
}

func TestAndroidDeviceStart(t *testing.T) {
	svc := &fakeAndroidDeviceService{}
	srv := androidDeviceServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/android-device/start", "")
	if status != http.StatusAccepted {
		t.Fatalf("status = %d body=%s, want 202 Accepted", status, body)
	}
	if svc.startCalls != 1 {
		t.Errorf("StartDevice calls = %d, want 1", svc.startCalls)
	}
}

func TestAndroidDeviceStartPropagatesServiceError(t *testing.T) {
	svc := &fakeAndroidDeviceService{startErr: errors.New("already booting")}
	srv := androidDeviceServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/android-device/start", "")
	if status != http.StatusConflict {
		t.Fatalf("status = %d body=%s, want 409 Conflict", status, body)
	}
}

func TestAndroidDeviceStop(t *testing.T) {
	svc := &fakeAndroidDeviceService{}
	srv := androidDeviceServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/android-device/stop", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d body=%s, want 200 OK", status, body)
	}
	if svc.stopCalls != 1 {
		t.Errorf("StopDevice calls = %d, want 1", svc.stopCalls)
	}
}

func TestAndroidDeviceNilServiceReturns501ForDeviceRoutes(t *testing.T) {
	srv := androidDeviceServer(t, nil)

	for _, req := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/android-device/status"},
		{http.MethodPost, "/api/v1/android-device/start"},
		{http.MethodPost, "/api/v1/android-device/stop"},
		{http.MethodPost, "/api/v1/android-device/input"},
		{http.MethodGet, "/api/v1/android-device/screenshot"},
		{http.MethodGet, "/api/v1/android-device/ui-tree"},
	} {
		_, status, _ := doRequest(t, srv, req.method, req.path, "")
		if status != http.StatusNotImplemented {
			t.Errorf("%s %s = %d, want 501", req.method, req.path, status)
		}
	}
}

func TestAndroidDeviceInputForwardsAction(t *testing.T) {
	svc := &fakeAndroidDeviceService{}
	srv := androidDeviceServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/android-device/input", `{"type":"tap","x":10,"y":20}`)
	if status != http.StatusOK {
		t.Fatalf("status = %d body=%s, want 200 OK", status, body)
	}
	if svc.sendInputCall != 1 || svc.lastInput.Type != "tap" || svc.lastInput.X != 10 || svc.lastInput.Y != 20 {
		t.Errorf("SendInput called with %+v (count=%d), want one call with type=tap x=10 y=20", svc.lastInput, svc.sendInputCall)
	}
}

func TestAndroidDeviceInputPropagatesServiceError(t *testing.T) {
	svc := &fakeAndroidDeviceService{sendInputErr: errors.New("device not running")}
	srv := androidDeviceServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/android-device/input", `{"type":"tap","x":10,"y":20}`)
	if status != http.StatusConflict {
		t.Fatalf("status = %d body=%s, want 409 Conflict", status, body)
	}
}

func TestAndroidDeviceInputRejectsInvalidJSON(t *testing.T) {
	svc := &fakeAndroidDeviceService{}
	srv := androidDeviceServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/android-device/input", `not json`)
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s, want 400 Bad Request", status, body)
	}
	if svc.sendInputCall != 0 {
		t.Errorf("SendInput was called %d times for invalid JSON, want 0", svc.sendInputCall)
	}
}

func TestAndroidDeviceStreamRelaysFrames(t *testing.T) {
	frames := make(chan []byte, 1)
	frames <- []byte{0x89, 'P', 'N', 'G', 1, 2, 3}
	svc := &fakeAndroidDeviceService{frames: frames}
	srv := androidDeviceServer(t, svc)

	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/v1/android-device/stream"
	c, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatalf("dial /android-device/stream: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "test done")

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	msgType, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	if msgType != websocket.MessageBinary {
		t.Errorf("message type = %v, want binary", msgType)
	}
	if string(data) != string([]byte{0x89, 'P', 'N', 'G', 1, 2, 3}) {
		t.Errorf("frame = %v, want the PNG bytes", data)
	}
}

func TestAndroidDeviceStreamRejectsWhenNotSubscribable(t *testing.T) {
	svc := &fakeAndroidDeviceService{subscribeErr: errors.New("device not running")}
	srv := androidDeviceServer(t, svc)

	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/v1/android-device/stream"
	_, resp, err := websocket.Dial(context.Background(), url, nil)
	if err == nil {
		t.Fatal("dial: want the upgrade to be refused when the device isn't subscribable, got a successful connection")
	}
	if resp != nil && resp.StatusCode != http.StatusConflict {
		t.Errorf("status = %d, want 409 Conflict", resp.StatusCode)
	}
}

func TestAndroidDeviceScreenshotReturnsRawPNG(t *testing.T) {
	pngBytes := []byte{0x89, 'P', 'N', 'G', 1, 2, 3}
	svc := &fakeAndroidDeviceService{screenshotBytes: pngBytes}
	srv := androidDeviceServer(t, svc)

	resp, err := http.Get(srv.URL + "/api/v1/android-device/screenshot")
	if err != nil {
		t.Fatalf("GET screenshot: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", ct)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != string(pngBytes) {
		t.Errorf("body = %v, want the raw PNG bytes", body)
	}
}

func TestAndroidDeviceScreenshotPropagatesServiceError(t *testing.T) {
	svc := &fakeAndroidDeviceService{screenshotErr: errors.New("device not running")}
	srv := androidDeviceServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/android-device/screenshot", "")
	if status != http.StatusConflict {
		t.Fatalf("status = %d body=%s, want 409 Conflict", status, body)
	}
}

func TestAndroidDeviceUITreeReturnsStructuredJSON(t *testing.T) {
	svc := &fakeAndroidDeviceService{uiTree: controllers.AndroidUINode{
		Class:     "android.widget.Button",
		Text:      "Close app",
		Clickable: true,
		Bounds:    controllers.AndroidUIBounds{X1: 70, Y1: 1142, X2: 1010, Y2: 1268},
	}}
	srv := androidDeviceServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/android-device/ui-tree", "")
	if status != http.StatusOK || !containsAll(body, `"text":"Close app"`, `"clickable":true`, `"x1":70`) {
		t.Fatalf("status = %d body=%s", status, body)
	}
}

func TestAndroidDeviceUITreePropagatesServiceError(t *testing.T) {
	svc := &fakeAndroidDeviceService{uiTreeErr: errors.New("uiautomator dump failed")}
	srv := androidDeviceServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/android-device/ui-tree", "")
	if status != http.StatusConflict {
		t.Fatalf("status = %d body=%s, want 409 Conflict", status, body)
	}
}
