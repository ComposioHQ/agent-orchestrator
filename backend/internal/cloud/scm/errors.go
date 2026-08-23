package scm

import "errors"

var (
	ErrNotConfigured             = errors.New("cloud scm: github webhook is not configured")
	ErrInvalidSignature          = errors.New("cloud scm: webhook signature is invalid")
	ErrPayloadTooLarge           = errors.New("cloud scm: webhook payload is too large")
	ErrInvalidWebhookHeaders     = errors.New("cloud scm: webhook event and delivery id are required")
	ErrWebhookReceiptUnavailable = errors.New("cloud scm: verified webhook receipt is unavailable")
	ErrWebhookLeaseLost          = errors.New("cloud scm: webhook processing lease is no longer active")
)
