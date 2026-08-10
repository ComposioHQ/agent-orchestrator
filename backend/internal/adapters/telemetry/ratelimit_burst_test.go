package telemetry

import (
	"testing"
	"time"
)

func TestRateLimitedSinkBurstExemptNameGetsRaisedMinuteCap(t *testing.T) {
	s := NewRateLimitedSink(&recordingSink{}, nil).WithBurstExempt("ao.cli.invoked")
	now := time.Unix(0, 0)
	forwarded := 0
	for i := 0; i < eventsPerNamePerMinuteBurstExempt+10; i++ {
		if s.reserve("ao.cli.invoked", now) {
			forwarded++
		}
	}
	if forwarded != eventsPerNamePerMinuteBurstExempt {
		t.Fatalf("forwarded = %d, want %d (burst-exempt raised minute cap)", forwarded, eventsPerNamePerMinuteBurstExempt)
	}
}

func TestRateLimitedSinkNonExemptNameKeepsTightMinuteCap(t *testing.T) {
	// Exempting one name must not loosen the tight cap for others (5xx/panics
	// still need the runaway-loop protection).
	s := NewRateLimitedSink(&recordingSink{}, nil).WithBurstExempt("ao.cli.invoked")
	now := time.Unix(0, 0)
	forwarded := 0
	for i := 0; i < eventsPerNamePerMinuteBurstExempt; i++ {
		if s.reserve("ao.http.5xx", now) {
			forwarded++
		}
	}
	if forwarded != eventsPerNamePerMinute {
		t.Fatalf("forwarded = %d, want %d (non-exempt name keeps the tight minute cap)", forwarded, eventsPerNamePerMinute)
	}
}

func TestRateLimitedSinkBurstExemptNameStillRespectsDailyCap(t *testing.T) {
	// The raised minute cap must not remove the daily ceiling; spacing each
	// reserve a minute apart dodges the minute cap so only the daily cap bites.
	s := NewRateLimitedSink(&recordingSink{}, nil).WithBurstExempt("ao.cli.invoked")
	start := time.Unix(0, 0)
	forwarded := 0
	for i := 0; i < eventsPerNamePerDay+10; i++ {
		if s.reserve("ao.cli.invoked", start.Add(time.Duration(i)*time.Minute)) {
			forwarded++
		}
	}
	if forwarded != eventsPerNamePerDay {
		t.Fatalf("forwarded = %d, want %d (burst-exempt name still bounded by the daily ceiling)", forwarded, eventsPerNamePerDay)
	}
}
