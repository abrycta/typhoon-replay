package app

import "testing"

func TestStreamCounterCapsEachClient(t *testing.T) {
	sc := &streamCounter{max: 3, perClient: 2}
	if sc.acquire("a") != nil || sc.acquire("a") != nil {
		t.Fatal("first two streams of a client must open")
	}
	if p := sc.acquire("a"); p == nil || p.Type.Status != 429 {
		t.Fatalf("third stream of a: got %v, want 429", p)
	}
	if sc.acquire("b") != nil {
		t.Fatal("another client must still get a slot")
	}
	if p := sc.acquire("c"); p == nil || p.Type.Status != 503 {
		t.Fatalf("instance full: got %v, want 503", p)
	}
	sc.release("a")
	if sc.acquire("a") != nil {
		t.Fatal("a released one stream, so it may open another")
	}
	if len(sc.byClient) != 2 || sc.n != 3 {
		t.Fatalf("bookkeeping: %v n=%d", sc.byClient, sc.n)
	}
}
