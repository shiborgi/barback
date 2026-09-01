package main

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

type lease struct {
	SchemaVersion int    `json:"schemaVersion"`
	StackID       string `json:"stackId"`
	DNSGeneration string `json:"dnsGeneration"`
	Sequence      uint64 `json:"sequence"`
	ValidUntil    string `json:"validUntil"`
}

type supervisor struct {
	mu         sync.Mutex
	stackID    string
	generation string
	lease      *lease
	child      *exec.Cmd
}

var timestamp = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$`)
var addressHash = regexp.MustCompile(`^[0-9a-f]{16}$`)

func parseLease(contents []byte) (lease, bool) {
	var fields map[string]json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&fields) != nil || len(fields) != 5 {
		return lease{}, false
	}
	for _, name := range []string{"schemaVersion", "stackId", "dnsGeneration", "sequence", "validUntil"} {
		value, ok := fields[name]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return lease{}, false
		}
	}
	var candidate lease
	return candidate, json.Unmarshal(contents, &candidate) == nil
}

func parseValidUntil(value string) (time.Time, bool) {
	if !timestamp.MatchString(value) {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	return parsed, err == nil
}

func (s *supervisor) accept(candidate lease, now time.Time) bool {
	validUntil, ok := parseValidUntil(candidate.ValidUntil)
	if !ok || candidate.SchemaVersion != 1 || candidate.StackID != s.stackID || !s.matchesGeneration(candidate.DNSGeneration) || !validUntil.After(now) {
		return false
	}
	if s.lease != nil && candidate.Sequence < s.lease.Sequence {
		return false
	}
	if s.lease == nil || candidate.Sequence > s.lease.Sequence {
		s.lease = &candidate
	}
	return true
}

func (s *supervisor) matchesGeneration(generation string) bool {
	if generation == s.generation {
		return true // Bootstrap lease before the resolver's address is known.
	}
	suffix, ok := strings.CutPrefix(generation, s.generation+".")
	return ok && addressHash.MatchString(suffix)
}

func (s *supervisor) active(now time.Time) bool {
	if s.lease == nil {
		return false
	}
	validUntil, ok := parseValidUntil(s.lease.ValidUntil)
	return ok && validUntil.After(now)
}

func (s *supervisor) stop() {
	if s.child != nil && s.child.Process != nil {
		_ = s.child.Process.Kill()
	}
	s.child = nil
}

func (s *supervisor) reconcile() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	contents, err := os.ReadFile("/records/current/lease.json")
	if err == nil {
		if candidate, ok := parseLease(contents); ok && s.accept(candidate, now) {
			// A repeated sequence deliberately keeps the already accepted lease.
		}
	}
	if !s.active(now) {
		s.stop() // Fail closed: private names cannot outlive their reconciliation lease.
		return
	}
	if s.child == nil {
		child := exec.Command("/coredns", "-conf", "/etc/coredns/Corefile")
		child.Stdout = os.Stdout
		child.Stderr = os.Stderr
		if err := child.Start(); err != nil {
			log.Printf("cannot start CoreDNS: %v", err)
		} else {
			s.child = child
			go func() {
				err := child.Wait()
				s.mu.Lock()
				if s.child == child {
					s.child = nil
				}
				s.mu.Unlock()
				if err != nil {
					log.Printf("CoreDNS exited: %v", err)
				}
			}()
		}
	}
}

func (s *supervisor) health(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	healthy := s.active(time.Now().UTC()) && s.child != nil && s.child.Process != nil
	s.mu.Unlock()
	if !healthy {
		http.Error(w, "DNS lease is not active", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *supervisor) nextCheck() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lease == nil {
		return time.Second
	}
	validUntil, ok := parseValidUntil(s.lease.ValidUntil)
	if !ok {
		return time.Second
	}
	remaining := time.Until(validUntil)
	if remaining > 0 && remaining < time.Second {
		return remaining
	}
	return time.Second
}

func main() {
	stackID, generation := os.Getenv("BARBACK_STACK_ID"), os.Getenv("BARBACK_DNS_GENERATION")
	if stackID == "" || generation == "" {
		log.Fatal("BARBACK_STACK_ID and BARBACK_DNS_GENERATION are required")
	}
	s := &supervisor{stackID: stackID, generation: generation}
	go func() { log.Fatal(http.ListenAndServe(":8081", http.HandlerFunc(s.health))) }()
	for {
		s.reconcile()
		time.Sleep(s.nextCheck())
	}
}
