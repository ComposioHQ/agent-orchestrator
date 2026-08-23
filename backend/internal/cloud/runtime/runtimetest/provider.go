package runtimetest

import (
	"context"
	"fmt"
	"maps"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
)

// FakeProvider is a scriptable in-memory runtime.Provider. It models the
// provider behaviour the compute plane actually depends on — labels applied
// atomically at create, idempotency keys collapsing retried creates, a missing
// sandbox reported as runtime.ErrSandboxNotFound — so a lifecycle test that
// passes here is testing the real contract rather than a convenient one.
type FakeProvider struct {
	mu        sync.Mutex
	sandboxes map[string]runtime.Sandbox
	byKey     map[string]string
	nextID    int
	// Now supplies creation timestamps. Defaults to time.Now.
	Now func() time.Time

	// Calls records every method invoked, in order, for assertions about
	// ordering (for example that Delete followed capability revocation).
	Calls []string
	// FailCreate, FailStart, FailStop, FailGet, and FailDelete, when non-nil,
	// are returned by the corresponding call and then cleared.
	FailCreate error
	// FailAfterCreate returns the newly retained sandbox with an error, modeling
	// a provider bootstrap failure after allocation.
	FailAfterCreate error
	FailStart       error
	FailStop        error
	FailGet         error
	FailDelete      error
	// LastCreate is the most recent create request, for argument assertions.
	LastCreate           runtime.CreateRequest
	LastStart            runtime.StartRequest
	LastCreateCapability []byte
	LastStartCapability  []byte
}

// NewFakeProvider returns an empty provider fake.
func NewFakeProvider() *FakeProvider {
	return &FakeProvider{
		sandboxes: make(map[string]runtime.Sandbox),
		byKey:     make(map[string]string),
	}
}

var _ runtime.Provider = (*FakeProvider)(nil)

func (p *FakeProvider) now() time.Time {
	if p.Now != nil {
		return p.Now().UTC()
	}
	return time.Now().UTC()
}

// Create records a sandbox, honouring the request's idempotency key.
func (p *FakeProvider) Create(_ context.Context, request runtime.CreateRequest) (runtime.Sandbox, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	defer runtime.PurgeFileSecrets(request.SecretFiles)
	defer runtime.PurgeFileSecrets([]runtime.FileSecret{request.Capability})
	p.Calls = append(p.Calls, "create")
	p.LastCreate = request
	p.LastCreateCapability = append([]byte(nil), request.Capability.Content...)
	if err := request.Validate(); err != nil {
		return runtime.Sandbox{}, err
	}
	if err := p.FailCreate; err != nil {
		p.FailCreate = nil
		return runtime.Sandbox{}, err
	}
	if key := request.IdempotencyKey; key != "" {
		if id, ok := p.byKey[key]; ok {
			return p.sandboxes[id], nil
		}
	}
	p.nextID++
	sandbox := runtime.Sandbox{
		ID:        fmt.Sprintf("sbx-%d", p.nextID),
		State:     runtime.ProviderRunning,
		Labels:    maps.Clone(request.Labels),
		CreatedAt: p.now(),
	}
	p.sandboxes[sandbox.ID] = sandbox
	if request.IdempotencyKey != "" {
		p.byKey[request.IdempotencyKey] = sandbox.ID
	}
	if err := p.FailAfterCreate; err != nil {
		p.FailAfterCreate = nil
		return sandbox, err
	}
	return sandbox, nil
}

// Get returns one sandbox.
func (p *FakeProvider) Get(_ context.Context, id string) (runtime.Sandbox, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.Calls = append(p.Calls, "get:"+id)
	if err := p.FailGet; err != nil {
		p.FailGet = nil
		return runtime.Sandbox{}, err
	}
	sandbox, ok := p.sandboxes[id]
	if !ok {
		return runtime.Sandbox{}, runtime.ErrSandboxNotFound
	}
	return sandbox, nil
}

