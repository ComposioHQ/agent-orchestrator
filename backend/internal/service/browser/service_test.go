package browser

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/browserruntime"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

type fakeSessions struct {
	session domain.Session
	err     error
}

func (f fakeSessions) Get(_ context.Context, _ domain.SessionID) (domain.Session, error) {
	return f.session, f.err
}

type fakeRuntime struct {
	action   string
	args     map[string]interface{}
	err      error
	failOnce error
	calls    int
}

func (f *fakeRuntime) Status() browserruntime.Status {
	return browserruntime.Status{Connected: true}
}

func (f *fakeRuntime) Execute(
	_ context.Context,
	_ domain.SessionID,
	action string,
	args map[string]interface{},
) (browserruntime.Result, error) {
	f.action = action
	f.args = args
	f.calls++
	if f.failOnce != nil {
		err := f.failOnce
		f.failOnce = nil
		return browserruntime.Result{}, err
	}
	if f.err != nil {
		return browserruntime.Result{}, f.err
	}
	if action == "__status" {
		return browserruntime.Result{RequestID: "r-status", Value: map[string]interface{}{
			"state": "ready", "provider": "electron",
			"target": map[string]interface{}{"tabId": "t1", "url": "http://localhost:3000", "title": "App", "loading": false, "snapshotGeneration": 2},
		}}, nil
	}
	if action == "observe" {
		return browserruntime.Result{RequestID: "r-observe", Value: map[string]interface{}{
			"state": "ready", "provider": "electron", "untrustedExternalContent": true,
			"target":   map[string]interface{}{"tabId": "t1", "url": "http://localhost:3000", "title": "App", "loading": false, "snapshotGeneration": 3},
			"snapshot": map[string]interface{}{"url": "http://localhost:3000", "title": "App", "generation": 3, "text": "snapshot", "elements": []interface{}{}, "totalNodes": 1, "truncated": false, "untrustedExternalContent": true},
		}}, nil
	}
	return browserruntime.Result{RequestID: "r1"}, nil
}

func TestServiceRequiresOwningCapabilityAndLiveSession(t *testing.T) {
	authority := &Authority{key: []byte("01234567890123456789012345678901")}
	runtime := &fakeRuntime{}
	service := New(fakeSessions{session: domain.Session{SessionRecord: domain.SessionRecord{ID: "s1"}}}, runtime, authority)

	if _, err := service.Status(context.Background(), "s1", "wrong"); apiErrorCode(err) != "BROWSER_CAPABILITY_INVALID" {
		t.Fatalf("wrong capability error = %v", err)
	}
	token := authority.Token("s1")
	status, err := service.Status(context.Background(), "s1", token)
	if err != nil {
		t.Fatalf("valid capability: %v", err)
	}
	if status.State != browserruntime.ReadinessReady || status.Target == nil || status.Target.TabID != "t1" {
		t.Fatalf("status = %#v", status)
	}
	if _, action, err := service.Execute(context.Background(), "s1", token, " SNAPSHOT ", nil); err != nil || action != "snapshot" || runtime.action != "snapshot" {
		t.Fatalf("execute action=%q runtime=%q err=%v", action, runtime.action, err)
	}
	if _, _, err := service.Execute(context.Background(), "s1", token, "eval", nil); apiErrorCode(err) != "BROWSER_ACTION_UNSUPPORTED" {
		t.Fatalf("unsupported action error = %v", err)
	}
	if _, _, err := service.Execute(context.Background(), "s1", token, "click", map[string]interface{}{"ref": "e1"}); apiErrorCode(err) != "BROWSER_PRECONDITION_REQUIRED" {
		t.Fatalf("missing browser precondition error = %v", err)
	}
	strictArgs := map[string]interface{}{
		"ref": "e1",
		"expectedState": map[string]interface{}{
			"tabId": "t1", "expectedUrl": "http://localhost/page", "snapshotGeneration": 3,
		},
	}
	if _, action, err := service.Execute(context.Background(), "s1", token, "click", strictArgs); err != nil || action != "click" || runtime.action != "click" {
		t.Fatalf("strict browser action=%q runtime=%q err=%v", action, runtime.action, err)
	}
	externalArgs := map[string]interface{}{
		"ref": "e1",
		"expectedState": map[string]interface{}{
			"tabId": "t1", "expectedUrl": "https://example.com/account", "snapshotGeneration": 3,
		},
	}
	if _, _, err := service.Execute(context.Background(), "s1", token, "click", externalArgs); apiErrorCode(err) != "BROWSER_CONFIRMATION_REQUIRED" {
		t.Fatalf("external confirmation error = %v", err)
	}
	externalArgs["confirmed"] = true
	if _, _, err := service.Execute(context.Background(), "s1", token, "click", externalArgs); err != nil {
		t.Fatalf("confirmed external action: %v", err)
	}
	runtime.err = browserruntime.ErrOutcomeUnknown
	if _, _, err := service.Execute(context.Background(), "s1", token, "click", strictArgs); browserCommandErrorCode(err) != "BROWSER_OUTCOME_UNKNOWN" {
		t.Fatalf("unknown mutation outcome error = %v", err)
	}
	runtime.err = nil
	runtime.failOnce = browserruntime.ErrUnavailable
	beforeCalls := runtime.calls
	if _, _, err := service.Execute(context.Background(), "s1", token, "snapshot", nil); err != nil || runtime.calls-beforeCalls != 2 {
		t.Fatalf("bounded read recovery calls=%d err=%v", runtime.calls-beforeCalls, err)
	}

	terminated := New(
		fakeSessions{session: domain.Session{SessionRecord: domain.SessionRecord{ID: "s1", IsTerminated: true}}},
		runtime,
		authority,
	)
	if _, err := terminated.Status(context.Background(), "s1", token); apiErrorCode(err) != "SESSION_TERMINATED" {
		t.Fatalf("terminated error = %v", err)
	}
}

func browserCommandErrorCode(err error) string {
	var commandErr browserruntime.CommandError
	if errors.As(err, &commandErr) {
		return commandErr.Code
	}
	return ""
}

func TestObserveUsesTypedOptionsWithoutSendingSessionInput(t *testing.T) {
	authority := &Authority{key: []byte("01234567890123456789012345678901")}
	runtime := &fakeRuntime{}
	service := New(fakeSessions{session: domain.Session{SessionRecord: domain.SessionRecord{ID: "s1"}}}, runtime, authority)

	result, observation, err := service.Observe(context.Background(), "s1", authority.Token("s1"), browserruntime.ObserveOptions{
		InteractiveOnly: true, IncludeScreenshot: true, IncludeProblems: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.RequestID != "r-observe" || observation.State != browserruntime.ReadinessReady || observation.Target.TabID != "t1" {
		t.Fatalf("result=%#v observation=%#v", result, observation)
	}
	if runtime.action != "observe" || runtime.args["interactiveOnly"] != true || runtime.args["includeScreenshot"] != true || runtime.args["includeProblems"] != true {
		t.Fatalf("runtime call = %q %#v", runtime.action, runtime.args)
	}
}

func TestAuthorityPersistsStableSecret(t *testing.T) {
	dir := t.TempDir()
	first, err := LoadAuthority(dir)
	if err != nil {
		t.Fatal(err)
	}
	second, err := LoadAuthority(dir)
	if err != nil {
		t.Fatal(err)
	}
	if first.Token("s1") == "" || first.Token("s1") != second.Token("s1") || first.Token("s1") == first.Token("s2") {
		t.Fatal("authority tokens are not stable and session-scoped")
	}
}

func apiErrorCode(err error) string {
	var target *apierr.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}
