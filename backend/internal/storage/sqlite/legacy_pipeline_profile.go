package sqlite

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

const (
	legacyPipelineArchivePrefix  = "_ao_legacy_pr2863_"
	legacyPipelineRecoveryMarker = legacyPipelineArchivePrefix + "recovery"
	legacyPipelineProfileID      = "v0.11.1-pr2863.202607311655"
)

var legacyPipelineLineageVersions = []int64{45, 46, 50, 51}

var legacyPipelineEventTypes = []string{
	"pipeline_artifact_updated",
	"pipeline_definition_changed",
	"pipeline_run_updated",
	"pipeline_stage_run_updated",
}

var publishedPipelineTableColumns = map[string][]string{
	"pipeline_definitions": {
		"id", "project_id", "name", "yaml_source", "config_json", "created_at", "updated_at",
	},
	"pipeline_runs": {
		"id", "project_id", "pipeline_id", "pipeline_name", "subject_kind", "session_id",
		"pr_number", "pr_repo", "pr_url", "head_sha", "pr_head_branch", "pr_base_branch",
		"from_fork", "status", "run_dir", "definition_json", "cancel_reason", "created_at",
		"updated_at", "settled_at", "run_number",
	},
	"pipeline_stage_runs": {
		"run_id", "project_id", "stage_id", "outcome", "attempt", "entered_via", "prev_stage",
		"failed_stage", "failed_outcome", "session_id", "workspace_kind", "workspace_path",
		"deadline_at", "started_at", "settled_at", "reason", "output_tail", "nudged", "pgid",
	},
	"pipeline_stage_signals": {
		"id", "run_id", "stage_id", "kind", "reason", "created_at",
	},
	"pipeline_credentials": {
		"project_id", "name", "env_json", "created_at", "updated_at",
	},
}

// Fingerprints are SHA-256 over lowercase, whitespace-collapsed sqlite_master
// SQL from the frozen published-release fixture. Column lists above keep
// diagnostics readable; these fingerprints also cover types, constraints,
// defaults, foreign keys, and complete trigger bodies.
var publishedPipelineSchemaFingerprints = map[string]string{ //nolint:gosec // SHA-256 schema fingerprints, not credentials.
	"pipeline_credentials":              "5274a0c3e184e268f3b24b29b20884befe3699e91d90221ca49946eb5af10ae8",
	"pipeline_definitions":              "8626c9a9e61637b225f994622555e5857beac4c12fb4a9b835c277f5c1fd8f9e",
	"pipeline_runs":                     "b56c3d27fc0de0a399dfb7ed16b832dbd5926b748f2abe6e9dd7527597a93628",
	"pipeline_stage_runs":               "41b69d599c0d7d1c0955f805931904f98925297c5e377600092f4d31f90495a9",
	"pipeline_stage_signals":            "ec8e23a0bf7eff69dcc7d6b5b2e6a1de4b628d7ebb327ffd5ad1d73fb87d2084",
	"pipeline_definitions_cdc_delete":   "f4c4fa4a1f7ed858134b5b216672d0f0fe80aa3a04f688183fe04faccd4584cf",
	"pipeline_definitions_cdc_insert":   "eb8595ec69ca2050e0f9059099ba263ebcf19e59b90f70b08485111559299cb6",
	"pipeline_definitions_cdc_update":   "54d3fc57cab96670089a2f350f3c1444f77ca94452831934001302019e6f92d2",
	"pipeline_runs_cdc_insert":          "2d2629319f99708d40c93ac13bf9a95b3c46b2104ba094f68ea6e1c8d55a8d54",
	"pipeline_runs_cdc_update":          "dc3a7b63333babd57baed224d0bf285bb45174cb8eb238f3d1fb5b455d92b494",
	"pipeline_stage_runs_cdc_insert":    "2e3babe9ae8c0cee6b7cb679434f94c7fcbcd2f20c29ecd58796a9528483bac9",
	"pipeline_stage_runs_cdc_update":    "0c461c9d2211109c9aaa05fd4d3aae2068ab759ee1061b8a9eaade31d4cdbe20",
	"idx_pipeline_runs_number":          "f094a489d151e7233f30adba6aa0efd34878199e5960f65b320c2b6819a0c00f",
	"idx_pipeline_runs_project_created": "507bf16ed0033fd54aa88340bda6750aca14d1c236002b6d2e59b54b6e73335b",
	"idx_pipeline_runs_unsettled":       "60d439e5d2594f95e233baad8834020884cd5afb60edfaa901ba9a51b788e9ef",
	"idx_pipeline_stage_signals_stage":  "917ad4b5afba41e68ac001942a24c29e729fca50efb783d5f1d0b2d19575c549",
}