// Start boots a sandbox.
func (p *FakeProvider) Start(_ context.Context, id string, request runtime.StartRequest) (runtime.Sandbox, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	defer runtime.PurgeFileSecrets(request.SecretFiles)
	defer runtime.PurgeFileSecrets([]runtime.FileSecret{request.Capability})
	p.Calls = append(p.Calls, "start:"+id)
	p.LastStart = request
	p.LastStartCapability = append([]byte(nil), request.Capability.Content...)
	if err := request.Validate(); err != nil {
		return runtime.Sandbox{}, err
	}
	if err := p.FailStart; err != nil {
		p.FailStart = nil
		return runtime.Sandbox{}, err
	}
	return p.transitionLocked(id, runtime.ProviderRunning)
}

// Stop suspends a sandbox.
func (p *FakeProvider) Stop(_ context.Context, id string) (runtime.Sandbox, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.Calls = append(p.Calls, "stop:"+id)
	if err := p.FailStop; err != nil {
		p.FailStop = nil
		return runtime.Sandbox{}, err
	}
	return p.transitionLocked(id, runtime.ProviderStopped)
}

func (p *FakeProvider) transitionLocked(id string, state runtime.ProviderState) (runtime.Sandbox, error) {
	sandbox, ok := p.sandboxes[id]
	if !ok {
		return runtime.Sandbox{}, runtime.ErrSandboxNotFound
	}
	sandbox.State = state
	p.sandboxes[id] = sandbox
	return sandbox, nil
}

// Delete destroys a sandbox; a missing sandbox is success.
func (p *FakeProvider) Delete(_ context.Context, id string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.Calls = append(p.Calls, "delete:"+id)
	if err := p.FailDelete; err != nil {
		p.FailDelete = nil
		return err
	}
	delete(p.sandboxes, id)
	for key, mapped := range p.byKey {
		if mapped == id {
			delete(p.byKey, key)
		}
	}
	return nil
}

// List enumerates sandboxes whose labels contain every selector label.
func (p *FakeProvider) List(_ context.Context, selector runtime.Selector) ([]runtime.Sandbox, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.Calls = append(p.Calls, "list")
	matched := make([]runtime.Sandbox, 0, len(p.sandboxes))
	for _, sandbox := range p.sandboxes {
		if matchesLabels(sandbox.Labels, selector.Labels) {
			matched = append(matched, sandbox)
		}
	}
	sortSandboxes(matched)
	return matched, nil
}

func matchesLabels(labels, selector map[string]string) bool {
	for key, value := range selector {
		if labels[key] != value {
			return false
		}
	}
	return true
}

// Seed installs a sandbox directly. Tests use it to stage leaks: sandboxes
// with no placement row, or with missing or foreign labels.
func (p *FakeProvider) Seed(sandbox runtime.Sandbox) runtime.Sandbox {
	p.mu.Lock()
	defer p.mu.Unlock()
	if sandbox.ID == "" {
		p.nextID++
		sandbox.ID = fmt.Sprintf("sbx-%d", p.nextID)
	}
	if sandbox.State == "" {
		sandbox.State = runtime.ProviderRunning
	}
	if sandbox.CreatedAt.IsZero() {
		sandbox.CreatedAt = p.now()
	}
	p.sandboxes[sandbox.ID] = sandbox
	return sandbox
}

// SetState forces a sandbox's provider state, modelling a crash or an
// out-of-band stop.
func (p *FakeProvider) SetState(id string, state runtime.ProviderState) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if sandbox, ok := p.sandboxes[id]; ok {
		sandbox.State = state
		p.sandboxes[id] = sandbox
	}
}

// Remove deletes a sandbox behind the control plane's back.
func (p *FakeProvider) Remove(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.sandboxes, id)
}

// IDs returns every live sandbox id, sorted.
func (p *FakeProvider) IDs() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	ids := make([]string, 0, len(p.sandboxes))
	for id := range p.sandboxes {
		ids = append(ids, id)
	}
	sortStrings(ids)
	return ids
}

// Len reports how many sandboxes exist at the provider.
func (p *FakeProvider) Len() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.sandboxes)
}
