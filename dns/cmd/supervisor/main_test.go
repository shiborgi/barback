package main

import (
	"testing"
	"time"
)

func TestAcceptRequiresExactGeneration(t *testing.T) {
	now := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	s := supervisor{stackID: "barback-local", generation: "resolver-a.1234"}
	base := lease{
		SchemaVersion: 1,
		StackID:       "barback-local",
		Sequence:      1,
		ValidUntil:    now.Add(time.Minute).Format(time.RFC3339Nano),
	}
	if s.accept(lease{DNSGeneration: "resolver-a.1234.old", SchemaVersion: base.SchemaVersion, StackID: base.StackID, Sequence: base.Sequence, ValidUntil: base.ValidUntil}, now) {
		t.Fatal("accepted a generation with a matching prefix")
	}
	base.DNSGeneration = "resolver-a.1234"
	if !s.accept(base, now) {
		t.Fatal("rejected the exact active generation")
	}
}
