package codexappserver

import (
	"encoding/json"
	"math"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestCapacityNormalizationIncludesBucketsAndRejectsMalformedWindows(t *testing.T) {
	var envelope capacityReadEnvelope
	err := json.Unmarshal([]byte(`{
		"rateLimits":{"limitId":"codex","planType":"pro","primary":{"usedPercent":81,"windowDurationMins":300,"resetsAt":4102444800},"secondary":{"usedPercent":101}},
		"rateLimitsByLimitId":{"spark":{"limitId":"spark","limitName":"Spark","primary":{"usedPercent":25}},"alpha":{"limitId":"alpha","primary":{"usedPercent":10}}}
	}`), &envelope)
	if err != nil {
		t.Fatal(err)
	}
	observed := capacityObservationFromEnvelope(envelope, time.Unix(1, 0), false)
	if observed.Plan == nil || *observed.Plan != "pro" || observed.Overall == nil || observed.Overall.Primary == nil {
		t.Fatalf("overall = %#v", observed)
	}
	if observed.Overall.Secondary != nil {
		t.Fatalf("out-of-range window was accepted: %#v", observed.Overall.Secondary)
	}
	if len(observed.AdditionalBuckets) != 2 || observed.AdditionalBuckets[0].LimitID != "alpha" || observed.AdditionalBuckets[1].LimitID != "spark" || observed.AdditionalBuckets[1].Reached != domain.CodexCapacityNotReached {
		t.Fatalf("additional buckets = %#v", observed.AdditionalBuckets)
	}
}

func TestCapacityNormalizationRejectsNonFinitePercent(t *testing.T) {
	nan := math.NaN()
	if got := normalizeCapacityWindow(&capacityWireWindow{UsedPercent: &nan}); got != nil {
		t.Fatalf("NaN capacity window was accepted: %#v", got)
	}
	infinite := math.Inf(1)
	if got := normalizeCapacityWindow(&capacityWireWindow{UsedPercent: &infinite}); got != nil {
		t.Fatalf("infinite capacity window was accepted: %#v", got)
	}
}

func TestSparseCapacityNormalizationKeepsUnknownReachedState(t *testing.T) {
	var envelope capacityReadEnvelope
	if err := json.Unmarshal([]byte(`{"rateLimits":{"limitId":"codex","primary":{"usedPercent":10}}}`), &envelope); err != nil {
		t.Fatal(err)
	}
	observed := capacityObservationFromEnvelope(envelope, time.Now(), true)
	if observed.Overall == nil || observed.Overall.Reached != domain.CodexCapacityReachUnknown {
		t.Fatalf("reached = %#v", observed.Overall)
	}
}
