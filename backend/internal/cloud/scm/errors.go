package scm

import "errors"

// Sentinel errors for the SCM credential boundary. Handlers map these to
// stable error codes; none of them ever carries credential material.
var (
	// ErrNotConfigured means the GitHub App is not configured for this
	// deployment, so no SCM flow can run.
	ErrNotConfigured = errors.New("cloud scm: github app is not configured")
	// ErrInstallationNotFound means no linked installation matches.
	ErrInstallationNotFound = errors.New("cloud scm: installation not found")
	// ErrInstallationInactive means the installation is suspended or removed.
	ErrInstallationInactive = errors.New("cloud scm: installation is not active")
	// ErrRepositoryNotAllowed means the repository is not on the
	// organization's allowlist for any linked installation.
	ErrRepositoryNotAllowed = errors.New("cloud scm: repository is not allowlisted")
	// ErrInvalidRepository means the caller supplied a repository reference
	// that is not a parseable owner/name pair.
	ErrInvalidRepository = errors.New("cloud scm: repository must be owner/name")
	// ErrInvalidState means an install-redirect state token is unknown,
	// expired, or already consumed.
	ErrInvalidState = errors.New("cloud scm: install state is invalid or expired")
	// ErrInstallationNotOwned means the user completing a link does not have
	// access to the installation they are trying to link.
	ErrInstallationNotOwned = errors.New("cloud scm: installation is not accessible to this user")
	// ErrInstallationClaimed means the installation is already linked to a
	// different AO organization.
	ErrInstallationClaimed = errors.New("cloud scm: installation is already linked to another organization")
	// ErrInvalidSignature means a webhook body failed HMAC verification.
	ErrInvalidSignature = errors.New("cloud scm: webhook signature is invalid")
	// ErrDuplicateDelivery means a webhook delivery id was already processed.
	ErrDuplicateDelivery = errors.New("cloud scm: webhook delivery already processed")
	// ErrProviderRejected means GitHub refused a control-plane request.
	ErrProviderRejected = errors.New("cloud scm: provider rejected the request")
)