type publishedPipelineIndex struct {
	table string
}

var publishedPipelineIndexes = map[string]publishedPipelineIndex{
	"idx_pipeline_runs_number":          {table: "pipeline_runs"},
	"idx_pipeline_runs_project_created": {table: "pipeline_runs"},
	"idx_pipeline_runs_unsettled":       {table: "pipeline_runs"},
	"idx_pipeline_stage_signals_stage":  {table: "pipeline_stage_signals"},
}

type publishedPipelineTrigger struct {
	table string
}

var publishedPipelineTriggers = map[string]publishedPipelineTrigger{
	"pipeline_definitions_cdc_insert": {table: "pipeline_definitions"},
	"pipeline_definitions_cdc_update": {table: "pipeline_definitions"},
	"pipeline_definitions_cdc_delete": {table: "pipeline_definitions"},
	"pipeline_runs_cdc_insert":        {table: "pipeline_runs"},
	"pipeline_runs_cdc_update":        {table: "pipeline_runs"},
	"pipeline_stage_runs_cdc_insert":  {table: "pipeline_stage_runs"},
	"pipeline_stage_runs_cdc_update":  {table: "pipeline_stage_runs"},
}

type legacyProfileQuerier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type appSettingsProfile int

const (
	appSettingsAbsent appSettingsProfile = iota
	appSettingsLegacyKeyValue
	appSettingsCanonical
)

