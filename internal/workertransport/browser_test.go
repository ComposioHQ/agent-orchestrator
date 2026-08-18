package workertransport

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Untrivial-ai/ao-cloud/internal/worker"
)

func TestFetchBrowserUsesTheWorkerNetwork(t *testing.T) {
	t.Parallel()
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/app" || r.URL.RawQuery != "theme=dark" {
			t.Fatalf("request target = %s, want /app?theme=dark", r.URL.String())
		}
		if got := r.Header.Get("Accept-Language"); got != "en-US" {
			t.Fatalf("Accept-Language = %q, want en-US", got)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != "hello" {
			t.Fatalf("request body = %q, want hello", body)
		}
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("from the VM"))
	}))
	defer target.Close()

	response, err := fetchBrowser(context.Background(), worker.BrowserFetchRequest{
		URL:    target.URL + "/app?theme=dark",
		Method: http.MethodPost,
		Headers: map[string]string{
			"Accept-Language": "en-US",
		},
		Body: []byte("hello"),
	})
	if err != nil {
		t.Fatalf("fetchBrowser: %v", err)
	}
	if response.Status != http.StatusCreated {
		t.Fatalf("status = %d, want %d", response.Status, http.StatusCreated)
	}
	if response.ContentType != "text/plain" {
		t.Fatalf("content type = %q, want text/plain", response.ContentType)
	}
	if string(response.Body) != "from the VM" {
		t.Fatalf("response body = %q", response.Body)
	}
}

func TestFetchBrowserDoesNotAllowNonHTTPURLs(t *testing.T) {
	t.Parallel()
	if _, err := fetchBrowser(context.Background(), worker.BrowserFetchRequest{URL: "file:///workspace/repository/secret"}); err == nil {
		t.Fatal("fetchBrowser accepted a non-HTTP URL")
	}
}

func TestFetchBrowserRetainsCookiesInTheWorker(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if cookie, err := r.Cookie("ao-browser-smoke"); err == nil && cookie.Value == "ready" {
			_, _ = w.Write([]byte("signed in"))
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "ao-browser-smoke", Value: "ready", Path: "/"})
		_, _ = w.Write([]byte("set cookie"))
	}))
	defer target.Close()

	if _, err := fetchBrowser(context.Background(), worker.BrowserFetchRequest{URL: target.URL}); err != nil {
		t.Fatalf("first browser fetch: %v", err)
	}
	response, err := fetchBrowser(context.Background(), worker.BrowserFetchRequest{URL: target.URL})
	if err != nil {
		t.Fatalf("second browser fetch: %v", err)
	}
	if string(response.Body) != "signed in" {
		t.Fatalf("browser did not retain the VM cookie: %q", response.Body)
	}
}
