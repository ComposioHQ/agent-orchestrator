package acp

import (
	"context"
	"errors"
	"fmt"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ListConfigOptions returns the live catalog the ACP agent last advertised.
// A copy leaves the conversation as the only writer while HTTP reads race with
// provider notifications and model-dependent catalog rebuilds.
func (c *conversation) ListConfigOptions(ctx context.Context) ([]ports.ChatConfigOption, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, errConversationClosed
	}
	return cloneConfigOptions(c.configOptions), nil
}

// SetConfigOption applies exactly the type the provider advertised and replaces
// the whole catalog from the response. A model switch can change the effort and
// fast-mode options, so updating only the selected row would immediately make the
// rest of the UI stale.
func (c *conversation) SetConfigOption(
	ctx context.Context,
	id string,
	value ports.ChatConfigOptionValue,
) ([]ports.ChatConfigOption, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	sessionID := c.sessionID
	closed := c.closed
	legacyModel := c.legacyModel
	legacyMode := c.legacyMode
	var option *ports.ChatConfigOption
	for i := range c.configOptions {
		if c.configOptions[i].ID == id {
			snapshot := c.configOptions[i]
			option = &snapshot
			break
		}
	}
	c.mu.Unlock()

	if closed {
		return nil, errConversationClosed
	}
	if sessionID == "" {
		return nil, errors.New("ACP session is not open")
	}
	if option == nil {
		return nil, fmt.Errorf("%w: unknown ACP session config option %q", ports.ErrChatConfigOptionInvalid, id)
	}
	if id == "model" && legacyModel {
		if value.Boolean != nil || !choiceOffered(option.Choices, value.Select) {
			return nil, fmt.Errorf("%w: ACP session config option %q does not offer value %q", ports.ErrChatConfigOptionInvalid, id, value.Select)
		}
		if err := c.legacyWire.setModel(ctx, sessionID, value.Select); err != nil {
			return nil, fmt.Errorf("set ACP legacy session model %q: %w", value.Select, err)
		}
		c.applyAcceptedConfigOption(id, value)
		return c.ListConfigOptions(ctx)
	}
	if id == "mode" && legacyMode {
		if value.Boolean != nil || !choiceOffered(option.Choices, value.Select) {
			return nil, fmt.Errorf("%w: ACP session config option %q does not offer value %q", ports.ErrChatConfigOptionInvalid, id, value.Select)
		}
		if _, err := c.conn.SetSessionMode(ctx, acpsdk.SetSessionModeRequest{
			SessionId: acpsdk.SessionId(sessionID), ModeId: acpsdk.SessionModeId(value.Select),
		}); err != nil {
			return nil, fmt.Errorf("set ACP legacy session mode %q: %w", value.Select, err)
		}
		c.applyAcceptedConfigOption(id, value)
		return c.ListConfigOptions(ctx)
	}

	request := acpsdk.SetSessionConfigOptionRequest{}
	switch option.Type {
	case ports.ChatConfigOptionSelect:
		if value.Boolean != nil {
			return nil, fmt.Errorf("%w: ACP session config option %q requires a select value", ports.ErrChatConfigOptionInvalid, id)
		}
		if !choiceOffered(option.Choices, value.Select) {
			return nil, fmt.Errorf("%w: ACP session config option %q does not offer value %q", ports.ErrChatConfigOptionInvalid, id, value.Select)
		}
		request.ValueId = &acpsdk.SetSessionConfigOptionValueId{
			SessionId: acpsdk.SessionId(sessionID),
			ConfigId:  acpsdk.SessionConfigId(id),
			Value:     acpsdk.SessionConfigValueId(value.Select),
		}
	case ports.ChatConfigOptionBoolean:
		if value.Boolean == nil {
			return nil, fmt.Errorf("%w: ACP session config option %q requires a boolean value", ports.ErrChatConfigOptionInvalid, id)
		}
		request.Boolean = &acpsdk.SetSessionConfigOptionBoolean{
			SessionId: acpsdk.SessionId(sessionID),
			ConfigId:  acpsdk.SessionConfigId(id),
			Value:     *value.Boolean,
		}
	default:
		return nil, fmt.Errorf("%w: ACP session config option %q has unsupported type %q", ports.ErrChatConfigOptionInvalid, id, option.Type)
	}

	resp, err := c.conn.SetSessionConfigOption(ctx, request)
	if err != nil {
		return nil, fmt.Errorf("set ACP session config option %q: %w", id, err)
	}
	// ACP marks the response's configOptions required and defines it as the full
	// rebuilt catalog, but some agents accept the change and answer without it.
	// Replacing wholesale on that emptied the catalog and made the entire
	// turn-settings picker vanish mid-session. Returning the pre-change catalog
	// instead would be just as wrong in the other direction — the agent applied
	// the value, so a UI that snaps back to the old one is lying about state the
	// provider already changed. Record the accepted value against the catalog we
	// hold and let a later ConfigOptionUpdate deliver any rebuild.
	if len(resp.ConfigOptions) == 0 {
		c.applyAcceptedConfigOption(id, value)
	} else {
		c.replaceConfigOptions(resp.ConfigOptions)
	}
	return c.ListConfigOptions(ctx)
}

// replaceConfigOptions installs an authoritative catalog. Callers reach this
// with a replacement the agent stated outright — the session/update
// notification and session setup — so an empty list means the session really
// has no options and is applied as given.
func (c *conversation) replaceConfigOptions(options []acpsdk.SessionConfigOption) {
	normalized := normalizeConfigOptions(options)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.configOptions = normalized
	if len(normalized) > 0 {
		c.capabilities[ports.ChatCapabilityConfigOptions] = true
	}
}

