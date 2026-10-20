// Minimal SSE client over fetch: exposes raw frames (event, id, data, retry) and comment heartbeats,
// which EventSource hides, so framing rules can be asserted.
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { BASE_URL, FORWARDED_PREFIX } from './env.ts';

export interface Frame {
  event: string;
  id?: string;
  data: string;
}

export interface Stream {
  status: number;
  headers: Headers;
  frames: Frame[];
  comments: number;
  retry?: number;
  /** Resolves with the first frame (at index >= `from`) matching `pred`, or rejects after `ms`. */
  waitFor(pred: (f: Frame) => boolean, ms: number, from?: number): Promise<Frame>;
  /** Resolves once at least `n` comment heartbeats arrived, or rejects after `ms`. */
  waitForComments(n: number, ms: number): Promise<void>;
  close(): void;
}

export async function openStream(opts: { lastEventId?: string; query?: string } = {}): Promise<Stream> {
  const ac = new AbortController();
  const res = await fetch(`${BASE_URL}/v1/live/stream${opts.query ?? ''}`, {
    headers: {
      Accept: 'text/event-stream',
      'X-Forwarded-Prefix': FORWARDED_PREFIX,
      ...(opts.lastEventId ? { 'Last-Event-ID': opts.lastEventId } : {}),
    },
    signal: ac.signal,
  });
  const stream: Stream = {
    status: res.status,
    headers: res.headers,
    frames: [],
    comments: 0,
    waitFor: (pred, ms, from = 0) =>
      poll(() => stream.frames.slice(from).find(pred), ms, 'SSE frame'),
    waitForComments: (n, ms) => poll(() => (stream.comments >= n ? true : undefined), ms, `${n} heartbeat(s)`).then(() => undefined),
    close: () => ac.abort(),
  };
  if (!res.ok || !res.body) return stream;
  const parser = createParser({
    onEvent: (m: EventSourceMessage) => stream.frames.push({ event: m.event ?? 'message', id: m.id, data: m.data }),
    onRetry: (ms: number) => (stream.retry = ms),
    onComment: () => stream.comments++,
  });
  (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) parser.feed(decoder.decode(chunk, { stream: true }));
    } catch {
      /* aborted */
    }
  })();
  return stream;
}

async function poll<T>(fn: () => T | undefined, ms: number, what: string): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
