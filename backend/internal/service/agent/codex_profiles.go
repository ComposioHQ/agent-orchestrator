package agent

import (
	"context"
	"errors"
	"log/slog"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/shellterm"
)

const (
	codexProfileDisplayTTL     = 5 * time.Minute
	codexProfileLaunchTTL      = 30 * time.Second
	codexProfileAuthTimeout    = 10 * time.Second
	codexProfileLoginLifetime  = 15 * time.Minute
	codexProfileLoginRetention = 5 * time.Minute
	codexProfileProcessLimit   = 2
)

// CodexProfiles is the cached, display-safe profile catalog and capability view.
type CodexProfiles struct {
	Profiles     []domain.CodexProfileSnapshot   `json:"profiles"`
	Capabilities domain.CodexProfileCapabilities `json:"capabilities"`
}

// CodexProfileLoginStart contains the ephemeral browser-login operation handles.
type CodexProfileLoginStart struct {
	OperationID string                         `json:"operationId"`
	ProfileID   string                         `json:"profileId"`
	Status      domain.CodexProfileLoginStatus `json:"status" enum:"pending,completed,cancelled,failed"`
	AuthURL     string                         `json:"authUrl"`
}

// CodexProfileLoginTerminalStart identifies the standalone terminal opened for
// one profile's native Codex login flow.
type CodexProfileLoginTerminalStart struct {
	ProfileID     string                  `json:"profileId"`
	ShellTerminal shellterm.ShellTerminal `json:"shellTerminal"`
}

type codexProfileLoginTerminalOpener interface {
	OpenCommandTerminal(context.Context, shellterm.OpenCommandTerminalInput) (shellterm.ShellTerminal, error)
}

type profileAuthCall struct{ done chan struct{} }

type profileAuthState struct {
	invalidated bool
	checking    bool
	failures    int
	nextRetryAt time.Time
	generation  uint64
	call        *profileAuthCall
}

type codexProfileManager struct {
	ctx                 context.Context
	catalog             *codexProfileCatalog
	factory             ports.CodexAccountClientFactory
	logger              *slog.Logger
	now                 func() time.Time
	newID               func() string
	processes           chan struct{}
	executable          func() (string, error)
	loginTerminalOpener codexProfileLoginTerminalOpener

	mu            sync.Mutex
	auth          map[string]*profileAuthState
	capabilities  domain.CodexProfileCapabilities
	logins        map[string]*codexLoginOperation
	loginStarting map[string]struct{}
}

type codexLoginOperation struct {
	id, profileID, loginID, authURL string
	startedAt                       time.Time
	status                          domain.CodexProfileLoginStatus
	reasonCode, reason              string
	profile                         *domain.CodexProfileSnapshot
	client                          ports.CodexAccountClient
	cancel                          context.CancelFunc
	watchers                        map[chan domain.CodexProfileLoginEvent]struct{}
	terminal                        bool
}

func newCodexProfileManager(ctx context.Context, root, existingHome string, factory ports.CodexAccountClientFactory, logger *slog.Logger) *codexProfileManager {
	if ctx == nil {
		ctx = context.Background()
	}
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &codexProfileManager{
		ctx: ctx, catalog: newCodexProfileCatalog(root, existingHome, logger), factory: factory, logger: logger,
		now: func() time.Time { return time.Now().UTC() }, newID: uuid.NewString,
		executable: os.Executable,
		processes:  make(chan struct{}, codexProfileProcessLimit), auth: make(map[string]*profileAuthState),
		capabilities: unavailableCodexCapabilities(), logins: make(map[string]*codexLoginOperation),
		loginStarting: make(map[string]struct{}),
	}
}

func (m *codexProfileManager) openLoginTerminal(ctx context.Context, profileID string) (CodexProfileLoginTerminalStart, error) {
	record, err := m.resolveLoginTerminalProfile(ctx, profileID)
	if err != nil {
		return CodexProfileLoginTerminalStart{}, err
	}
	return m.openResolvedLoginTerminal(ctx, record)
}

