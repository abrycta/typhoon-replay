// The application: Hono routes generated from the contract (src/generated/operations.ts), one handler per
// operationId, and the request pipeline every route shares (request id and §4 headers, per-IP limit, problems, logs).
import { Hono } from 'hono';
import { getNearestPlace, getPlace, listPlaceStorms, listPointStorms, searchPlaces } from './catalog/places';
import { getStorm, getStormTrack, listStormPlaces, listStorms } from './catalog/storms';
import { OPERATIONS, type OperationId } from './generated/operations';
import { getLiveSnapshot, streamLiveEvents, testLiveEvent } from './live/live';
import { getHealth, getMeta, getOpenApiDocument, getReadiness, markStarted } from './meta/meta';
import type { Env } from './platform/env';
import { fail, log, Rq, send } from './platform/http';
import { NeonError } from './platform/neon';
import { missing, Problem } from './platform/problem';
import { rateLimit } from './platform/ratelimit';

type Handler = (rq: Rq, path: Record<string, string>) => Promise<Response>;

/** Every operation in the contract has a handler: a missing or unknown one fails the typecheck. */
const HANDLERS = {
  getHealth,
  getReadiness,
  getMeta,
  getOpenApiDocument,
  listStorms,
  getStorm,
  getStormTrack,
  listStormPlaces,
  searchPlaces,
  getNearestPlace,
  getPlace,
  listPlaceStorms,
  listPointStorms,
  getLiveSnapshot,
  streamLiveEvents,
} satisfies Record<OperationId, Handler>;

const ALLOW_GET = 'GET, HEAD, OPTIONS';

export const app = new Hono<{ Bindings: Env; Variables: { rq: Rq } }>();

app.use('*', async (c, next) => {
  markStarted();
  const rq = new Rq(c.req.raw, c.env);
  c.set('rq', rq);
  const limited = await rateLimit(rq);
  if (limited) {
    c.res = fail(rq, limited);
  } else {
    await next();
  }
  log(rq.status >= 500 ? 'error' : 'info', 'request', rq);
});

app.all('/v1/_test/live-events', (c) => testLiveEvent(c.get('rq')));

// Static paths before parameterised ones (/v1/places/search before /v1/places/{placeId}).
const ops = (Object.keys(OPERATIONS) as OperationId[]).sort((a, b) => Number(OPERATIONS[a].route.includes(':')) - Number(OPERATIONS[b].route.includes(':')));
for (const id of ops) {
  const { route } = OPERATIONS[id];
  // GET also answers HEAD (Hono runs the GET handler and drops the body).
  app.get(route, (c) => HANDLERS[id](c.get('rq'), c.req.param() as Record<string, string>));
  app.options(route, (c) => send(c.get('rq'), 204, '', 'text/plain; charset=utf-8', { Allow: ALLOW_GET }));
  app.all(route, (c) => {
    throw new Problem('method-not-allowed', `Method ${c.req.method} is not supported here.`, [], { Allow: ALLOW_GET });
  });
}

app.notFound((c) => fail(c.get('rq'), missing('No such resource.')));

app.onError((err, c) => {
  const rq = c.get('rq');
  if (err instanceof Problem) return fail(rq, err);
  if (err instanceof NeonError && err.unavailable) {
    log('warn', err.message, rq);
    return fail(rq, new Problem('not-ready', 'The database is waking up; retry shortly.', [], { 'Retry-After': '10' }));
  }
  log('error', err instanceof Error ? err.message : String(err), rq);
  return fail(rq, new Problem('internal', 'Unexpected error; see requestId in the logs.'));
});
