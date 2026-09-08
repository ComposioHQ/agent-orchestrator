-- Converge sessions.harness constraints after the independently-developed
-- Kimchi (0054) and Prime Agent (0082) migrations. Each older migration used
-- an exact sqlite_master replace, so whichever harness landed first caused the
-- other migration to no-op. Preserve legacy QM variants seen in dev databases.

-- +goose NO TRANSACTION
-- +goose Up
-- +goose StatementBegin
PRAGMA writable_schema = ON;
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE sqlite_master
SET sql = replace(sql,
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''kimchi'', ''autohand'', ''fake''))',
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''kimchi'', ''prime-agent'', ''autohand'', ''fake''))'
)
WHERE type = 'table' AND name = 'sessions';
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE sqlite_master
SET sql = replace(sql,
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''kimchi'', ''autohand'', ''qm'', ''fake''))',
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''kimchi'', ''prime-agent'', ''autohand'', ''qm'', ''fake''))'
)
WHERE type = 'table' AND name = 'sessions';
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE sqlite_master
SET sql = replace(sql,
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''prime-agent'', ''autohand'', ''fake''))',
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''kimchi'', ''prime-agent'', ''autohand'', ''fake''))'
)
WHERE type = 'table' AND name = 'sessions';
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE sqlite_master
SET sql = replace(sql,
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''prime-agent'', ''autohand'', ''qm'', ''fake''))',
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''kimchi'', ''prime-agent'', ''autohand'', ''qm'', ''fake''))'
)
WHERE type = 'table' AND name = 'sessions';
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE sqlite_master
SET sql = replace(sql,
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''autohand'', ''qm'', ''prime-agent'', ''fake''))',
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''kimchi'', ''prime-agent'', ''autohand'', ''qm'', ''fake''))'
)
WHERE type = 'table' AND name = 'sessions';
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE sqlite_master
SET sql = replace(sql,
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''autohand'', ''fake''))',
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''kimchi'', ''prime-agent'', ''autohand'', ''fake''))'
)
WHERE type = 'table' AND name = 'sessions';
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE sqlite_master
SET sql = replace(sql,
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''autohand'', ''qm'', ''fake''))',
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''kimchi'', ''prime-agent'', ''autohand'', ''qm'', ''fake''))'
)
WHERE type = 'table' AND name = 'sessions';
-- +goose StatementEnd
-- +goose StatementBegin
PRAGMA writable_schema = RESET;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
PRAGMA writable_schema = ON;
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE sqlite_master
SET sql = replace(sql,
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''kimchi'', ''prime-agent'', ''autohand'', ''fake''))',
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''kimchi'', ''autohand'', ''fake''))'
)
WHERE type = 'table' AND name = 'sessions';
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE sqlite_master
SET sql = replace(sql,
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''kimchi'', ''prime-agent'', ''autohand'', ''qm'', ''fake''))',
    'CHECK (harness IN ('''', ''claude-code'', ''codex'', ''aider'', ''opencode'', ''grok'', ''droid'', ''amp'', ''agy'', ''crush'', ''cursor'', ''qwen'', ''copilot'', ''goose'', ''auggie'', ''continue'', ''devin'', ''cline'', ''kimi'', ''muse'', ''kiro'', ''kilocode'', ''vibe'', ''pi'', ''kimchi'', ''autohand'', ''qm'', ''fake''))'
)
WHERE type = 'table' AND name = 'sessions';
-- +goose StatementEnd
-- +goose StatementBegin
PRAGMA writable_schema = RESET;
-- +goose StatementEnd
