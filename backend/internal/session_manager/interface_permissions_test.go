package sessionmanager

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/pkg/agentruntime"
)

type permissionTransitionAgent struct {
	transitionAgent
	modes []domain.PermissionMode
	argv  [][]string
}

type permissionTransitionChat struct {
	*transitionChat
	preflightPermission ports.PermissionMode
}

func (c *permissionTransitionChat) PreflightChat(ctx context.Context, harness domain.AgentHarness, mode ports.PermissionMode) error {
	c.preflightPermission = mode
	return c.transitionChat.PreflightChat(ctx, harness, mode)
}

func TestInterfaceTargetPreservesTUIPermissionsForChat(t *testing.T) {
	for _, mode := range []domain.PermissionMode{domain.PermissionModeDefault, domain.PermissionModeAuto, domain.PermissionModeAcceptEdits, domain.PermissionModeBypassPermissions} {
		t.Run(string(mode), func(t *testing.T) {
			manager, store, _, chat, _ := newTransitionManager(t, domain.SessionModeTUI)
			project := store.projects["proj"]
			project.Config.AgentConfig.Permissions = domain.PermissionModeBypassPermissions
			project.Config.Worker.AgentConfig.Permissions = mode
			store.projects["proj"] = project
			capture := &permissionTransitionChat{transitionChat: chat}
			manager.chat = capture
			rec := store.sessions["session-1"]
			transition := domain.SessionInterfaceTransition{SourceMode: domain.SessionModeTUI, TargetMode: domain.SessionModeChat, NativeConversationID: "native-1"}
			if err := manager.preflightInterfaceTarget(context.Background(), rec, transition); err != nil {
				t.Fatal(err)
			}
			if _, err := manager.lcm.CommitControllerEpoch(context.Background(), rec.ID, domain.SessionModeTUI, domain.SessionModeChat, "native-1", false); err != nil {
				t.Fatal(err)
			}
			if err := manager.startTransitionTarget(context.Background(), rec.ID, false, true); err != nil {
				t.Fatal(err)
			}
			if capture.preflightPermission != mode || chat.start.Permissions != mode {
				t.Fatalf("preflight=%s launch=%s want=%s", capture.preflightPermission, chat.start.Permissions, mode)
			}
		})
	}
}

func (a *permissionTransitionAgent) GetLaunchCommand(_ context.Context, cfg ports.LaunchConfig) ([]string, error) {
	a.modes = append(a.modes, cfg.Permissions)
	cmd, err := agentruntime.BuildLaunchCommand(agentruntime.LaunchConfig{Harness: agentruntime.HarnessCodex, Binary: "codex", WorkspacePath: cfg.WorkspacePath, Permission: agentruntime.PermissionPolicy(cfg.Permissions)})
	a.argv = append(a.argv, cmd)
	return cmd, err
}
func (a *permissionTransitionAgent) GetRestoreCommand(_ context.Context, cfg ports.RestoreConfig) ([]string, bool, error) {
	a.modes = append(a.modes, cfg.Permissions)
	cmd, ok, err := agentruntime.BuildRestoreCommand(agentruntime.RestoreConfig{Harness: agentruntime.HarnessCodex, Binary: "codex", Metadata: cfg.Session.Metadata, WorkspacePath: cfg.Session.WorkspacePath, Permission: agentruntime.PermissionPolicy(cfg.Permissions)})
	a.argv = append(a.argv, cmd)
	return cmd, ok, err
}

func TestInterfaceTargetPreservesChatPermissionsForFreshAndResume(t *testing.T) {
	for _, mode := range []domain.PermissionMode{"", domain.PermissionModeDefault, domain.PermissionModeAuto, domain.PermissionModeAcceptEdits, domain.PermissionModeBypassPermissions} {
		for _, fresh := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/fresh=%t", mode, fresh), func(t *testing.T) {
				manager, store, _, _, _ := newTransitionManager(t, domain.SessionModeChat)
				store.permissionMode = mode
				project := store.projects["proj"]
				project.Config.AgentConfig.Permissions = domain.PermissionModeBypassPermissions
				project.Config.Worker.AgentConfig.Permissions = domain.PermissionModeBypassPermissions
				store.projects["proj"] = project
				agent := &permissionTransitionAgent{}
				manager.agents = singleAgent{agent: agent}
				rec := store.sessions["session-1"]
				nativeID := "native-1"
				if fresh {
					nativeID = ""
					rec.Metadata.AgentSessionID = ""
					rec.Metadata.ProviderConversationID = ""
				}
				transition := domain.SessionInterfaceTransition{SourceMode: domain.SessionModeChat, TargetMode: domain.SessionModeTUI, NativeConversationID: nativeID}
				if err := manager.preflightInterfaceTarget(context.Background(), rec, transition); err != nil {
					t.Fatal(err)
				}
				if _, err := manager.lcm.CommitControllerEpoch(context.Background(), rec.ID, domain.SessionModeChat, domain.SessionModeTUI, nativeID, false); err != nil {
					t.Fatal(err)
				}
				if err := manager.startTransitionTarget(context.Background(), rec.ID, fresh, true); err != nil {
					t.Fatal(err)
				}
				want := mode
				if want == "" {
					want = domain.PermissionModeDefault
				}
				if len(agent.modes) != 2 {
					t.Fatalf("preflight + launch modes: %v", agent.modes)
				}
				for i, got := range agent.modes {
					if got != want {
						t.Fatalf("call %d permissions = %s, want %s", i, got, want)
					}
					if want != domain.PermissionModeBypassPermissions && strings.Contains(strings.Join(agent.argv[i], " "), "--dangerously-bypass-approvals-and-sandbox") {
						t.Fatalf("call %d escalated: %v", i, agent.argv[i])
					}
				}
				if store.projects["proj"].Config.Worker.AgentConfig.Permissions != domain.PermissionModeBypassPermissions {
					t.Fatal("handoff changed project default")
				}
			})
		}
	}
}
