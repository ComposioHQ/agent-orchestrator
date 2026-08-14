package usage

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pricing"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// Break caught: historical replay could consume a live suffix or rewrite the
// production cursor/parser baseline while repairing an already-durable event.
func TestLegacyRepairerPricesDurablePrefixAndPreservesCursorState(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	store, source, path, now := seedCodexIngestionSource(t, dataDir)
	content := legacyCodexTranscript(true)
	mustNoError(t, os.WriteFile(path, []byte(content), 0o600))
	ingestor := NewIngestor(store, IngestorConfig{Clock: func() time.Time { return now }})
	ingestSourceFully(ctx, t, ingestor, source.ID)
	before, ok, err := store.GetUsageSourceForIngestion(ctx, source.ID)
	mustNoError(t, err)
	if !ok || before.Source.ByteOffset != int64(len(content)) {
		t.Fatalf("durable source = %+v ok=%v", before.Source, ok)
	}
	makeLegacyProviderNull(t, dataDir, source.ID)

	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	mustNoError(t, err)
	_, err = file.WriteString(string(codexTokenLine("suffix", 200, 100, 0, 40, 10)) + "\n")
	mustNoError(t, err)
	mustNoError(t, file.Close())

	snapshot := testPricingSnapshot(t, "0.000001")
	repairer := NewLegacyRepairer(store, pricing.NewManager(snapshot), LegacyRepairerConfig{
		Clock: func() time.Time { return now.Add(time.Hour) },
	})
	mustNoError(t, repairer.Run(ctx))

	assertLegacyRepair(t, dataDir, source.ID, "openai", 86_000, snapshot.ProviderVersion("openai"))
	after, ok, err := store.GetUsageSourceForIngestion(ctx, source.ID)
	mustNoError(t, err)
	if !ok || after.Source.ByteOffset != before.Source.ByteOffset ||
		after.Source.ParserStateJSON != before.Source.ParserStateJSON {
		t.Fatalf("repair changed cursor/parser: before=%+v after=%+v", before.Source, after.Source)
	}
}

// Break caught: source discovery facts are not enough to repair history; the
// exact generation, checkpoint, and generic event facts must still agree.
func TestLegacyRepairerRefusesUnverifiableSourcesAndMismatchedEvents(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*testing.T, string, string, *sqlite.Store, int64)
	}{
		{
			name: "missing transcript",
			mutate: func(t *testing.T, _ string, path string, _ *sqlite.Store, _ int64) {
				mustNoError(t, os.Remove(path))
			},
		},
		{
			name: "replaced transcript identity",
			mutate: func(t *testing.T, _ string, path string, _ *sqlite.Store, _ int64) {
				mustNoError(t, os.Remove(path))
				mustNoError(t, os.WriteFile(path, []byte(legacyCodexTranscript(true)), 0o600))
			},
		},
		{
			name: "checkpoint mismatch",
			mutate: func(t *testing.T, _ string, path string, _ *sqlite.Store, _ int64) {
				file, err := os.OpenFile(path, os.O_WRONLY, 0o600)
				mustNoError(t, err)
				_, err = file.WriteAt([]byte("X"), 0)
				mustNoError(t, err)
				mustNoError(t, file.Close())
			},
		},
		{
			name: "generic event mismatch",
			mutate: func(t *testing.T, dataDir string, _ string, _ *sqlite.Store, sourceID int64) {
				db := openUsageRawDB(t, dataDir)
				_, err := db.Exec(`UPDATE model_usage_events SET model_id = 'raced-model'
WHERE usage_source_id = ?`, sourceID)
				mustNoError(t, err)
			},
		},
		{
			name: "retired replacement source",
			mutate: func(t *testing.T, dataDir string, _ string, _ *sqlite.Store, sourceID int64) {
				db := openUsageRawDB(t, dataDir)
				_, err := db.Exec(`UPDATE usage_sources
SET state = 'complete', last_error_code = 'artifact_replaced' WHERE id = ?`, sourceID)
				mustNoError(t, err)
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			dataDir := t.TempDir()
			store, source, path, now := seedCodexIngestionSource(t, dataDir)
			mustNoError(t, os.WriteFile(path, []byte(legacyCodexTranscript(true)), 0o600))
			ingestSourceFully(ctx, t, NewIngestor(store, IngestorConfig{
				Clock: func() time.Time { return now },
			}), source.ID)
			makeLegacyProviderNull(t, dataDir, source.ID)
			tt.mutate(t, dataDir, path, store, source.ID)

			repairer := NewLegacyRepairer(store, pricing.NewManager(testPricingSnapshot(t, "0.000001")), LegacyRepairerConfig{})
			mustNoError(t, repairer.Run(ctx))
			assertLegacyStillNull(t, dataDir, source.ID)
		})
	}
}