func (m *codexProfileManager) resolveLoginTerminalProfile(ctx context.Context, profileID string) (codexProfileRecord, error) {
	if err := ctx.Err(); err != nil {
		return codexProfileRecord{}, err
	}
	if err := m.catalog.refresh(); err != nil {
		return codexProfileRecord{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile discovery is unavailable")
	}
	record, ok := m.catalog.record(strings.TrimSpace(profileID))
	if !ok {
		return codexProfileRecord{}, apierr.NotFound("CODEX_PROFILE_UNKNOWN", "Codex profile not found")
	}
	if record.Snapshot.Status != domain.CodexProfileStatusValid {
		return codexProfileRecord{}, apierr.Conflict("CODEX_PROFILE_INVALID", "Codex profile is not valid", map[string]any{"profileId": record.Snapshot.ID})
	}
	return record, nil
}

func (m *codexProfileManager) openResolvedLoginTerminal(ctx context.Context, record codexProfileRecord) (CodexProfileLoginTerminalStart, error) {
	if m.loginTerminalOpener == nil || m.executable == nil {
		return CodexProfileLoginTerminalStart{}, apierr.Unavailable("CODEX_PROFILE_LOGIN_TERMINAL_UNAVAILABLE", "Codex login terminal is unavailable")
	}
	executable, err := m.executable()
	if err != nil || strings.TrimSpace(executable) == "" {
		return CodexProfileLoginTerminalStart{}, apierr.Unavailable("CODEX_PROFILE_LOGIN_TERMINAL_UNAVAILABLE", "Codex login terminal is unavailable")
	}
	terminal, err := m.loginTerminalOpener.OpenCommandTerminal(ctx, shellterm.OpenCommandTerminalInput{
		Argv:       []string{executable, "codex-login"},
		Env:        map[string]string{"CODEX_HOME": record.Home},
		WorkingDir: record.Home,
		Title:      "Codex login - " + record.Snapshot.Label,
	})
	if err != nil {
		return CodexProfileLoginTerminalStart{}, apierr.Unavailable("CODEX_PROFILE_LOGIN_TERMINAL_UNAVAILABLE", "Codex login terminal could not be opened")
	}
	return CodexProfileLoginTerminalStart{ProfileID: record.Snapshot.ID, ShellTerminal: terminal}, nil
}

func unavailableCodexCapabilities() domain.CodexProfileCapabilities {
	unknown := domain.CodexCapabilityObservation{State: domain.CodexCapabilityUnknown, ReasonCode: domain.CodexCapabilityReasonUnknown, Reason: "Codex capability detection has not completed."}
	return domain.CodexProfileCapabilities{AccountRead: unknown, BrowserLogin: unknown}
}

func (m *codexProfileManager) cached() CodexProfiles {
	result, _ := m.view(nil)
	return result
}

func (m *codexProfileManager) view(profileIDs []string) (CodexProfiles, error) {
	m.mu.Lock()
	capabilities := m.capabilities
	m.mu.Unlock()
	records, err := m.catalog.recordsFor(profileIDs)
	if err != nil {
		return CodexProfiles{}, mapUnknownCodexProfile(err)
	}
	profiles := make([]domain.CodexProfileSnapshot, 0, len(records))
	for _, record := range records {
		profiles = append(profiles, record.Snapshot)
	}
	return CodexProfiles{Profiles: profiles, Capabilities: capabilities}, nil
}

func (m *codexProfileManager) detectCapabilities(ctx context.Context) domain.CodexProfileCapabilities {
	if m.factory == nil {
		return unavailableCodexCapabilities()
	}
	started := m.now()
	capabilities := m.factory.Capabilities(ctx)
	m.mu.Lock()
	m.capabilities = capabilities
	m.mu.Unlock()
	m.logger.Info("Codex profile capability check completed",
		"operation", "capability_check",
		"duration_ms", m.now().Sub(started).Milliseconds(),
		"account_read", capabilities.AccountRead.State,
		"browser_login", capabilities.BrowserLogin.State,
	)
	return capabilities
}

func (m *codexProfileManager) ensure(ctx context.Context, profileIDs []string, purpose domain.AgentReadinessPurpose, installation domain.AgentInstallationState, forceAuthenticationRefresh bool) (CodexProfiles, error) {
	if purpose != domain.AgentReadinessPurposeDisplay {
		return CodexProfiles{}, apierr.Invalid("INVALID_READINESS_PURPOSE", "Purpose must be display", map[string]any{"purpose": purpose})
	}
	if err := m.catalog.refresh(); err != nil {
		return CodexProfiles{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile discovery is unavailable")
	}
	records, err := m.catalog.recordsFor(profileIDs)
	if err != nil {
		return CodexProfiles{}, mapUnknownCodexProfile(err)
	}
	hasValidProfile := false
	for _, record := range records {
		if record.Snapshot.Status == domain.CodexProfileStatusValid {
			hasValidProfile = true
			break
		}
	}
	if !hasValidProfile {
		return m.view(profileIDs)
	}
	if installation == domain.AgentInstallationNotInstalled {
		unavailable := unavailableCodexCapabilities()
		unavailable.AccountRead.Reason = "Install Codex to discover profile authentication."
		unavailable.BrowserLogin.Reason = "Install Codex to manage profiles."
		m.mu.Lock()
		m.capabilities = unavailable
		m.mu.Unlock()
		for _, record := range records {
			if record.Snapshot.Status != domain.CodexProfileStatusValid {
				continue
			}
			m.catalog.updateSnapshot(record.Snapshot.ID, func(snapshot *domain.CodexProfileSnapshot) {
				snapshot.Authentication = skippedAuthentication(m.now())
			})
		}
		return m.view(profileIDs)
	}
	capabilities := m.detectCapabilities(ctx)
	if err := ctx.Err(); err != nil {
		return CodexProfiles{}, err
	}
	for _, record := range records {
		if record.Snapshot.Status != domain.CodexProfileStatusValid {
			continue
		}
		if capabilities.AccountRead.State == domain.CodexCapabilityUnsupported {
			if record.Snapshot.Source == domain.CodexProfileSourceManaged {
				m.catalog.updateSnapshot(record.Snapshot.ID, func(snapshot *domain.CodexProfileSnapshot) {
					snapshot.Authentication = successfulAuthentication(m.now(), domain.AgentAuthenticationUnknown, domain.AgentReadinessReasonAuthCheckUnsupported, "Structured authentication is not supported by this Codex version.")
				})
			}
			continue
		}
		if capabilities.AccountRead.State == domain.CodexCapabilityUnknown {
			m.catalog.updateSnapshot(record.Snapshot.ID, func(snapshot *domain.CodexProfileSnapshot) {
				preserveAuthenticationFailure(&snapshot.Authentication, failedAuthentication(m.now(), domain.AgentReadinessReasonAuthCheckInconclusive, "Authentication could not be checked."))
			})
			continue
		}
		if _, err := m.ensureAuthentication(ctx, record, purpose, forceAuthenticationRefresh, false); err != nil {
			return CodexProfiles{}, err
		}
	}
	return m.view(profileIDs)
}

func (m *codexProfileManager) prepareEnsure(profileIDs []string, purpose domain.AgentReadinessPurpose) (CodexProfiles, bool, error) {
	if purpose != domain.AgentReadinessPurposeDisplay {
		return CodexProfiles{}, true, apierr.Invalid("INVALID_READINESS_PURPOSE", "Purpose must be display", map[string]any{"purpose": purpose})
	}
	if err := m.catalog.refresh(); err != nil {
		return CodexProfiles{}, true, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile discovery is unavailable")
	}
	records, err := m.catalog.recordsFor(profileIDs)
	if err != nil {
		return CodexProfiles{}, true, mapUnknownCodexProfile(err)
	}
	for _, record := range records {
		if record.Snapshot.Status == domain.CodexProfileStatusValid {
			return CodexProfiles{}, false, nil
		}
	}
	result, err := m.view(profileIDs)
	return result, true, err
}

func (m *codexProfileManager) ensureAuthentication(ctx context.Context, record codexProfileRecord, purpose domain.AgentReadinessPurpose, force, refreshToken bool) (domain.AgentAuthenticationObservation, error) {
	if err := ctx.Err(); err != nil {
		return domain.AgentAuthenticationObservation{}, err
	}
	m.mu.Lock()
	state := m.auth[record.Snapshot.ID]
	if state == nil {
		state = &profileAuthState{invalidated: true}
		m.auth[record.Snapshot.ID] = state
	}
	current, _ := m.catalog.record(record.Snapshot.ID)
	ttl := codexProfileDisplayTTL
	if purpose == domain.AgentReadinessPurposeLaunch {
		ttl = codexProfileLaunchTTL
	}
	fresh := current.Snapshot.Authentication.CheckedAt != nil && m.now().Sub(*current.Snapshot.Authentication.CheckedAt) < ttl
	if !force && !state.invalidated && fresh {
		observation := current.Snapshot.Authentication
		m.mu.Unlock()
		m.logger.Debug("Codex profile authentication cache hit", "profile_id", record.Snapshot.ID, "source", record.Snapshot.Source, "purpose", purpose, "cache", "hit")
		return observation, nil
	}
	if !force && purpose == domain.AgentReadinessPurposeDisplay && !state.nextRetryAt.IsZero() && m.now().Before(state.nextRetryAt) {
		observation := current.Snapshot.Authentication
		nextRetry := state.nextRetryAt
		m.mu.Unlock()
		m.logger.Debug("Codex profile authentication retry deferred", "profile_id", record.Snapshot.ID, "source", record.Snapshot.Source, "purpose", purpose, "cache", "retry_delay", "next_retry_at", nextRetry)
		return observation, nil
	}
	if state.call != nil {
		call := state.call
		m.mu.Unlock()
		m.logger.Debug("joined Codex profile authentication check", "profile_id", record.Snapshot.ID, "source", record.Snapshot.Source, "purpose", purpose, "cache", "join")
		select {
		case <-call.done:
			latest, _ := m.catalog.record(record.Snapshot.ID)
			return latest.Snapshot.Authentication, nil
		case <-ctx.Done():
			return domain.AgentAuthenticationObservation{}, ctx.Err()
		}
	}
	call := &profileAuthCall{done: make(chan struct{})}
	state.call = call
	state.checking = true
	m.catalog.updateSnapshot(record.Snapshot.ID, func(snapshot *domain.CodexProfileSnapshot) {
		snapshot.Authentication.Freshness = domain.AgentReadinessChecking
	})
	m.mu.Unlock()
	m.logger.Info("started Codex profile authentication check", "profile_id", record.Snapshot.ID, "source", record.Snapshot.Source, "purpose", purpose, "cache", "new")
	go m.runAuthentication(record, refreshToken, call)
	select {
	case <-call.done:
		latest, _ := m.catalog.record(record.Snapshot.ID)
		return latest.Snapshot.Authentication, nil
	case <-ctx.Done():
		return domain.AgentAuthenticationObservation{}, ctx.Err()
	}
}

func (m *codexProfileManager) runAuthentication(record codexProfileRecord, refreshToken bool, call *profileAuthCall) {
	started := m.now()
	select {
	case m.processes <- struct{}{}:
		defer func() { <-m.processes }()
	case <-m.ctx.Done():
		m.finishAuthentication(record.Snapshot.ID, failedAuthentication(started, domain.AgentReadinessReasonAuthCheckFailed, "Authentication check stopped."), domain.CodexAuthMethodUnknown, nil, true, call)
		return
	}
	ctx, cancel := context.WithTimeout(m.ctx, codexProfileAuthTimeout)
	defer cancel()
	client, err := m.factory.Open(ctx, ports.CodexAccountProfile{Home: record.Home, Managed: record.Snapshot.Source == domain.CodexProfileSourceManaged})
	if err != nil {
		m.finishAuthentication(record.Snapshot.ID, failedAuthentication(started, domain.AgentReadinessReasonAuthCheckFailed, "Authentication check failed."), domain.CodexAuthMethodUnknown, nil, true, call)
		return
	}
	defer func() { _ = client.Close() }()
	account, err := client.Read(ctx, refreshToken)
	if err != nil {
		code := domain.AgentReadinessReasonAuthCheckFailed
		reason := "Authentication check failed."
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			code, reason = domain.AgentReadinessReasonAuthCheckTimeout, "Authentication check timed out."
		}
		m.finishAuthentication(record.Snapshot.ID, failedAuthentication(started, code, reason), domain.CodexAuthMethodUnknown, nil, true, call)
		return
	}
	observation := accountAuthenticationObservation(m.now(), account.Authentication)
	failed := account.Authentication == domain.AgentAuthenticationUnknown
	m.finishAuthentication(record.Snapshot.ID, observation, account.Method, account.Email, failed, call)
}

func accountAuthenticationObservation(at time.Time, state domain.AgentAuthenticationState) domain.AgentAuthenticationObservation {
	switch state {
	case domain.AgentAuthenticationAuthorized:
		return successfulAuthentication(at, state, domain.AgentReadinessReasonAuthorized, "Codex appears signed in.")
	case domain.AgentAuthenticationUnauthorized:
		return successfulAuthentication(at, state, domain.AgentReadinessReasonUnauthorized, "Codex needs authentication.")
	case domain.AgentAuthenticationNotApplicable:
		return successfulAuthentication(at, state, domain.AgentReadinessReasonAuthNotApplicable, "Codex authentication is not required.")
	default:
		return failedAuthentication(at, domain.AgentReadinessReasonAuthCheckInconclusive, "Authentication check was inconclusive.")
	}
}

func (m *codexProfileManager) finishAuthentication(profileID string, observation domain.AgentAuthenticationObservation, method domain.CodexAuthMethod, email *string, failed bool, call *profileAuthCall) {
	var nextRetryAt time.Time
	m.mu.Lock()
	state := m.auth[profileID]
	if failed {
		m.catalog.updateSnapshot(profileID, func(snapshot *domain.CodexProfileSnapshot) {
			preserveAuthenticationFailure(&snapshot.Authentication, observation)
		})
		state.failures++
		if state.failures <= len(defaultReadinessRetryDelays) {
			delay := defaultReadinessRetryDelays[state.failures-1]
			state.nextRetryAt = m.now().Add(delay)
			nextRetryAt = state.nextRetryAt
			state.generation++
			generation := state.generation
			go m.scheduleAuthenticationRetry(profileID, generation, delay)
		}
	} else {
		m.catalog.updateSnapshot(profileID, func(snapshot *domain.CodexProfileSnapshot) {
			snapshot.Authentication = observation
			snapshot.AuthMethod = method
			snapshot.AccountEmail = email
		})
		state.invalidated = false
		state.failures = 0
		state.nextRetryAt = time.Time{}
		state.generation++
	}
	state.checking = false
	state.call = nil
	close(call.done)
	m.mu.Unlock()
	duration := int64(0)
	if observation.AttemptedAt != nil {
		duration = m.now().Sub(*observation.AttemptedAt).Milliseconds()
	}
	m.logger.Info("Codex profile authentication check completed",
		"profile_id", profileID,
		"operation", "account_read",
		"duration_ms", duration,
		"outcome", observation.State,
		"failure_category", func() string {
			if failed {
				return observation.ReasonCode
			}
			return ""
		}(),
		"next_retry_at", nextRetryAt,
	)
}

func (m *codexProfileManager) scheduleAuthenticationRetry(profileID string, generation uint64, delay time.Duration) {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-m.ctx.Done():
		return
	}
	m.mu.Lock()
	state := m.auth[profileID]
	valid := state != nil && state.generation == generation
	m.mu.Unlock()
	if !valid {
		return
	}
	record, ok := m.catalog.record(profileID)
	if ok && record.Snapshot.Status == domain.CodexProfileStatusValid {
		_, _ = m.ensureAuthentication(m.ctx, record, domain.AgentReadinessPurposeDisplay, true, false)
	}
}

