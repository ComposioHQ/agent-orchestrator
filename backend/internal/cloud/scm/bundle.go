package scm

import (
	"errors"
	"net/http"
	"strings"
)

// BundleStore is the full persistence surface the SCM boundary needs. It is
// satisfied by *postgres.Store.
type BundleStore interface {
	LinkStore
	BrokerStore
	WebhookStore
}

// Bundle is every SCM component the control plane wires: the install/link
// service for HTTP, the broker for sandbox bootstrap and observation, and the
// webhook processor. Webhook is nil when no webhook secret is configured.
type Bundle struct {
	App     *AppClient
	Link    *LinkService
	Broker  *Broker
	Webhook *WebhookProcessor
}

// BundleOptions configures the SCM boundary from validated deployment config.
type BundleOptions struct {
	AppID             int64
	AppSlug           string
	PrivateKeyPEM     []byte
	WebhookSecret     []byte
	OAuthClientID     string
	OAuthClientSecret string
	APIBase           string
	WebBase           string
	Store             BundleStore
	HTTPClient        *http.Client
	// Sink receives verified webhook observations. Nil means deliveries are
	// still verified, deduplicated, and applied to installation state, but no
	// observation is scheduled.
	Sink ObservationSink
}

// NewBundle constructs the SCM boundary. It returns ErrNotConfigured when no
// GitHub App is configured, which callers treat as "cloud SCM is off" rather
// than as a startup failure.
func NewBundle(options BundleOptions) (*Bundle, error) {
	if options.AppID <= 0 || strings.TrimSpace(options.AppSlug) == "" || len(options.PrivateKeyPEM) == 0 {
		return nil, ErrNotConfigured
	}
	if options.Store == nil {
		return nil, errors.New("cloud scm: bundle requires a store")
	}
	credentials, err := NewAppCredentials(options.AppID, options.AppSlug, options.PrivateKeyPEM)
	if err != nil {
		return nil, err
	}
	app, err := NewAppClient(AppClientOptions{
		Credentials:       credentials,
		HTTPClient:        options.HTTPClient,
		APIBase:           options.APIBase,
		WebBase:           options.WebBase,
		OAuthClientID:     options.OAuthClientID,
		OAuthClientSecret: options.OAuthClientSecret,
	})
	if err != nil {
		return nil, err
	}
	link, err := NewLinkService(app, options.Store)
	if err != nil {
		return nil, err
	}
	broker, err := NewBroker(app, options.Store)
	if err != nil {
		return nil, err
	}
	bundle := &Bundle{App: app, Link: link, Broker: broker}
	if len(options.WebhookSecret) > 0 {
		webhook, webhookErr := NewWebhookProcessor(options.WebhookSecret, options.Store, options.Sink)
		if webhookErr != nil {
			return nil, webhookErr
		}
		bundle.Webhook = webhook
	}
	return bundle, nil
}