// retirePublishedPipelinesProfile retires the database profile created by the
// published Pipelines feature release v0.11.1-pr2863.202607311655. Destructive
// authority comes from migration versions that the feature release applied but
// main never owned, followed by exact validation of every live legacy object.
// Unknown or mixed profiles fail before the transaction performs any write.
func retirePublishedPipelinesProfile(ctx context.Context, db *sql.DB) error {
	gooseExists, err := legacyTableExists(ctx, db, "goose_db_version")
	if err != nil || !gooseExists {
		return err
	}
	completed, err := publishedPipelineRetirementRecorded(ctx, db)
	if err != nil || completed {
		return err
	}

	lineageCount, err := appliedLineageCount(ctx, db)
	if err != nil {
		return err
	}
	applied103, err := latestMigrationApplied(ctx, db, 103)
	if err != nil {
		return err
	}
	// Current-main databases cannot contain a live published-Pipelines profile:
	// they have no foreign lineage and migration 103's CHECK constraint rejects
	// the retired event types. Returning here also leaves future pipeline_* names
	// outside this one-time compatibility shim's authority.
	if lineageCount == 0 && applied103 {
		return nil
	}
	hasHints, err := hasPublishedPipelineHints(ctx, db, !applied103)
	if err != nil {
		return err
	}
	if !hasHints {
		return nil
	}
	if lineageCount != len(legacyPipelineLineageVersions) {
		return fmt.Errorf(
			"unsupported legacy Pipelines profile: %d/%d lineage migrations applied (need 45, 46, 50, and 51)",
			lineageCount, len(legacyPipelineLineageVersions),
		)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if count, err := appliedLineageCount(ctx, tx); err != nil {
		return err
	} else if count != len(legacyPipelineLineageVersions) {
		return fmt.Errorf("legacy Pipelines lineage changed during recovery inspection")
	}
	if err := retirePublishedPipelinesProfileTx(ctx, tx); err != nil {
		return err
	}
	return tx.Commit()
}

func retirePublishedPipelinesProfileTx(ctx context.Context, tx *sql.Tx) error {
	completed, err := publishedPipelineRetirementRecorded(ctx, tx)
	if err != nil {
		return err
	}
	if completed {
		return nil
	}
	settingsProfile, err := inspectAppSettingsProfile(ctx, tx)
	if err != nil {
		return err
	}
	settingsArchive := legacyPipelineArchivePrefix + "app_settings"
	settingsArchiveExists, err := legacyTableExists(ctx, tx, settingsArchive)
	if err != nil {
		return err
	}
	if settingsProfile == appSettingsAbsent {
		return fmt.Errorf("unsupported legacy Pipelines profile: app_settings is missing")
	}
	if settingsProfile == appSettingsLegacyKeyValue && settingsArchiveExists {
		return fmt.Errorf("unsupported legacy Pipelines profile: live and archived app_settings both exist")
	}

	defaultMode := ""
	if settingsProfile == appSettingsLegacyKeyValue {
		defaultMode, err = validateLegacyPipelineSettings(ctx, tx)
		if err != nil {
			return err
		}
	}

	activeTables, err := inspectPublishedPipelineTables(ctx, tx)
	if err != nil {
		return err
	}
	if err := inspectPublishedPipelineIndexes(ctx, tx, activeTables); err != nil {
		return err
	}
	triggerNames, err := inspectPublishedPipelineTriggers(ctx, tx)
	if err != nil {
		return err
	}

	for _, table := range activeTables {
		archive := legacyPipelineArchivePrefix + table
		exists, err := legacyTableExists(ctx, tx, archive)
		if err != nil {
			return err
		}
		if exists {
			return fmt.Errorf("unsupported legacy Pipelines profile: live and archived %s both exist", table)
		}
	}

	changeLogExists, err := legacyTableExists(ctx, tx, "change_log")
	if err != nil {
		return err
	}
	if !changeLogExists {
		return fmt.Errorf("unsupported legacy Pipelines profile: change_log is missing")
	}
	if err := validatePublishedPipelineEvents(ctx, tx); err != nil {
		return err
	}
	archiveChangeLog := legacyPipelineArchivePrefix + "change_log"
	archiveChangeLogExists, err := legacyTableExists(ctx, tx, archiveChangeLog)
	if err != nil {
		return err
	}
	livePipelineEvents, err := countPipelineEvents(ctx, tx, "change_log")
	if err != nil {
		return err
	}
	if archiveChangeLogExists && livePipelineEvents > 0 {
		return fmt.Errorf("unsupported legacy Pipelines profile: live and archived pipeline change-log rows both exist")
	}

	applied67, err := latestMigrationApplied(ctx, tx, 67)
	if err != nil {
		return err
	}
	applied105, err := latestMigrationApplied(ctx, tx, 105)
	if err != nil {
		return err
	}
	if settingsProfile == appSettingsLegacyKeyValue {
		if defaultMode == "" {
			if applied105 {
				defaultMode = "chat"
			} else {
				defaultMode = "tui"
			}
		}
		if _, err := tx.ExecContext(ctx,
			`ALTER TABLE app_settings RENAME TO `+quoteSQLiteIdent(settingsArchive),
		); err != nil {
			return fmt.Errorf("archive legacy app settings: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
CREATE TABLE app_settings (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    default_session_mode TEXT NOT NULL DEFAULT 'tui'
        CHECK (default_session_mode IN ('chat', 'tui')),
    updated_at           TIMESTAMP NOT NULL
);
INSERT INTO app_settings (id, default_session_mode, updated_at)
VALUES (1, ?, CURRENT_TIMESTAMP);`, defaultMode); err != nil {
			return fmt.Errorf("create canonical app settings: %w", err)
		}
	}
	if !applied67 {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO goose_db_version (version_id, is_applied) VALUES (67, 1)`,
		); err != nil {
			return fmt.Errorf("record app settings migration 67: %w", err)
		}
	}

	if !archiveChangeLogExists {
		if _, err := tx.ExecContext(ctx, `
CREATE TABLE `+quoteSQLiteIdent(archiveChangeLog)+` AS
SELECT seq, project_id, session_id, event_type, payload, created_at
FROM change_log
WHERE event_type IN (
    'pipeline_definition_changed',
    'pipeline_run_updated',
    'pipeline_stage_run_updated',
    'pipeline_artifact_updated'
);`); err != nil {
			return fmt.Errorf("archive legacy pipeline change log: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `
DELETE FROM change_log
WHERE event_type IN (
    'pipeline_definition_changed',
    'pipeline_run_updated',
    'pipeline_stage_run_updated',
    'pipeline_artifact_updated'
);`); err != nil {
		return fmt.Errorf("remove archived pipeline change-log rows: %w", err)
	}

	for _, name := range triggerNames {
		if _, err := tx.ExecContext(ctx, `DROP TRIGGER `+quoteSQLiteIdent(name)); err != nil {
			return fmt.Errorf("drop legacy pipeline trigger %s: %w", name, err)
		}
	}

	for _, table := range activeTables {
		archive := legacyPipelineArchivePrefix + table
		if _, err := tx.ExecContext(ctx,
			`CREATE TABLE `+quoteSQLiteIdent(archive)+` AS SELECT * FROM `+quoteSQLiteIdent(table),
		); err != nil {
			return fmt.Errorf("archive legacy pipeline table %s: %w", table, err)
		}
		var sourceRows, archivedRows int
		if err := tx.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM `+quoteSQLiteIdent(table),
		).Scan(&sourceRows); err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM `+quoteSQLiteIdent(archive),
		).Scan(&archivedRows); err != nil {
			return err
		}
		if sourceRows != archivedRows {
			return fmt.Errorf("archive legacy pipeline table %s: copied %d/%d rows", table, archivedRows, sourceRows)
		}
	}
	for _, table := range []string{
		"pipeline_stage_signals",
		"pipeline_stage_runs",
		"pipeline_credentials",
		"pipeline_runs",
		"pipeline_definitions",
	} {
		if !containsString(activeTables, table) {
			continue
		}
		if _, err := tx.ExecContext(ctx, `DROP TABLE `+quoteSQLiteIdent(table)); err != nil {
			return fmt.Errorf("retire legacy pipeline table %s: %w", table, err)
		}
	}

	if err := verifyPublishedPipelineRetirement(ctx, tx); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
CREATE TABLE `+quoteSQLiteIdent(legacyPipelineRecoveryMarker)+` (
    profile_id   TEXT PRIMARY KEY,
    completed_at TIMESTAMP NOT NULL
);
INSERT INTO `+quoteSQLiteIdent(legacyPipelineRecoveryMarker)+` (profile_id, completed_at)
VALUES (?, CURRENT_TIMESTAMP);`, legacyPipelineProfileID); err != nil {
		return fmt.Errorf("record legacy Pipelines retirement: %w", err)
	}
	return nil
}

func hasPublishedPipelineHints(ctx context.Context, q legacyProfileQuerier, inspectEvents bool) (bool, error) {
	var objects int
	if err := q.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM sqlite_master
WHERE (type IN ('table', 'trigger') AND name GLOB 'pipeline_*')
   OR (type = 'table' AND name GLOB ?)`, legacyPipelineArchivePrefix+"*").Scan(&objects); err != nil {
		return false, err
	}
	if objects > 0 {
		return true, nil
	}
	profile, err := inspectAppSettingsProfile(ctx, q)
	if err != nil {
		return false, err
	}
	if profile == appSettingsLegacyKeyValue {
		return true, nil
	}
	if !inspectEvents {
		return false, nil
	}
	changeLogExists, err := legacyTableExists(ctx, q, "change_log")
	if err != nil || !changeLogExists {
		return false, err
	}
	return hasPipelinePrefixedEvents(ctx, q)
}

func publishedPipelineRetirementRecorded(ctx context.Context, q legacyProfileQuerier) (bool, error) {
	exists, err := legacyTableExists(ctx, q, legacyPipelineRecoveryMarker)
	if err != nil || !exists {
		return false, err
	}
	columns, err := legacyTableColumns(ctx, q, legacyPipelineRecoveryMarker)
	if err != nil {
		return false, err
	}
	if !equalStringSlices(columns, []string{"profile_id", "completed_at"}) {
		return false, fmt.Errorf("invalid legacy Pipelines recovery marker columns: %v", columns)
	}
	var total, matching int
	if err := q.QueryRowContext(ctx,
		`SELECT COUNT(*), COUNT(*) FILTER (WHERE profile_id = ? AND completed_at IS NOT NULL)
FROM `+quoteSQLiteIdent(legacyPipelineRecoveryMarker),
		legacyPipelineProfileID,
	).Scan(&total, &matching); err != nil {
		return false, err
	}
	if total != 1 || matching != 1 {
		return false, fmt.Errorf("invalid legacy Pipelines recovery marker contents")
	}
	return true, nil
}

func appliedLineageCount(ctx context.Context, q legacyProfileQuerier) (int, error) {
	count := 0
	for _, version := range legacyPipelineLineageVersions {
		applied, err := latestMigrationApplied(ctx, q, version)
		if err != nil {
			return 0, err
		}
		if applied {
			count++
		}
	}
	return count, nil
}

func latestMigrationApplied(ctx context.Context, q legacyProfileQuerier, version int64) (bool, error) {
	var applied int
	if err := q.QueryRowContext(ctx, `
SELECT COALESCE((
    SELECT is_applied FROM goose_db_version
    WHERE version_id = ? ORDER BY id DESC LIMIT 1
), 0)`, version).Scan(&applied); err != nil {
		return false, err
	}
	return applied != 0, nil
}

func legacyTableExists(ctx context.Context, q legacyProfileQuerier, name string) (bool, error) {
	var count int
	if err := q.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, name,
	).Scan(&count); err != nil {
		return false, err
	}
	return count != 0, nil
}

type legacyColumnInfo struct {
	name       string
	columnType string
	notNull    int
	primaryKey int
}

func inspectAppSettingsProfile(ctx context.Context, q legacyProfileQuerier) (appSettingsProfile, error) {
	exists, err := legacyTableExists(ctx, q, "app_settings")
	if err != nil || !exists {
		return appSettingsAbsent, err
	}
	rows, err := q.QueryContext(ctx, `SELECT name, type, "notnull", pk FROM pragma_table_xinfo('app_settings') ORDER BY cid`)
	if err != nil {
		return appSettingsAbsent, err
	}
	defer func() { _ = rows.Close() }()
	columns := []legacyColumnInfo{}
	for rows.Next() {
		var column legacyColumnInfo
		if err := rows.Scan(&column.name, &column.columnType, &column.notNull, &column.primaryKey); err != nil {
			return appSettingsAbsent, err
		}
		columns = append(columns, column)
	}
	if err := rows.Err(); err != nil {
		return appSettingsAbsent, err
	}
	if len(columns) == 2 &&
		columns[0].name == "key" && strings.EqualFold(columns[0].columnType, "TEXT") && columns[0].primaryKey == 1 &&
		columns[1].name == "value" && strings.EqualFold(columns[1].columnType, "TEXT") && columns[1].notNull == 1 {
		return appSettingsLegacyKeyValue, nil
	}

	required := map[string]bool{
		"id":                   false,
		"default_session_mode": false,
		"updated_at":           false,
	}
	for _, column := range columns {
		if _, ok := required[column.name]; ok {
			required[column.name] = true
		}
	}
	if required["id"] && required["default_session_mode"] && required["updated_at"] {
		return appSettingsCanonical, nil
	}
	columnNames := make([]string, 0, len(columns))
	for _, column := range columns {
		columnNames = append(columnNames, column.name)
	}
	return appSettingsAbsent, fmt.Errorf("unsupported legacy Pipelines profile: app_settings columns are %v", columnNames)
}

func validateLegacyPipelineSettings(ctx context.Context, q legacyProfileQuerier) (string, error) {
	rows, err := q.QueryContext(ctx, `SELECT key, value FROM app_settings ORDER BY key`)
	if err != nil {
		return "", err
	}
	defer func() { _ = rows.Close() }()
	defaultMode := ""
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return "", err
		}
		switch key {
		case "pipelines.enabled":
			if value != "true" && value != "false" {
				return "", fmt.Errorf("unsupported legacy Pipelines setting pipelines.enabled=%q", value)
			}
		case "default_session_mode":
			if value != "chat" && value != "tui" {
				return "", fmt.Errorf("unsupported legacy Pipelines setting default_session_mode=%q", value)
			}
			defaultMode = value
		default:
			return "", fmt.Errorf("unsupported legacy Pipelines setting key %q", key)
		}
	}
	return defaultMode, rows.Err()
}

func inspectPublishedPipelineTables(ctx context.Context, q legacyProfileQuerier) ([]string, error) {
	rows, err := q.QueryContext(ctx, `
SELECT name, COALESCE(sql, '') FROM sqlite_master
WHERE type = 'table' AND name GLOB 'pipeline_*'
ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	tables := []string{}
	definitions := map[string]string{}
	for rows.Next() {
		var table, definition string
		if err := rows.Scan(&table, &definition); err != nil {
			return nil, err
		}
		tables = append(tables, table)
		definitions[table] = definition
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, table := range tables {
		want, ok := publishedPipelineTableColumns[table]
		if !ok {
			return nil, fmt.Errorf("unsupported legacy Pipelines table %q", table)
		}
		got, err := legacyTableColumns(ctx, q, table)
		if err != nil {
			return nil, err
		}
		if !equalStringSlices(got, want) {
			return nil, fmt.Errorf("unsupported legacy Pipelines table %s columns: got %v, want %v", table, got, want)
		}
		if !matchesPublishedPipelineSchema(table, definitions[table]) {
			return nil, fmt.Errorf("unsupported legacy Pipelines table definition %q", table)
		}
	}
	return tables, nil
}

func inspectPublishedPipelineIndexes(ctx context.Context, q legacyProfileQuerier, activeTables []string) error {
	rows, err := q.QueryContext(ctx, `
SELECT name, tbl_name, COALESCE(sql, '')
FROM sqlite_master
WHERE type = 'index' AND tbl_name GLOB 'pipeline_*' AND sql IS NOT NULL
ORDER BY name`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	found := map[string]bool{}
	for rows.Next() {
		var name, table, definition string
		if err := rows.Scan(&name, &table, &definition); err != nil {
			return err
		}
		spec, ok := publishedPipelineIndexes[name]
		if !ok || table != spec.table || !matchesPublishedPipelineSchema(name, definition) {
			return fmt.Errorf("unsupported legacy Pipelines index %q", name)
		}
		found[name] = true
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for name, spec := range publishedPipelineIndexes {
		if containsString(activeTables, spec.table) && !found[name] {
			return fmt.Errorf("unsupported legacy Pipelines profile: index %q is missing", name)
		}
	}
	return nil
}

func inspectPublishedPipelineTriggers(ctx context.Context, q legacyProfileQuerier) ([]string, error) {
	rows, err := q.QueryContext(ctx, `
SELECT name, tbl_name, COALESCE(sql, '')
FROM sqlite_master
WHERE type = 'trigger'
  AND (name GLOB 'pipeline_*' OR tbl_name GLOB 'pipeline_*')
ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	names := []string{}
	for rows.Next() {
		var name, table, definition string
		if err := rows.Scan(&name, &table, &definition); err != nil {
			return nil, err
		}
		spec, ok := publishedPipelineTriggers[name]
		if !ok {
			return nil, fmt.Errorf("unsupported legacy Pipelines trigger %q", name)
		}
		if table != spec.table || !matchesPublishedPipelineSchema(name, definition) {
			return nil, fmt.Errorf("unsupported legacy Pipelines trigger definition %q", name)
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return names, nil
}

func legacyTableColumns(ctx context.Context, q legacyProfileQuerier, table string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT name FROM pragma_table_xinfo(?) ORDER BY cid`, table)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	columns := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		columns = append(columns, name)
	}
	return columns, rows.Err()
}

func hasPipelinePrefixedEvents(ctx context.Context, q legacyProfileQuerier) (bool, error) {
	var found int
	if err := q.QueryRowContext(ctx, `
SELECT EXISTS (
    SELECT 1 FROM change_log WHERE event_type GLOB 'pipeline_*' LIMIT 1
)`).Scan(&found); err != nil {
		return false, err
	}
	return found != 0, nil
}

func validatePublishedPipelineEvents(ctx context.Context, q legacyProfileQuerier) error {
	rows, err := q.QueryContext(ctx, `
SELECT DISTINCT event_type
FROM change_log
WHERE event_type GLOB 'pipeline_*'
ORDER BY event_type`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var eventType string
		if err := rows.Scan(&eventType); err != nil {
			return err
		}
		if !containsString(legacyPipelineEventTypes, eventType) {
			return fmt.Errorf("unsupported legacy Pipelines change-log event type %q", eventType)
		}
	}
	return rows.Err()
}

func countPipelineEvents(ctx context.Context, q legacyProfileQuerier, table string) (int, error) {
	var count int
	query := `SELECT COUNT(*) FROM ` + quoteSQLiteIdent(table) + ` WHERE event_type IN (?, ?, ?, ?)`
	if err := q.QueryRowContext(ctx, query,
		legacyPipelineEventTypes[0],
		legacyPipelineEventTypes[1],
		legacyPipelineEventTypes[2],
		legacyPipelineEventTypes[3],
	).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func verifyPublishedPipelineRetirement(ctx context.Context, q legacyProfileQuerier) error {
	profile, err := inspectAppSettingsProfile(ctx, q)
	if err != nil {
		return err
	}
	if profile != appSettingsCanonical {
		return fmt.Errorf("legacy Pipelines recovery left app_settings noncanonical")
	}
	applied67, err := latestMigrationApplied(ctx, q, 67)
	if err != nil {
		return err
	}
	if !applied67 {
		return fmt.Errorf("legacy Pipelines recovery did not record migration 67")
	}
	activeTables, err := inspectPublishedPipelineTables(ctx, q)
	if err != nil {
		return err
	}
	if len(activeTables) != 0 {
		return fmt.Errorf("legacy Pipelines recovery left active tables %v", activeTables)
	}
	triggers, err := inspectPublishedPipelineTriggers(ctx, q)
	if err != nil {
		return err
	}
	if len(triggers) != 0 {
		return fmt.Errorf("legacy Pipelines recovery left active triggers %v", triggers)
	}
	changeLogExists, err := legacyTableExists(ctx, q, "change_log")
	if err != nil {
		return err
	}
	if changeLogExists {
		count, err := countPipelineEvents(ctx, q, "change_log")
		if err != nil {
			return err
		}
		if count != 0 {
			return fmt.Errorf("legacy Pipelines recovery left %d live pipeline change-log rows", count)
		}
	}
	rows, err := q.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	if rows.Next() {
		return fmt.Errorf("legacy Pipelines recovery failed foreign-key verification")
	}
	return rows.Err()
}

func equalStringSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func containsString(values []string, target string) bool {
	i := sort.SearchStrings(values, target)
	return i < len(values) && values[i] == target
}

func matchesPublishedPipelineSchema(name, definition string) bool {
	want, ok := publishedPipelineSchemaFingerprints[name]
	if !ok {
		return false
	}
	normalized := strings.Join(strings.Fields(strings.ToLower(definition)), " ")
	sum := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(sum[:]) == want
}
