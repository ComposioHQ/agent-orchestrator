package catalogsync

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Break caught: emitting raw upstream names, floating-point spellings, or a
// provider blob whose address is not its exact canonical JSON bytes.
func TestSyncWritesCanonicalContentAddressedCatalog(t *testing.T) {
	root := t.TempDir()
	upstream := []byte(`{
  "OpenAI/GPT-4o": {
    "litellm_provider": " OpenAI ",
    "mode": "responses",
    "input_cost_per_token": 1e-6,
    "output_cost_per_token": 0,
    "cache_read_input_token_cost": 0
  },
  "zai/GLM-4.5": {
    "litellm_provider": "z.ai",
    "mode": "chat",
    "input_cost_per_token": 0.000002,
    "output_cost_per_token": 0.000004
  },
  "anthropic/claude-test": {
    "litellm_provider": "anthropic",
    "mode": "chat",
    "input_cost_per_token": 0.000003,
    "output_cost_per_token": 0.000015,
    "cache_creation_input_token_cost": 0.00000375,
    "cache_creation_input_token_cost_1hr": 0.000006
  }
}`)

	result, err := Sync(root, upstream, Source{
		Repository: "BerriAI/litellm",
		Revision:   "0123456789abcdef0123456789abcdef01234567",
		Path:       "model_prices_and_context_window.json",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed {
		t.Fatal("Sync changed = false, want true")
	}

	manifest, err := os.ReadFile(filepath.Join(root, "pricing/catalog/v1/manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	wantManifest := `{"schemaVersion":1,"source":{"repository":"BerriAI/litellm","revision":"0123456789abcdef0123456789abcdef01234567","path":"model_prices_and_context_window.json"},"providers":[{"providerId":"anthropic","version":"ao-catalog:anthropic:sha256:030ece6928c2c0e57313e57395c506889aecfa047fb295f38832f0424c16dd2a","sha256":"030ece6928c2c0e57313e57395c506889aecfa047fb295f38832f0424c16dd2a","path":"providers/anthropic/030ece6928c2c0e57313e57395c506889aecfa047fb295f38832f0424c16dd2a.json","modelCount":1},{"providerId":"openai","version":"ao-catalog:openai:sha256:893e629ba2ea7af7f13466a95a07d60ba2506a9bdef72aa6380c6daa7332769d","sha256":"893e629ba2ea7af7f13466a95a07d60ba2506a9bdef72aa6380c6daa7332769d","path":"providers/openai/893e629ba2ea7af7f13466a95a07d60ba2506a9bdef72aa6380c6daa7332769d.json","modelCount":1},{"providerId":"zai","version":"ao-catalog:zai:sha256:6945a8b33e7133ba6c9ce96378ef834ecab1f9c9872b5f5d772a2e1b3fb8805a","sha256":"6945a8b33e7133ba6c9ce96378ef834ecab1f9c9872b5f5d772a2e1b3fb8805a","path":"providers/zai/6945a8b33e7133ba6c9ce96378ef834ecab1f9c9872b5f5d772a2e1b3fb8805a.json","modelCount":1}]}
`
	if string(manifest) != wantManifest {
		t.Fatalf("manifest = %s, want %s", manifest, wantManifest)
	}

	openAI, err := os.ReadFile(filepath.Join(root, "pricing/catalog/v1/providers/openai/893e629ba2ea7af7f13466a95a07d60ba2506a9bdef72aa6380c6daa7332769d.json"))
	if err != nil {
		t.Fatal(err)
	}
	wantOpenAI := `{"schemaVersion":1,"providerId":"openai","models":[{"modelId":"gpt-4o","rates":{"uncachedInputUsdPerToken":"0.000001","cacheReadUsdPerToken":"0","outputUsdPerToken":"0"}}]}
`
	if string(openAI) != wantOpenAI {
		t.Fatalf("OpenAI blob = %s, want %s", openAI, wantOpenAI)
	}
}

// Break caught: treating conflicting provider/model records as independent
// models would silently select an arbitrary price.
func TestSyncRejectsConflictingCanonicalDuplicates(t *testing.T) {
	upstream := `{
"openai/gpt-test":{"litellm_provider":"openai","mode":"chat","input_cost_per_token":1,"output_cost_per_token":2},
"OPENAI/GPT-TEST":{"litellm_provider":" OPENAI ","mode":"responses","input_cost_per_token":3,"output_cost_per_token":2},
"anthropic/a":{"litellm_provider":"anthropic","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1},
"zai/z":{"litellm_provider":"zai","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1}
}`
	_, err := Sync(t.TempDir(), []byte(upstream), testSource("1"))
	if err == nil || !strings.Contains(err.Error(), "conflicting duplicate rates") {
		t.Fatalf("Sync error = %v, want conflicting duplicate rates", err)
	}
}

// Break caught: accepting unsupported LiteLLM variants as base prices, or
// allowing a reviewed provider to disappear without failing the catalog build.
func TestSyncFiltersUnsupportedRecordsAndRequiresEveryProvider(t *testing.T) {
	upstream := `{
"anthropic/a":{"litellm_provider":"anthropic","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1},
"openai/o":{"litellm_provider":"openai","mode":"embedding","input_cost_per_token":1,"output_cost_per_token":1},
"zai/z":{"litellm_provider":"zai","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1},
"other/x":{"litellm_provider":"other","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1}
}`
	_, err := Sync(t.TempDir(), []byte(upstream), testSource("2"))
	if err == nil || !strings.Contains(err.Error(), `provider "openai" produced zero supported models`) {
		t.Fatalf("Sync error = %v, want missing openai provider error", err)
	}
}

// Break caught: a metadata-only LiteLLM entry preventing the catalog from
// including another, fully priced model from the same reviewed provider.
func TestSyncIgnoresSupportedModeRecordsWithoutBaseRates(t *testing.T) {
	upstream := []byte(`{
"anthropic/a":{"litellm_provider":"anthropic","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1},
"openai/metadata-only":{"litellm_provider":"openai","mode":"chat"},
"openai/o":{"litellm_provider":"openai","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1},
"zai/z":{"litellm_provider":"zai","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1}
}`)
	if _, err := Sync(t.TempDir(), upstream, testSource("metadata-only")); err != nil {
		t.Fatalf("Sync returned %v for an unpriced metadata entry", err)
	}
}

// Break caught: rewriting a reviewed manifest merely because unrelated
// upstream content changed, or rejecting append-only historical blobs.
func TestSyncIsSemanticNoOpForUnchangedProviderPayloads(t *testing.T) {
	root := t.TempDir()
	upstream := []byte(`{
"anthropic/a":{"litellm_provider":"anthropic","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1},
"openai/o":{"litellm_provider":"openai","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1},
"zai/z":{"litellm_provider":"zai","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1}
}`)
	if _, err := Sync(root, upstream, testSource("3")); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(root, "pricing/catalog/v1/manifest.json")
	before, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "pricing/catalog/v1/providers/openai"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "pricing/catalog/v1/providers/openai/historical.json"), []byte("not a catalog blob"), 0o600); err != nil {
		t.Fatal(err)
	}

	semanticNoopUpstream := []byte(`{
"anthropic/a":{"litellm_provider":"anthropic","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1},
"openai/o":{"litellm_provider":"openai","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1},
"zai/z":{"litellm_provider":"zai","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1},
"openai/batch":{"litellm_provider":"openai","mode":"batch","input_cost_per_token":99,"output_cost_per_token":99}
}`)
	changed, err := Sync(root, semanticNoopUpstream, testSource("4"))
	if err != nil {
		t.Fatal(err)
	}
	if changed.Changed {
		t.Fatal("Sync changed = true, want semantic no-op")
	}
	after, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatalf("manifest changed on semantic no-op\nbefore: %s\nafter: %s", before, after)
	}
	if err := Validate(root); err != nil {
		t.Fatalf("Validate rejected unreferenced historical blob: %v", err)
	}
}

// Break caught: accepting an editable referenced blob after its manifest hash
// has been reviewed.
func TestValidateRejectsChangedReferencedBlob(t *testing.T) {
	root := t.TempDir()
	upstream := []byte(`{
"anthropic/a":{"litellm_provider":"anthropic","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1},
"openai/o":{"litellm_provider":"openai","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1},
"zai/z":{"litellm_provider":"zai","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1}
}`)
	if _, err := Sync(root, upstream, testSource("5")); err != nil {
		t.Fatal(err)
	}
	manifest, err := os.ReadFile(filepath.Join(root, "pricing/catalog/v1/manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Providers []struct {
			Path string `json:"path"`
		}
	}
	if err := json.Unmarshal(manifest, &decoded); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "pricing/catalog/v1", decoded.Providers[0].Path)
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Validate(root); err == nil || !strings.Contains(err.Error(), "hash mismatch") {
		t.Fatalf("Validate error = %v, want hash mismatch", err)
	}
}

func testSource(seed string) Source {
	sum := sha256.Sum256([]byte(seed))
	return Source{
		Repository: "BerriAI/litellm",
		Revision:   fmt.Sprintf("%040x", sum)[:40],
		Path:       "model_prices_and_context_window.json",
	}
}
