// Mock OAuth2 provider for the auth conformance scenarios: imitates the endpoints the backends call for
// Google (authorize / token / userinfo) and GitHub (login/oauth/authorize, login/oauth/access_token, api/user,
// api/user/emails). No dependencies; run with `node server.mjs` (PORT, default 9090).
//
// Behaviour:
//  - authorize approves immediately: 302 to redirect_uri?code=...&state=... (no consent page).
//  - token checks client_secret is present, redirect_uri matches, and the PKCE S256 code_verifier matches the challenge.
//    Codes are single use. Failures return 400 {"error":"invalid_grant"} as real providers do.
//  - userinfo returns the identity chosen by POST /_mock/next-user, or a fixed default per provider.
// Inspection endpoints for tests: GET /_mock/last-authorize, GET /_mock/last-token-request.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 9090);
const DEFAULT_USER = {
  github: { subject: '424242', email: 'octo@example.com', name: 'Octo Conformance', login: 'octo-conformance' },
  google: { subject: '110000000000000004242', email: 'conformance@example.com', name: 'Google Conformance' },
};

const codes = new Map(); // code -> { provider, challenge, redirectUri, user }
const tokens = new Map(); // access token -> { provider, user }
const nextUser = {};
let lastAuthorize = null;
let lastTokenRequest = null;

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const type = req.headers['content-type'] ?? '';
      if (type.includes('application/json')) {
        try {
          return resolve(JSON.parse(raw || '{}'));
        } catch {
          return resolve({});
        }
      }
      resolve(Object.fromEntries(new URLSearchParams(raw)));
    });
  });

function authorize(provider, url, res) {
  const q = url.searchParams;
  lastAuthorize = { provider, ...Object.fromEntries(q) };
  const redirectUri = q.get('redirect_uri');
  if (!redirectUri || !q.get('state') || !q.get('client_id')) return send(res, 400, { error: 'invalid_request' });
  if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return send(res, 400, { error: 'invalid_request', error_description: 'PKCE S256 required' });
  const code = randomBytes(16).toString('hex');
  const user = nextUser[provider] ?? DEFAULT_USER[provider];
  delete nextUser[provider];
  codes.set(code, { provider, challenge: q.get('code_challenge'), redirectUri, user });
  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  target.searchParams.set('state', q.get('state'));
  res.writeHead(302, { Location: target.toString() });
  res.end();
}

async function token(provider, req, res) {
  const body = await readBody(req);
  // Client credentials may come in the body or as HTTP Basic auth.
  const basic = (req.headers.authorization ?? '').startsWith('Basic ');
  lastTokenRequest = { provider, ...body, client_auth: basic ? 'basic' : 'body' };
  const entry = codes.get(body.code);
  codes.delete(body.code);
  if (!entry || entry.provider !== provider) return send(res, 400, { error: 'invalid_grant', error_description: 'unknown or used code' });
  if (!basic && !body.client_secret) return send(res, 401, { error: 'invalid_client' });
  if (body.redirect_uri && body.redirect_uri !== entry.redirectUri) return send(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
  const expected = createHash('sha256').update(body.code_verifier ?? '').digest('base64url');
  if (expected !== entry.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
  const accessToken = randomBytes(20).toString('hex');
  tokens.set(accessToken, { provider, user: entry.user });
  const scope = provider === 'github' ? 'read:user,user:email' : 'openid email profile';
  send(res, 200, { access_token: accessToken, token_type: 'bearer', scope, expires_in: 3600 });
}

function bearer(req, provider) {
  const m = /^(?:Bearer|token) (.+)$/i.exec(req.headers.authorization ?? '');
  const t = m && tokens.get(m[1]);
  return t && t.provider === provider ? t.user : undefined;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;
  try {
    switch (route) {
      case 'GET /healthz':
        return send(res, 200, { status: 'ok' });
      case 'GET /google/authorize':
        return authorize('google', url, res);
      case 'GET /github/login/oauth/authorize':
        return authorize('github', url, res);
      case 'POST /google/token':
        return await token('google', req, res);
      case 'POST /github/login/oauth/access_token':
        return await token('github', req, res);
      case 'GET /google/userinfo': {
        const u = bearer(req, 'google');
        if (!u) return send(res, 401, { error: 'invalid_token' });
        return send(res, 200, { sub: u.subject, email: u.email, email_verified: true, name: u.name, picture: 'https://example.com/avatar.png' });
      }
      case 'GET /github/api/user': {
        const u = bearer(req, 'github');
        if (!u) return send(res, 401, { message: 'Bad credentials' });
        return send(res, 200, { id: Number(u.subject), login: u.login ?? 'octo', name: u.name, email: u.email, avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' });
      }
      case 'GET /github/api/user/emails': {
        const u = bearer(req, 'github');
        if (!u) return send(res, 401, { message: 'Bad credentials' });
        return send(res, 200, [{ email: u.email, primary: true, verified: true, visibility: 'private' }]);
      }
      case 'POST /_mock/next-user': {
        const b = await readBody(req);
        if (!DEFAULT_USER[b.provider]) return send(res, 400, { error: 'provider must be google or github' });
        nextUser[b.provider] = { subject: String(b.subject), email: b.email, name: b.name ?? b.email, login: b.login };
        return send(res, 204);
      }
      case 'GET /_mock/last-authorize':
        return send(res, 200, lastAuthorize ?? {});
      case 'GET /_mock/last-token-request':
        return send(res, 200, lastTokenRequest ?? {});
      default:
        return send(res, 404, { error: 'not_found', route });
    }
  } catch (err) {
    send(res, 500, { error: 'server_error', message: String(err) });
  }
});

server.listen(PORT, () => console.log(`mock IdP listening on :${PORT}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