func (m *codexProfileManager) invalidate(profileID string) {
	m.mu.Lock()
	state := m.auth[profileID]
	if state == nil {
		state = &profileAuthState{}
		m.auth[profileID] = state
	}
	state.invalidated = true
	state.nextRetryAt = time.Time{}
	state.failures = 0
	state.generation++
	m.mu.Unlock()
	m.catalog.updateSnapshot(profileID, func(snapshot *domain.CodexProfileSnapshot) {
		snapshot.Authentication.Freshness = domain.AgentReadinessStale
	})
}

func (m *codexProfileManager) create(_ context.Context, label string) (domain.CodexProfileSnapshot, error) {
	label = strings.TrimSpace(label)
	if !validCodexProfileLabel(label) {
		return domain.CodexProfileSnapshot{}, apierr.Invalid("INVALID_CODEX_PROFILE_LABEL", "Profile label must be 1 to 80 characters without control characters", nil)
	}
	record, err := m.catalog.create(label)
	if errors.Is(err, errInvalidCodexProfileLabel) {
		return domain.CodexProfileSnapshot{}, apierr.Invalid("INVALID_CODEX_PROFILE_LABEL", "Profile label must be 1 to 80 characters without control characters", nil)
	}
	if err != nil {
		return domain.CodexProfileSnapshot{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile could not be created")
	}
	return record.Snapshot, nil
}

func requireBrowserLoginCapability(capabilities domain.CodexProfileCapabilities) error {
	switch capabilities.BrowserLogin.State {
	case domain.CodexCapabilitySupported:
		return nil
	case domain.CodexCapabilityUnsupported:
		return apierr.NotImplemented("CODEX_PROFILE_MANAGEMENT_UNSUPPORTED", "This Codex version does not support browser profile management")
	default:
		return apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile management is temporarily unavailable")
	}
}

func mapUnknownCodexProfile(err error) error {
	var unknown unknownCodexProfileError
	if errors.As(err, &unknown) {
		return apierr.Invalid("UNKNOWN_CODEX_PROFILE_ID", "Unknown Codex profile: "+unknown.id, map[string]any{"profileId": unknown.id})
	}
	return err
}

func (m *codexProfileManager) startLogin(ctx context.Context, profileID string) (CodexProfileLoginStart, error) {
	if err := m.catalog.refresh(); err != nil {
		return CodexProfileLoginStart{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile discovery is unavailable")
	}
	record, ok := m.catalog.record(profileID)
	if !ok || record.Snapshot.Status != domain.CodexProfileStatusValid {
		return CodexProfileLoginStart{}, apierr.NotFound("CODEX_PROFILE_NOT_FOUND", "Codex profile not found")
	}
	if err := requireBrowserLoginCapability(m.detectCapabilities(ctx)); err != nil {
		return CodexProfileLoginStart{}, err
	}
	m.mu.Lock()
	if _, starting := m.loginStarting[profileID]; starting {
		m.mu.Unlock()
		return CodexProfileLoginStart{}, apierr.Conflict("CODEX_PROFILE_LOGIN_IN_PROGRESS", "A login is already in progress for this profile", nil)
	}
	for _, operation := range m.logins {
		if operation.profileID == profileID && !operation.terminal {
			m.mu.Unlock()
			return CodexProfileLoginStart{}, apierr.Conflict("CODEX_PROFILE_LOGIN_IN_PROGRESS", "A login is already in progress for this profile", nil)
		}
	}
	m.loginStarting[profileID] = struct{}{}
	m.mu.Unlock()
	starting := true
	defer func() {
		if !starting {
			return
		}
		m.mu.Lock()
		delete(m.loginStarting, profileID)
		m.mu.Unlock()
	}()
	select {
	case m.processes <- struct{}{}:
	default:
		return CodexProfileLoginStart{}, apierr.TooManyRequests("CODEX_PROFILE_LOGIN_LIMIT", "Too many Codex profile operations are active")
	}
	release := true
	defer func() {
		if release {
			<-m.processes
		}
	}()
	loginCtx, cancel := context.WithTimeout(m.ctx, codexProfileLoginLifetime)
	strictCtx, strictCancel := context.WithTimeout(loginCtx, codexProfileAuthTimeout)
	client, err := m.factory.Open(strictCtx, ports.CodexAccountProfile{Home: record.Home, Managed: record.Snapshot.Source == domain.CodexProfileSourceManaged})
	if err != nil {
		strictCancel()
		cancel()
		return CodexProfileLoginStart{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile login could not be started")
	}
	account, err := client.Read(strictCtx, true)
	strictCancel()
	if err != nil {
		_ = client.Close()
		cancel()
		m.recordLoginReadFailure(profileID, err)
		return CodexProfileLoginStart{}, apierr.Conflict("CODEX_PROFILE_AUTH_UNVERIFIED", "Confirm this profile is signed out before starting login", nil)
	}
	m.storeAccountObservation(profileID, account)
	if account.Authentication != domain.AgentAuthenticationUnauthorized {
		_ = client.Close()
		cancel()
		if account.Authentication == domain.AgentAuthenticationAuthorized || account.Authentication == domain.AgentAuthenticationNotApplicable {
			return CodexProfileLoginStart{}, apierr.Conflict("CODEX_PROFILE_ALREADY_AUTHENTICATED", "This Codex profile is already authenticated", nil)
		}
		m.invalidate(profileID)
		m.recheck(profileID, true)
		return CodexProfileLoginStart{}, apierr.Conflict("CODEX_PROFILE_AUTH_UNVERIFIED", "Confirm this profile is signed out before starting login", nil)
	}
	startCtx, startCancel := context.WithTimeout(loginCtx, codexProfileAuthTimeout)
	started, err := client.StartBrowserLogin(startCtx)
	startCancel()
	if err != nil {
		_ = client.Close()
		cancel()
		return CodexProfileLoginStart{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile login could not be started")
	}
	authURL, parseErr := url.Parse(started.AuthURL)
	if parseErr != nil || (authURL.Scheme != "http" && authURL.Scheme != "https") || authURL.Host == "" || strings.TrimSpace(started.LoginID) == "" {
		_ = client.Close()
		cancel()
		return CodexProfileLoginStart{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile login could not be started")
	}
	operation := &codexLoginOperation{
		id: m.newID(), profileID: profileID, loginID: started.LoginID, authURL: started.AuthURL,
		startedAt: m.now(),
		status:    domain.CodexProfileLoginPending, reasonCode: domain.CodexProfileLoginReasonPending,
		reason: "Waiting for Codex sign-in.", client: client, cancel: cancel,
		watchers: make(map[chan domain.CodexProfileLoginEvent]struct{}),
	}
	m.mu.Lock()
	m.logins[operation.id] = operation
	delete(m.loginStarting, profileID)
	m.mu.Unlock()
	starting = false
	release = false
	m.logger.Info("Codex profile login started", "profile_id", profileID, "source", record.Snapshot.Source, "operation", "login_start", "outcome", "pending")
	go m.watchLogin(loginCtx, operation)
	return CodexProfileLoginStart{OperationID: operation.id, ProfileID: profileID, Status: operation.status, AuthURL: started.AuthURL}, nil
}

func (m *codexProfileManager) validateLoginProfile(profileID string) error {
	if err := m.catalog.refresh(); err != nil {
		return apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile discovery is unavailable")
	}
	record, ok := m.catalog.record(profileID)
	if !ok || record.Snapshot.Status != domain.CodexProfileStatusValid {
		return apierr.NotFound("CODEX_PROFILE_NOT_FOUND", "Codex profile not found")
	}
	return nil
}

func (m *codexProfileManager) watchLogin(ctx context.Context, operation *codexLoginOperation) {
	defer func() { <-m.processes }()
	for {
		select {
		case event, ok := <-operation.client.Events():
			if !ok {
				m.completeLogin(operation.id, domain.CodexProfileLoginFailed, domain.CodexProfileLoginReasonFailed, "Codex profile login stopped.", nil)
				return
			}
			if event.Kind == ports.CodexAccountEventUpdated {
				m.invalidate(operation.profileID)
				m.recheck(operation.profileID, true)
				continue
			}
			if event.Kind != ports.CodexAccountEventLoginCompleted || event.LoginID != operation.loginID {
				continue
			}
			if !event.Success || event.Failed {
				m.completeLogin(operation.id, domain.CodexProfileLoginFailed, domain.CodexProfileLoginReasonFailed, "Codex profile login failed.", nil)
				return
			}
			verifyCtx, cancel := context.WithTimeout(ctx, codexProfileAuthTimeout)
			account, err := operation.client.Read(verifyCtx, true)
			cancel()
			if err != nil || account.Authentication != domain.AgentAuthenticationAuthorized {
				m.completeLogin(operation.id, domain.CodexProfileLoginFailed, domain.CodexProfileLoginReasonFailed, "Codex could not confirm the signed-in account.", nil)
				return
			}
			m.storeAccountObservation(operation.profileID, account)
			m.invalidate(operation.profileID)
			latest, ok := m.catalog.record(operation.profileID)
			if !ok {
				m.completeLogin(operation.id, domain.CodexProfileLoginFailed, domain.CodexProfileLoginReasonFailed, "The Codex profile is no longer available.", nil)
				return
			}
			profile := latest.Snapshot
			m.completeLogin(operation.id, domain.CodexProfileLoginCompleted, domain.CodexProfileLoginReasonCompleted, "Codex profile sign-in completed.", &profile)
			return
		case <-ctx.Done():
			m.completeLogin(operation.id, domain.CodexProfileLoginFailed, domain.CodexProfileLoginReasonFailed, "Codex profile login timed out.", nil)
			return
		}
	}
}

func (m *codexProfileManager) storeAccountObservation(profileID string, account ports.CodexAccountObservation) {
	observation := accountAuthenticationObservation(m.now(), account.Authentication)
	m.mu.Lock()
	state := m.auth[profileID]
	if state == nil {
		state = &profileAuthState{}
		m.auth[profileID] = state
	}
	if account.Authentication == domain.AgentAuthenticationUnknown {
		m.catalog.updateSnapshot(profileID, func(snapshot *domain.CodexProfileSnapshot) {
			preserveAuthenticationFailure(&snapshot.Authentication, observation)
		})
	} else {
		m.catalog.updateSnapshot(profileID, func(snapshot *domain.CodexProfileSnapshot) {
			snapshot.Authentication, snapshot.AuthMethod, snapshot.AccountEmail = observation, account.Method, account.Email
		})
		if state.call == nil {
			state.invalidated = false
			state.failures = 0
			state.nextRetryAt = time.Time{}
			state.generation++
		}
	}
	m.mu.Unlock()
}

func (m *codexProfileManager) recordLoginReadFailure(profileID string, err error) {
	code := domain.AgentReadinessReasonAuthCheckFailed
	reason := "Authentication check failed."
	if errors.Is(err, context.DeadlineExceeded) {
		code = domain.AgentReadinessReasonAuthCheckTimeout
		reason = "Authentication check timed out."
	}
	failure := failedAuthentication(m.now(), code, reason)
	m.catalog.updateSnapshot(profileID, func(snapshot *domain.CodexProfileSnapshot) {
		preserveAuthenticationFailure(&snapshot.Authentication, failure)
	})
	m.invalidate(profileID)
	m.recheck(profileID, true)
}

func (m *codexProfileManager) completeLogin(operationID string, status domain.CodexProfileLoginStatus, code, reason string, profile *domain.CodexProfileSnapshot) {
	m.mu.Lock()
	operation := m.logins[operationID]
	if operation == nil || operation.terminal {
		m.mu.Unlock()
		return
	}
	operation.status, operation.reasonCode, operation.reason, operation.profile, operation.terminal = status, code, reason, profile, true
	event := loginEvent(operation)
	watchers := make([]chan domain.CodexProfileLoginEvent, 0, len(operation.watchers))
	for watcher := range operation.watchers {
		watchers = append(watchers, watcher)
	}
	operation.watchers = make(map[chan domain.CodexProfileLoginEvent]struct{})
	client, cancel := operation.client, operation.cancel
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if client != nil {
		_ = client.Close()
	}
	for _, watcher := range watchers {
		watcher <- event
		close(watcher)
	}
	m.invalidate(operation.profileID)
	failureCategory := ""
	if status == domain.CodexProfileLoginFailed {
		failureCategory = code
	}
	m.logger.Info("Codex profile login completed", "profile_id", operation.profileID, "operation", "login", "outcome", status, "duration_ms", m.now().Sub(operation.startedAt).Milliseconds(), "failure_category", failureCategory)
	m.recheck(operation.profileID, true)
	go m.evictLogin(operationID)
}

func (m *codexProfileManager) recheck(profileID string, refreshToken bool) {
	go func(profileID string) {
		record, ok := m.catalog.record(profileID)
		if ok && record.Snapshot.Status == domain.CodexProfileStatusValid {
			_, _ = m.ensureAuthentication(m.ctx, record, domain.AgentReadinessPurposeDisplay, true, refreshToken)
		}
	}(profileID)
}

func (m *codexProfileManager) evictLogin(operationID string) {
	timer := time.NewTimer(codexProfileLoginRetention)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-m.ctx.Done():
	}
	m.mu.Lock()
	delete(m.logins, operationID)
	m.mu.Unlock()
}

func loginEvent(operation *codexLoginOperation) domain.CodexProfileLoginEvent {
	return domain.CodexProfileLoginEvent{OperationID: operation.id, ProfileID: operation.profileID, Status: operation.status, ReasonCode: operation.reasonCode, Reason: operation.reason, Profile: operation.profile}
}

func (m *codexProfileManager) subscribeLogin(ctx context.Context, profileID, operationID string) (<-chan domain.CodexProfileLoginEvent, error) {
	m.mu.Lock()
	operation := m.logins[operationID]
	if operation == nil || operation.profileID != profileID {
		m.mu.Unlock()
		return nil, apierr.NotFound("CODEX_PROFILE_LOGIN_NOT_FOUND", "Codex profile login operation not found")
	}
	watcher := make(chan domain.CodexProfileLoginEvent, 2)
	watcher <- loginEvent(operation)
	if operation.terminal {
		close(watcher)
		m.mu.Unlock()
		return watcher, nil
	}
	operation.watchers[watcher] = struct{}{}
	m.mu.Unlock()
	go func() {
		<-ctx.Done()
		m.mu.Lock()
		if operation := m.logins[operationID]; operation != nil {
			if _, ok := operation.watchers[watcher]; ok {
				delete(operation.watchers, watcher)
				close(watcher)
			}
		}
		m.mu.Unlock()
	}()
	return watcher, nil
}

func (m *codexProfileManager) cancelLogin(ctx context.Context, profileID, operationID string) (domain.CodexProfileLoginEvent, error) {
	m.mu.Lock()
	operation := m.logins[operationID]
	if operation == nil || operation.profileID != profileID {
		m.mu.Unlock()
		return domain.CodexProfileLoginEvent{}, apierr.NotFound("CODEX_PROFILE_LOGIN_NOT_FOUND", "Codex profile login operation not found")
	}
	if operation.terminal {
		m.mu.Unlock()
		return domain.CodexProfileLoginEvent{}, apierr.Conflict("CODEX_PROFILE_LOGIN_NOT_PENDING", "Codex profile login is no longer pending", nil)
	}
	client, loginID := operation.client, operation.loginID
	m.mu.Unlock()
	if err := client.CancelLogin(ctx, loginID); err != nil {
		m.mu.Lock()
		current := m.logins[operationID]
		if current != nil && current.terminal {
			event := loginEvent(current)
			m.mu.Unlock()
			return event, nil
		}
		m.mu.Unlock()
		return domain.CodexProfileLoginEvent{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile login could not be cancelled")
	}
	m.completeLogin(operationID, domain.CodexProfileLoginCancelled, domain.CodexProfileLoginReasonCancelled, "Codex profile login was cancelled.", nil)
	m.mu.Lock()
	event := loginEvent(m.logins[operationID])
	m.mu.Unlock()
	return event, nil
}

func (s *Service) structuredCodexAuthentication(ctx context.Context, agentID string, purpose domain.AgentReadinessPurpose) (domain.AgentAuthenticationObservation, bool) {
	if agentID != string(domain.HarnessCodex) || s.codexProfiles == nil || s.codexProfiles.factory == nil {
		return domain.AgentAuthenticationObservation{}, false
	}
	capabilities := s.codexProfiles.detectCapabilities(ctx)
	if capabilities.AccountRead.State == domain.CodexCapabilityUnsupported {
		return domain.AgentAuthenticationObservation{}, false
	}
	if capabilities.AccountRead.State == domain.CodexCapabilityUnknown {
		return failedAuthentication(s.codexProfiles.now(), domain.AgentReadinessReasonAuthCheckInconclusive, "Authentication check was inconclusive."), true
	}
	record, _ := s.codexProfiles.catalog.record(codexExistingProfileID)
	observation, err := s.codexProfiles.ensureAuthentication(ctx, record, purpose, false, purpose == domain.AgentReadinessPurposeLaunch)
	if err != nil {
		return failedAuthentication(s.codexProfiles.now(), domain.AgentReadinessReasonAuthCheckFailed, "Authentication check failed."), true
	}
	return observation, true
}

// CachedCodexProfiles returns the in-memory profile view without filesystem or
// native Codex work.
func (s *Service) CachedCodexProfiles(ctx context.Context) (CodexProfiles, error) {
	if err := ctx.Err(); err != nil {
		return CodexProfiles{}, err
	}
	if s.codexProfiles == nil {
		return CodexProfiles{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile management is unavailable")
	}
	return s.codexProfiles.cached(), nil
}

// EnsureCodexProfiles rediscovers descriptors and ensures profile authentication.
func (s *Service) EnsureCodexProfiles(ctx context.Context, profileIDs []string, purpose domain.AgentReadinessPurpose, forceAuthenticationRefresh bool) (CodexProfiles, error) {
	if err := ctx.Err(); err != nil {
		return CodexProfiles{}, err
	}
	if s.codexProfiles == nil {
		return CodexProfiles{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile management is unavailable")
	}
	if result, done, err := s.codexProfiles.prepareEnsure(profileIDs, purpose); done {
		return result, err
	}
	installation, err := s.readiness.EnsureInstallation(ctx, []string{string(domain.HarnessCodex)}, domain.AgentReadinessPurposeDisplay)
	if err != nil {
		return CodexProfiles{}, err
	}
	result, err := s.codexProfiles.ensure(ctx, profileIDs, purpose, installation[0].Installation.State, forceAuthenticationRefresh)
	if err != nil {
		return CodexProfiles{}, err
	}
	if result.Capabilities.AccountRead.State == domain.CodexCapabilityUnsupported {
		if _, ensureErr := s.readiness.Ensure(ctx, []string{string(domain.HarnessCodex)}, domain.AgentReadinessPurposeDisplay); ensureErr != nil {
			return CodexProfiles{}, ensureErr
		}
		s.syncExistingCodexProfile()
		result, err = s.codexProfiles.view(profileIDs)
		if err != nil {
			return CodexProfiles{}, err
		}
	}
	return result, nil
}

// CreateCodexProfile atomically creates an isolated AO-managed Codex profile.
func (s *Service) CreateCodexProfile(ctx context.Context, label string) (domain.CodexProfileSnapshot, error) {
	if s.codexProfiles == nil {
		return domain.CodexProfileSnapshot{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile management is unavailable")
	}
	label = strings.TrimSpace(label)
	if !validCodexProfileLabel(label) {
		return domain.CodexProfileSnapshot{}, apierr.Invalid("INVALID_CODEX_PROFILE_LABEL", "Profile label must be 1 to 80 characters without control characters", nil)
	}
	if err := s.requireCodexProfileInstallation(ctx); err != nil {
		return domain.CodexProfileSnapshot{}, err
	}
	return s.codexProfiles.create(ctx, label)
}

// SetCodexProfileLoginTerminalOpener late-binds the shell-terminal service,
// which is constructed after the agent service during daemon startup.
func (s *Service) SetCodexProfileLoginTerminalOpener(opener codexProfileLoginTerminalOpener) {
	if s.codexProfiles != nil {
		s.codexProfiles.loginTerminalOpener = opener
	}
}

// OpenCodexProfileLoginTerminal opens the fixed native login helper for one
// private profile home.
func (s *Service) OpenCodexProfileLoginTerminal(ctx context.Context, profileID string) (CodexProfileLoginTerminalStart, error) {
	if s.codexProfiles == nil {
		return CodexProfileLoginTerminalStart{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile management is unavailable")
	}
	record, err := s.codexProfiles.resolveLoginTerminalProfile(ctx, profileID)
	if err != nil {
		return CodexProfileLoginTerminalStart{}, err
	}
	installation, err := s.codexProfileInstallation(ctx, true)
	if err != nil {
		return CodexProfileLoginTerminalStart{}, err
	}
	if codexInstallationConfirmedAbsent(installation) {
		return CodexProfileLoginTerminalStart{}, apierr.Unavailable("CODEX_PROFILE_LOGIN_TERMINAL_UNAVAILABLE", "Codex is not installed")
	}
	return s.codexProfiles.openResolvedLoginTerminal(ctx, record)
}

// StartCodexProfileLogin starts a guarded browser login for one profile.
func (s *Service) StartCodexProfileLogin(ctx context.Context, profileID string) (CodexProfileLoginStart, error) {
	if s.codexProfiles == nil {
		return CodexProfileLoginStart{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile management is unavailable")
	}
	if err := s.codexProfiles.validateLoginProfile(profileID); err != nil {
		return CodexProfileLoginStart{}, err
	}
	if err := s.requireCodexProfileInstallation(ctx); err != nil {
		return CodexProfileLoginStart{}, err
	}
	return s.codexProfiles.startLogin(ctx, profileID)
}

func (s *Service) requireCodexProfileInstallation(ctx context.Context) error {
	installation, err := s.codexProfileInstallation(ctx, false)
	if err != nil {
		return err
	}
	if codexInstallationConfirmedAbsent(installation) {
		return apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex is not installed")
	}
	return nil
}

func (s *Service) codexProfileInstallation(ctx context.Context, force bool) (domain.AgentInstallationObservation, error) {
	const codexID = string(domain.HarnessCodex)
	if force {
		s.readiness.Invalidate(codexID, readinessInvalidateInstallation)
	}
	installation, err := s.readiness.EnsureInstallation(ctx, []string{codexID}, domain.AgentReadinessPurposeDisplay)
	if err != nil {
		return domain.AgentInstallationObservation{}, err
	}
	return installation[0].Installation, nil
}

func codexInstallationConfirmedAbsent(installation domain.AgentInstallationObservation) bool {
	return installation.State == domain.AgentInstallationNotInstalled && installation.Freshness == domain.AgentReadinessFresh
}

// SubscribeCodexProfileLogin streams the current and subsequent login state.
func (s *Service) SubscribeCodexProfileLogin(ctx context.Context, profileID, operationID string) (<-chan domain.CodexProfileLoginEvent, error) {
	if s.codexProfiles == nil {
		return nil, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile management is unavailable")
	}
	return s.codexProfiles.subscribeLogin(ctx, profileID, operationID)
}

// CancelCodexProfileLogin cancels a pending in-memory login operation.
func (s *Service) CancelCodexProfileLogin(ctx context.Context, profileID, operationID string) (domain.CodexProfileLoginEvent, error) {
	if s.codexProfiles == nil {
		return domain.CodexProfileLoginEvent{}, apierr.Unavailable("CODEX_PROFILE_MANAGEMENT_UNAVAILABLE", "Codex profile management is unavailable")
	}
	return s.codexProfiles.cancelLogin(ctx, profileID, operationID)
}

// InvalidateCodexProfileAuthentication invalidates and asynchronously rechecks
// exactly one profile subject.
func (s *Service) InvalidateCodexProfileAuthentication(profileID string) {
	if s.codexProfiles == nil {
		return
	}
	s.codexProfiles.invalidate(profileID)
	if profileID == codexExistingProfileID {
		s.readiness.Invalidate(string(domain.HarnessCodex), readinessInvalidateAuthentication)
	}
	s.codexProfiles.recheck(profileID, false)
}

// WarmCodexProfiles asynchronously discovers and warms Codex profile state.
func (s *Service) WarmCodexProfiles() {
	if s.codexProfiles == nil {
		return
	}
	go func() {
		if err := s.codexProfiles.catalog.refresh(); err != nil {
			return
		}
		_, _ = s.EnsureCodexProfiles(s.codexProfiles.ctx, nil, domain.AgentReadinessPurposeDisplay, false)
	}()
}

func (s *Service) syncExistingCodexProfile() {
	for _, snapshot := range s.readiness.Snapshot() {
		if snapshot.ID != string(domain.HarnessCodex) {
			continue
		}
		s.codexProfiles.catalog.updateSnapshot(codexExistingProfileID, func(profile *domain.CodexProfileSnapshot) {
			profile.Authentication = snapshot.Authentication
		})
		return
	}
}
