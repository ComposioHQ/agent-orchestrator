package scm

import "errors"

// ErrNotConfigured and the related values classify stable SCM boundary failures.
var (
	ErrNotConfigured             = errors.New("cloud scm: github webhook is not configured")
	ErrInvalidSignature          = errors.New("cloud scm: webhook signature is invalid")
	ErrPayloadTooLarge           = errors.New("cloud scm: webhook payload is too large")
	ErrInvalidWebhookHeaders     = errors.New("cloud scm: webhook event and delivery id are required")
	ErrWebhookReceiptUnavailable = errors.New("cloud scm: verified webhook receipt is unavailable")
	ErrWebhookLeaseLost          = errors.New("cloud scm: webhook processing lease is no longer active")
	ErrInvalidState              = errors.New("cloud scm: install state is invalid or expired")
	ErrInstallationNotFound      = errors.New("cloud scm: installation not found")
	ErrInstallationClaimed       = errors.New("cloud scm: installation belongs to another organization")
	ErrInstallationInactive      = errors.New("cloud scm: installation is not active")
	ErrRepositoryNotAllowed      = errors.New("cloud scm: repository is not allowlisted")
	ErrInvalidRepository         = errors.New("cloud scm: repository must be owner/name")
	ErrSandboxNotAuthorized      = errors.New("cloud scm: sandbox is not authorized for this tenant")
)