// applyAcceptedConfigOption records a value the agent accepted but did not echo
// a catalog for. Only the selected option moves; anything the change should have
// rebuilt stays as it was until the agent says otherwise, which is the most this
// can honestly claim from a response that carried no catalog.
func (c *conversation) applyAcceptedConfigOption(id string, value ports.ChatConfigOptionValue) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := range c.configOptions {
		if c.configOptions[i].ID != id {
			continue
		}
		switch c.configOptions[i].Type {
		case ports.ChatConfigOptionSelect:
			c.configOptions[i].Current = ports.ChatConfigOptionValue{Select: value.Select}
		case ports.ChatConfigOptionBoolean:
			if value.Boolean != nil {
				accepted := *value.Boolean
				c.configOptions[i].Current = ports.ChatConfigOptionValue{Boolean: &accepted}
			}
		}
		return
	}
}

func normalizeConfigOptions(options []acpsdk.SessionConfigOption) []ports.ChatConfigOption {
	out := make([]ports.ChatConfigOption, 0, len(options))
	for _, option := range options {
		switch {
		case option.Select != nil:
			selectOption := option.Select
			out = append(out, ports.ChatConfigOption{
				ID:          string(selectOption.Id),
				Name:        selectOption.Name,
				Description: stringValue(selectOption.Description),
				Category:    configCategory(selectOption.Category),
				Type:        ports.ChatConfigOptionSelect,
				Current: ports.ChatConfigOptionValue{
					Select: string(selectOption.CurrentValue),
				},
				Choices: normalizeSelectChoices(selectOption.Options),
			})
		case option.Boolean != nil:
			booleanOption := option.Boolean
			current := booleanOption.CurrentValue
			out = append(out, ports.ChatConfigOption{
				ID:          string(booleanOption.Id),
				Name:        booleanOption.Name,
				Description: stringValue(booleanOption.Description),
				Category:    configCategory(booleanOption.Category),
				Type:        ports.ChatConfigOptionBoolean,
				Current: ports.ChatConfigOptionValue{
					Boolean: &current,
				},
			})
		}
	}
	return out
}

func normalizeSessionOptions(
	options []acpsdk.SessionConfigOption,
	models *legacySessionModelState,
	modes *acpsdk.SessionModeState,
) []ports.ChatConfigOption {
	out := normalizeConfigOptions(options)
	seen := make(map[string]bool, len(out))
	for _, option := range out {
		seen[option.ID] = true
	}
	if models != nil && !seen["model"] {
		choices := make([]ports.ChatConfigOptionChoice, 0, len(models.Available))
		for _, model := range models.Available {
			choices = append(choices, ports.ChatConfigOptionChoice{
				Value: model.ModelID, Name: model.Name, Description: stringValue(model.Description),
			})
		}
		out = append(out, ports.ChatConfigOption{
			ID: "model", Name: "Model", Category: "model", Type: ports.ChatConfigOptionSelect,
			Current: ports.ChatConfigOptionValue{Select: models.CurrentModelID}, Choices: choices,
		})
	}
	if modes != nil && !seen["mode"] {
		choices := make([]ports.ChatConfigOptionChoice, 0, len(modes.AvailableModes))
		for _, mode := range modes.AvailableModes {
			choices = append(choices, ports.ChatConfigOptionChoice{
				Value: string(mode.Id), Name: mode.Name, Description: stringValue(mode.Description),
			})
		}
		out = append(out, ports.ChatConfigOption{
			ID: "mode", Name: "Mode", Category: "mode", Type: ports.ChatConfigOptionSelect,
			Current: ports.ChatConfigOptionValue{Select: string(modes.CurrentModeId)}, Choices: choices,
		})
	}
	return out
}

func normalizeSelectChoices(options acpsdk.SessionConfigSelectOptions) []ports.ChatConfigOptionChoice {
	if options.Ungrouped != nil {
		out := make([]ports.ChatConfigOptionChoice, 0, len(*options.Ungrouped))
		for _, option := range *options.Ungrouped {
			out = append(out, normalizeChoice(option, "", ""))
		}
		return out
	}
	if options.Grouped == nil {
		return nil
	}
	count := 0
	for _, group := range *options.Grouped {
		count += len(group.Options)
	}
	out := make([]ports.ChatConfigOptionChoice, 0, count)
	for _, group := range *options.Grouped {
		for _, option := range group.Options {
			out = append(out, normalizeChoice(option, string(group.Group), group.Name))
		}
	}
	return out
}

func normalizeChoice(option acpsdk.SessionConfigSelectOption, group, groupName string) ports.ChatConfigOptionChoice {
	return ports.ChatConfigOptionChoice{
		Value:       string(option.Value),
		Name:        option.Name,
		Description: stringValue(option.Description),
		Group:       group,
		GroupName:   groupName,
	}
}

func configCategory(category *acpsdk.SessionConfigOptionCategory) string {
	if category == nil {
		return ""
	}
	return string(*category)
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func choiceOffered(choices []ports.ChatConfigOptionChoice, value string) bool {
	for _, choice := range choices {
		if choice.Value == value {
			return true
		}
	}
	return false
}

func cloneConfigOptions(options []ports.ChatConfigOption) []ports.ChatConfigOption {
	out := make([]ports.ChatConfigOption, len(options))
	for i, option := range options {
		out[i] = option
		out[i].Choices = append([]ports.ChatConfigOptionChoice(nil), option.Choices...)
		if option.Current.Boolean != nil {
			current := *option.Current.Boolean
			out[i].Current.Boolean = &current
		}
	}
	return out
}
