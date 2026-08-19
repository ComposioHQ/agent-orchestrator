package daytona

import (
	"context"
	"errors"
	"fmt"
	"time"

	daytonasdk "github.com/daytona/clients/sdk-go/pkg/daytona"
	sdkerrors "github.com/daytona/clients/sdk-go/pkg/errors"
	"github.com/daytona/clients/sdk-go/pkg/options"
	"github.com/daytona/clients/sdk-go/pkg/types"
)

type CreateRequest struct {
	Name            string
	Snapshot        string
	User            string
	Target          string
	Environment     map[string]string
	Labels          map[string]string
	DomainAllowList string
	CPU             int
	Memory          int
	Disk            int
}

type RemoteSandbox struct {
	ID     string
	Name   string
	State  string
	Target string
	Labels map[string]string
	CPU    int
	Memory int
	Disk   int
}

type ExecResult struct {
	ExitCode int
	Output   string
}

// Client is the narrow Daytona surface the AO provider needs. Keeping this
// interface here makes provider behavior testable without network calls while
// SDKClient remains the only production implementation.
type Client interface {
	Create(context.Context, CreateRequest) (RemoteSandbox, error)
	Get(context.Context, string) (RemoteSandbox, error)
	List(context.Context, map[string]string) ([]RemoteSandbox, error)
	Start(context.Context, string) error
	Stop(context.Context, string) error
	Pause(context.Context, string) error
	Delete(context.Context, string) error
	Upload(context.Context, string, string, []byte) error
	Execute(context.Context, string, string, map[string]string) (ExecResult, error)
}

type SDKClient struct {
	client *daytonasdk.Client
}

func NewSDKClient(config Config) (*SDKClient, error) {
	client, err := daytonasdk.NewClientWithConfig(&types.DaytonaConfig{
		APIKey: config.APIKey,
		APIUrl: config.APIURL,
		Target: config.Target,
	})
	if err != nil {
		return nil, fmt.Errorf("create Daytona client: %w", err)
	}
	return &SDKClient{client: client}, nil
}

func (c *SDKClient) Create(ctx context.Context, request CreateRequest) (RemoteSandbox, error) {
	autoStop := 0
	autoPause := 0
	autoDelete := -1
	params := types.SnapshotParams{
		Snapshot: request.Snapshot,
		SandboxBaseParams: types.SandboxBaseParams{
			Name:               request.Name,
			User:               request.User,
			EnvVars:            request.Environment,
			Labels:             request.Labels,
			Public:             false,
			AutoStopInterval:   &autoStop,
			AutoPauseInterval:  &autoPause,
			AutoDeleteInterval: &autoDelete,
			DomainAllowList:    &request.DomainAllowList,
		},
	}
	sandbox, err := c.client.Create(
		ctx,
		params,
		options.WithTimeout(5*time.Minute),
		options.WithWaitForStart(false),
	)
	if err != nil {
		return RemoteSandbox{}, normalizeError(err)
	}
	return toRemote(sandbox), nil
}

func (c *SDKClient) Get(ctx context.Context, id string) (RemoteSandbox, error) {
	sandbox, err := c.client.Get(ctx, id)
	if err != nil {
		return RemoteSandbox{}, normalizeError(err)
	}
	return toRemote(sandbox), nil
}

func (c *SDKClient) List(ctx context.Context, labels map[string]string) ([]RemoteSandbox, error) {
	iterator := c.client.List(ctx, &daytonasdk.ListSandboxesQuery{Labels: labels})
	var sandboxes []RemoteSandbox
	for iterator.Next() {
		sandboxes = append(sandboxes, toRemote(iterator.Value()))
	}
	if err := iterator.Err(); err != nil {
		return nil, normalizeError(err)
	}
	return sandboxes, nil
}

func (c *SDKClient) Start(ctx context.Context, id string) error {
	sandbox, err := c.client.Get(ctx, id)
	if err != nil {
		return normalizeError(err)
	}
	return normalizeError(sandbox.StartWithTimeout(ctx, 2*time.Minute))
}

func (c *SDKClient) Stop(ctx context.Context, id string) error {
	sandbox, err := c.client.Get(ctx, id)
	if err != nil {
		return normalizeError(err)
	}
	return normalizeError(sandbox.StopWithTimeout(ctx, 2*time.Minute, false))
}

func (c *SDKClient) Pause(ctx context.Context, id string) error {
	sandbox, err := c.client.Get(ctx, id)
	if err != nil {
		return normalizeError(err)
	}
	return normalizeError(sandbox.PauseWithTimeout(ctx, 2*time.Minute))
}

func (c *SDKClient) Delete(ctx context.Context, id string) error {
	sandbox, err := c.client.Get(ctx, id)
	if errors.Is(err, sdkerrors.ErrNotFound) {
		return nil
	}
	if err != nil {
		return normalizeError(err)
	}
	return normalizeError(sandbox.DeleteWithTimeout(ctx, 2*time.Minute))
}

func (c *SDKClient) Upload(
	ctx context.Context,
	id string,
	destination string,
	content []byte,
) error {
	sandbox, err := c.client.Get(ctx, id)
	if err != nil {
		return normalizeError(err)
	}
	return normalizeError(sandbox.FileSystem.UploadFile(ctx, content, destination))
}

func (c *SDKClient) Execute(
	ctx context.Context,
	id string,
	command string,
	environment map[string]string,
) (ExecResult, error) {
	sandbox, err := c.client.Get(ctx, id)
	if err != nil {
		return ExecResult{}, normalizeError(err)
	}
	result, err := sandbox.Process.ExecuteCommand(
		ctx,
		command,
		options.WithCommandEnv(environment),
		options.WithExecuteTimeout(2*time.Minute),
	)
	if err != nil {
		return ExecResult{}, normalizeError(err)
	}
	return ExecResult{ExitCode: result.ExitCode, Output: result.Result}, nil
}

func toRemote(value *daytonasdk.Sandbox) RemoteSandbox {
	if value == nil {
		return RemoteSandbox{}
	}
	return RemoteSandbox{
		ID: value.ID, Name: value.Name, State: string(value.State), Target: value.Target,
		Labels: value.Labels, CPU: int(value.Cpu), Memory: int(value.Memory), Disk: int(value.Disk),
	}
}

func normalizeError(err error) error {
	if errors.Is(err, sdkerrors.ErrNotFound) {
		return fmt.Errorf("%w: %w", ErrNotFound, err)
	}
	return err
}
