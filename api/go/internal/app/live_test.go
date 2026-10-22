package app

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

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

func TestLivePollerSharesOneFetchAcrossStreams(t *testing.T) {
	var mu sync.Mutex
	fetches, rev := 0, int64(5)
	p := newLivePoller(10*time.Millisecond, func(_ context.Context, from int64) (int64, []liveEvent, error) {
		mu.Lock()
		defer mu.Unlock()
		fetches++
		var out []liveEvent
		for seq := from + 1; seq <= rev; seq++ {
			out = append(out, liveEvent{seq: seq, frame: "id: " + strconv.FormatInt(seq, 10) + "\n\n"})
		}
		return rev, out, nil
	})
	subs := make([]*liveSub, 20)
	for i := range subs {
		subs[i] = p.subscribe(5)
	}
	time.Sleep(55 * time.Millisecond) // about 5 ticks with nothing new
	mu.Lock()
	idle := fetches
	rev = 7
	mu.Unlock()
	if idle < 2 || idle > 8 {
		t.Fatalf("20 streams made %d fetches in ~5 ticks; want one per tick", idle)
	}
	for i, sub := range subs {
		select {
		case <-sub.wake:
		case <-time.After(time.Second):
			t.Fatalf("stream %d was not woken", i)
		}
		var b strings.Builder
		p.next(sub, &b)
		if b.String() != "id: 6\n\nid: 7\n\n" || sub.sent.Load() != 7 {
			t.Fatalf("stream %d got %q (sent %d)", i, b.String(), sub.sent.Load())
		}
	}
	for _, sub := range subs {
		p.unsubscribe(sub)
	}
	time.Sleep(30 * time.Millisecond)
	p.mu.Lock()
	running := p.running
	p.mu.Unlock()
	if running {
		t.Fatal("the poller must stop when no stream is subscribed")
	}
}