// Break caught: a finalized valid record without a newline is durable and
// therefore must be replayed, rather than silently omitted as a live tail.
func TestLegacyRepairerReplaysFinalizedNoNewlineRecord(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	store, source, path, now := seedCodexIngestionSource(t, dataDir)
	content := legacyCodexTranscript(false)
	mustNoError(t, os.WriteFile(path, []byte(content), 0o600))
	_, err := store.UpdateUsageBindingState(ctx, source.BindingID, domain.UsageBindingFinalizing, "", now)
	mustNoError(t, err)
	clock := now
	ingestor := NewIngestor(store, IngestorConfig{
		Clock: func() time.Time { return clock }, FinalizationWait: time.Second,
	})
	_, _ = ingestor.Ingest(ctx, source.ID)
	clock = clock.Add(2 * time.Second)
	_, err = ingestor.Ingest(ctx, source.ID)
	mustNoError(t, err)
	makeLegacyProviderNull(t, dataDir, source.ID)

	snapshot := testPricingSnapshot(t, "0.000001")
	mustNoError(t, NewLegacyRepairer(store, pricing.NewManager(snapshot), LegacyRepairerConfig{}).Run(ctx))
	assertLegacyRepair(t, dataDir, source.ID, "openai", 86_000, snapshot.ProviderVersion("openai"))
}

func legacyCodexTranscript(finalNewline bool) string {
	content := `{"type":"session_meta","payload":{"model_provider":"openai"}}` + "\n" +
		`{"type":"turn_context","payload":{"model":"gpt-test"}}` + "\n" +
		string(codexTokenLine("durable", 100, 60, 0, 20, 5))
	if finalNewline {
		content += "\n"
	}
	return content
}

func openUsageRawDB(t *testing.T, dataDir string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "ao.db"))
	mustNoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func makeLegacyProviderNull(t *testing.T, dataDir string, sourceID int64) {
	t.Helper()
	db := openUsageRawDB(t, dataDir)
	_, err := db.Exec(`UPDATE model_usage_events
SET provider_id = NULL, cache_write_5m_tokens = NULL,
    cache_write_1h_tokens = NULL, uncached_input_cost_nanos = NULL,
    cache_read_cost_nanos = NULL, cache_write_cost_nanos = NULL,
    output_cost_nanos = NULL, estimated_cost_nanos = NULL,
    pricing_version = ''
WHERE usage_source_id = ?`, sourceID)
	mustNoError(t, err)
}

func assertLegacyRepair(t *testing.T, dataDir string, sourceID int64, provider string, total int64, version string) {
	t.Helper()
	db := openUsageRawDB(t, dataDir)
	var gotProvider, gotVersion string
	var gotTotal int64
	mustNoError(t, db.QueryRow(`SELECT provider_id, estimated_cost_nanos, pricing_version
FROM model_usage_events WHERE usage_source_id = ?`, sourceID).Scan(&gotProvider, &gotTotal, &gotVersion))
	if gotProvider != provider || gotTotal != total || gotVersion != version {
		t.Fatalf("legacy repair = provider %q total %d version %q", gotProvider, gotTotal, gotVersion)
	}
}

func assertLegacyStillNull(t *testing.T, dataDir string, sourceID int64) {
	t.Helper()
	db := openUsageRawDB(t, dataDir)
	var provider sql.NullString
	mustNoError(t, db.QueryRow(`SELECT provider_id FROM model_usage_events
WHERE usage_source_id = ?`, sourceID).Scan(&provider))
	if provider.Valid {
		t.Fatalf("legacy provider = %q, want NULL", provider.String)
	}
}
