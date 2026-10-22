package app

import (
	"context"
	"math"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/abrycta/typhoon-replay/api/go/internal/neon"
)

// livePoller is the one poller shared by every open live stream on this instance, as Java's LiveBroadcaster does:
// one Neon round trip per tick whatever the number of streams, so database load no longer grows with them. It runs
// only while at least one stream is subscribed; with none, nothing touches the database and Neon can suspend.
type livePoller struct {
	every time.Duration
	// fetch returns live.revision and up to 1000 events after `from`, as SSE frames, in one round trip.
	fetch func(ctx context.Context, from int64) (rev int64, events []liveEvent, err error)

	mu      sync.Mutex
	subs    map[*liveSub]struct{}
	running bool
	batch   *liveBatch
}

type liveEvent struct {
	seq   int64
	frame string
}

// liveBatch holds the events after `from` (every event with seq > from, up to the 1000-row page).
type liveBatch struct {
	from   int64
	events []liveEvent
}

type liveSub struct {
	sent atomic.Int64  // newest seq this stream has written
	wake chan struct{} // capacity 1: "a new batch is ready"
}

func newLivePoller(every time.Duration, fetch func(context.Context, int64) (int64, []liveEvent, error)) *livePoller {
	return &livePoller{every: every, fetch: fetch, subs: map[*liveSub]struct{}{}}
}

// subscribe registers a stream that has written everything up to seq `sent`, and starts the poller if it is idle.
func (p *livePoller) subscribe(sent int64) *liveSub {
	sub := &liveSub{wake: make(chan struct{}, 1)}
	sub.sent.Store(sent)
	p.mu.Lock()
	p.subs[sub] = struct{}{}
	if !p.running {
		p.running = true
		go p.run()
	}
	p.mu.Unlock()
	return sub
}

func (p *livePoller) unsubscribe(sub *liveSub) {
	p.mu.Lock()
	delete(p.subs, sub)
	p.mu.Unlock()
}

func (p *livePoller) run() {
	tick := time.NewTicker(p.every)
	defer tick.Stop()
	for range tick.C {
		p.mu.Lock()
		if len(p.subs) == 0 {
			p.running = false
			p.batch = nil
			p.mu.Unlock()
			return
		}
		from := int64(math.MaxInt64)
		for sub := range p.subs {
			from = min(from, sub.sent.Load())
		}
		p.mu.Unlock()

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		rev, events, err := p.fetch(ctx, from)
		cancel()
		if err != nil || rev <= from {
			continue // nothing new for anyone (or a transient error: the next tick retries)
		}
		p.mu.Lock()
		p.batch = &liveBatch{from: from, events: events}
		for sub := range p.subs {
			select {
			case sub.wake <- struct{}{}:
			default: // already signalled; it will read the newest batch
			}
		}
		p.mu.Unlock()
	}
}

// next appends to b the frames this subscriber has not written yet, from the newest batch, and records them as sent.
// A stream that subscribed after that batch was fetched (its seq below the batch's start) waits for the next tick,
// which includes it.
func (p *livePoller) next(sub *liveSub, b *strings.Builder) {
	p.mu.Lock()
	batch := p.batch
	p.mu.Unlock()
	sent := sub.sent.Load()
	if batch == nil || batch.from > sent {
		return
	}
	for _, e := range batch.events {
		if e.seq > sent {
			b.WriteString(e.frame)
			sent = e.seq
		}
	}
	sub.sent.Store(sent)
}

// fetchLive is the poller's query: the revision and the events after `from`, in one read-only round trip to Neon.
func (s *Server) fetchLive(ctx context.Context, from int64) (int64, []liveEvent, error) {
	if s.dbErr != nil {
		return 0, nil, &neon.Error{Message: s.dbErr.Error(), Unavailable: true}
	}
	res, err := s.db.Read(ctx, neon.Q(revisionSQL), neon.Q(eventsSQL, from))
	if err != nil || res[0].Len() == 0 {
		return 0, nil, err
	}
	rows := res[1]
	events := make([]liveEvent, 0, rows.Len())
	for i := 0; i < rows.Len(); i++ {
		e := rows.At(i)
		events = append(events, liveEvent{seq: e.I("seq"),
			frame: "id: " + e.S("seq") + "\nevent: " + e.S("type") + "\ndata: " + e.S("payload") + "\n\n"})
	}
	return res[0].At(0).I("seq"), events, nil
}
