// replay-ratelimit: exposes the Workers Rate Limiting binding to the Pages edge proxy through a service binding.
// The proxy calls `GET /limit?key=<client IP>`: 204 when the request is allowed, 429 when the key is over the limit.
// See edge/limiter/wrangler.jsonc and edge/README.md "Rate limiting".

interface LimiterEnv {
  LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

export default {
  async fetch(request: Request, env: LimiterEnv): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") ?? "";
    if (url.pathname !== "/limit" || key === "" || key.length > 128) return new Response(null, { status: 404 });
    const { success } = await env.LIMITER.limit({ key });
    return new Response(null, { status: success ? 204 : 429 });
  },
} satisfies ExportedHandler<LimiterEnv>;
