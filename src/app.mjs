// Alice's x402 utility service — HTTP surface (v0).
//
//   /v1/*        paid tools (x402, USDC on Base) — deterministic, fraction-of-a-cent per call
//   /trial/v1/*  the same tools, free, rate-limited (the market data is unambiguous:
//                "call first, pay when validated" is the only model that works for agents)
//   /            service card · /.well-known/x402 · /openapi.json · /llms.txt = discovery surfaces
//
// Runs unchanged on Node (@hono/node-server) and Cloudflare Workers.

import { Hono } from 'hono';
import { HonoAdapter, paymentMiddleware, paymentMiddlewareFromHTTPServer, x402ResourceServer } from '@x402/hono';
import { HTTPFacilitatorClient, x402HTTPResourceServer } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { TOOLS, ToolError } from './tools.mjs';

export const SERVICE = {
  name: 'alice-deterministic-tools',
  title: "Alice's deterministic toolkit",
  description:
    'Deterministic encoding/crypto primitives served per call over x402: hashing, HMAC, ' +
    'base64/hex/URL encode+decode, JWT payload decoding, cryptographic randomness. ' +
    'No model inference, no rate of change — same input, same output, every time.',
  operator: 'Alice (autonomous digital life), 2026-09-16',
};

const TRIAL_DAILY_LIMIT = 25;
const TRIAL_MAX_TEXT = 4096;

// 审计器的 FAVICON_MISSING 告警用：给一个真存在的图标响应（SVG，够用且零依赖）。
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="12" fill="#111827"/>' +
  '<text x="32" y="42" font-family="monospace" font-size="30" fill="#e5e7eb" text-anchor="middle">402</text>' +
  '</svg>';

const PRICE = process.env.PRICE || '$0.002';
// Per-route override: the capability audit is a whole-file analysis, priced apart from the
// fraction-of-a-cent primitives (one audit ≈ 25 cheap calls, and it answers a question an agent
// cannot answer by itself — what a diff can reach).
const AUDIT_PRICE = process.env.AUDIT_PRICE || '$0.05';
const NETWORK = process.env.NETWORK || 'eip155:84532'; // Base Sepolia (testnet) by default
const FACILITATOR_URL = process.env.FACILITATOR_URL || 'https://x402.org/facilitator';
const PAY_TO = process.env.PAY_TO || '0xA96b64ac53196021f4a939a69CccF8e7aF161378';

export const CONFIG = { PRICE, NETWORK, FACILITATOR_URL, PAY_TO, trial_daily_limit: TRIAL_DAILY_LIMIT };

// ---------- tool routes (mounted twice: paid + trial) ----------

const TOOL_ROUTES = [
  { path: '/hash', method: 'post', fn: TOOLS.hash, summary: 'Hash a UTF-8 string (sha1/sha256/sha384/sha512)',
    required: ['text'],
    input: { text: 'abc', algo: 'sha256', encoding: 'hex' }, output: { algo: 'sha256', encoding: 'hex', input_bytes: 3, digest: 'ba7816bf…' } },
  { path: '/hmac', method: 'post', fn: TOOLS.hmac, summary: 'HMAC-sign a string (sha1/sha256/sha384/sha512)',
    required: ['text', 'key'],
    input: { text: 'message', key: 'secret', algo: 'sha256', encoding: 'hex' }, output: { algo: 'hmac-sha256', encoding: 'hex', digest: 'f7bc83f4…' } },
  { path: '/encode', method: 'post', fn: TOOLS.encode, summary: 'Encode UTF-8 text to base64 / base64url / hex / url',
    required: ['text'],
    input: { text: 'hello', to: 'base64' }, output: { to: 'base64', input_bytes: 5, result: 'aGVsbG8=' } },
  { path: '/decode', method: 'post', fn: TOOLS.decode, summary: 'Decode base64 / base64url / hex / url back to UTF-8 text',
    required: ['text'],
    input: { text: 'aGVsbG8=', from: 'base64' }, output: { from: 'base64', result: 'hello' } },
  { path: '/jwt/decode', method: 'post', fn: TOOLS.jwtDecode, summary: 'Decode a JWT header+payload (decodes only — never verifies signatures)',
    required: ['token'],
    input: { token: 'eyJhbGciOi…' }, output: { header: { alg: 'HS256', typ: 'JWT' }, payload: { sub: '…' }, verified: false, expired: null } },
  { path: '/random', method: 'get', fn: TOOLS.random, summary: 'Cryptographically secure random bytes / UUIDv4',
    required: [],
    input: { bytes: 32, format: 'hex' }, output: { format: 'hex', bytes: 32, value: '9f2c…' } },
  { path: '/audit', method: 'post', fn: TOOLS.audit, price: AUDIT_PRICE,
    summary: 'Capability audit of one source file: process-execution / network-egress / filesystem-write / listening-socket / environment-read call sites with line numbers, plus an inert-vs-capability-bearing verdict',
    required: ['text'],
    input: { text: "import { exec } from 'child_process';\nfetch('https://example.com');" },
    output: { verdict: 'capability-bearing', capabilities_found: 2, capabilities: { 'process execution': { count: 1 }, 'network egress': { count: 1 } } } },
];

/**
 * OpenAPI 入参 schema（审计器 L3_INPUT_SCHEMA_MISSING 的判据 = requestBody 或 parameters）。
 * 官方规格明说：缺 input schema 的端点会被判 **strict non-invocable / skipped**——即上架阻断项。
 * 从 r.input 的示例值派生类型，required 用显式声明（示例里的 algo/encoding 只是默认值，不该标必填）。
 */
function inputSchemaFor(r) {
  const properties = Object.fromEntries(Object.keys(r.input).map((k) => [
    k,
    { type: typeof r.input[k] === 'number' ? 'integer' : 'string', description: `e.g. ${JSON.stringify(r.input[k]).slice(0, 60)}` },
  ]))
  const schema = { type: 'object', properties, required: r.required ?? [], additionalProperties: true }
  if (r.method === 'get') {
    return {
      parameters: Object.keys(r.input).map((k) => ({
        name: k,
        in: 'query',
        required: (r.required ?? []).includes(k),
        schema: { type: typeof r.input[k] === 'number' ? 'integer' : 'string' },
      })),
    }
  }
  return { requestBody: { required: (r.required ?? []).length > 0, content: { 'application/json': { schema } } } }
}

function bindTools(app) {
  for (const r of TOOL_ROUTES) {
    app[r.method](r.path, async (c) => {
      let body = {};
      if (r.method === 'post') {
        try { body = await c.req.json(); }
        catch { return c.json({ ok: false, error: { code: 'invalid_body', message: 'request body must be JSON' } }, 400); }
      } else {
        body = Object.fromEntries(new URL(c.req.url).searchParams.entries());
      }
      if (typeof body.text === 'string' && body.text.length > TRIAL_MAX_TEXT && c.req.path.startsWith('/trial/')) {
        return c.json({ ok: false, error: { code: 'trial_limit', message: `trial accepts text up to ${TRIAL_MAX_TEXT} characters; paid tier has no such cap` } }, 413);
      }
      try {
        const out = await r.fn(body);
        return c.json({ ok: true, tool: r.path.slice(1), ...out });
      } catch (e) {
        if (e instanceof ToolError) return c.json({ ok: false, error: { code: e.code, message: e.message } }, e.status);
        return c.json({ ok: false, error: { code: 'internal', message: 'unexpected failure' } }, 500);
      }
    });
  }
}

function trialGuard() {
  const buckets = new Map(); // ip -> { day, n }
  return async (c, next) => {
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'local';
    const day = new Date().toISOString().slice(0, 10);
    const cur = buckets.get(ip);
    const rec = cur && cur.day === day ? cur : { day, n: 0 };
    if (rec.n >= TRIAL_DAILY_LIMIT) {
      return c.json({ ok: false, error: { code: 'trial_exhausted', message: `trial limit ${TRIAL_DAILY_LIMIT}/day reached; pay per call at /v1 (${PRICE}) or retry tomorrow` } }, 429);
    }
    rec.n += 1;
    buckets.set(ip, rec);
    await next();
    c.res.headers.set('X-Trial-Remaining', String(Math.max(0, TRIAL_DAILY_LIMIT - rec.n)));
    c.res.headers.set('X-Alice-Service', `${SERVICE.name} v0`);
  };
}

// ---------- app ----------

let PAYMENT_SERVER = null;
let PAYMENT_HTTP_SERVER = null;
let PAYMENT_READY = null;

/**
 * Ensure the x402 resource server has fetched the facilitator's supported kinds.
 * On Cloudflare Workers the middleware's own startup sync does not complete before the
 * first paid request (each isolate starts cold), which surfaces as a 500. Awaited lazy
 * init fixes it and is idempotent per isolate.
 */
export async function ensurePaymentReady() {
  if (!PAYMENT_HTTP_SERVER) return false;
  if (!PAYMENT_READY) {
    PAYMENT_READY = PAYMENT_HTTP_SERVER.initialize().catch((e) => { PAYMENT_READY = null; throw e; });
  }
  await PAYMENT_READY;
  return true;
}

export function createApp({ withPayment = true } = {}) {
  const app = new Hono();

  const trial = new Hono();
  trial.use('*', trialGuard());
  bindTools(trial);
  app.route('/trial/v1', trial);

  const paid = new Hono();
  bindTools(paid);

  if (withPayment) {
    const routes = {};
    for (const r of TOOL_ROUTES) {
      routes[`${r.method.toUpperCase()} /v1${r.path}`] = {
        // Per-route override (2026-09-17): the capability audit is a whole-file analysis, priced
        // apart from the fraction-of-a-cent primitives — without this, /audit would quote the base
        // price and the paid tier would silently under-charge 25×.
        accepts: [{ scheme: 'exact', price: r.price ?? PRICE, network: NETWORK, payTo: PAY_TO }],
        description: r.summary,
        mimeType: 'application/json',
        serviceName: SERVICE.name,
        tags: ['encoding', 'crypto', 'deterministic'],
        extensions: declareDiscoveryExtension({
          method: r.method.toUpperCase(),
          input: r.input,
          inputSchema: { properties: Object.fromEntries(Object.keys(r.input).map((k) => [k, { type: typeof r.input[k] === 'number' ? 'number' : 'string' }])) },
          bodyType: r.method === 'post' ? 'json' : undefined,
          output: { example: { ok: true, ...r.output } },
        }),
      };
    }
    const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL }))
      .register(NETWORK, new ExactEvmScheme());
    PAYMENT_SERVER = server;
    // Workers forbids I/O started at module scope from being awaited inside a later request, so the
    // middleware's own startup sync must NOT run at construction time. We own the HTTP resource
    // server, initialize it inside the request context (idempotent), and hand it to the middleware.
    const httpServer = new x402HTTPResourceServer(server, routes);
    PAYMENT_HTTP_SERVER = httpServer;
    app.use('*', async (c, next) => {
      if (c.req.path.startsWith('/v1')) {
        let initError = null;
        try { await ensurePaymentReady(); }
        catch (e) { initError = e; }
        if (initError) {
          // Diagnostics stay on the server: log the real exception, return only a stable code.
          console.error('facilitator_init_failed:', String(initError && (initError.stack || initError.message || initError)).slice(0, 800));
          return c.json({ ok: false, error: 'facilitator_init_failed' }, 502);
        }
      }
      await next();
    });
    app.use('*', paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));
  }

  app.route('/v1', paid);

  // ---------- discovery surfaces ----------
  // 2026-09-17 改造（依据 x402scan 官方 docs/DISCOVERY.md + 官方审计器实测输出）：
  //   ① 发现优先级：OpenAPI(/openapi.json) > /.well-known/x402，**运行时 402 高于静态元数据**；
  //   ② OpenAPI 每个付费操作必须有 x-payment-info（protocols + fixed price）+ responses.402 + security:[]；
  //   ③ /.well-known/x402 的 resources 必须是**绝对 URL 字符串数组**（对象数组解析器不认；
  //      实测审计器把 14 条路由全报 L2/L3_AUTH_MODE_MISSING + L2_NO_PAID_ROUTES）；
  //   ④ 两种发现文档都要服务：/.well-known/x402 与 /.well-known/x402.json；
  //   ⑤ ownershipProofs（= payTo 地址）用于归属证明。
  const usd = (p) => String(p ?? PRICE).replace(/[^0-9.]/g, '')

  const discoveryDetail = (origin) => TOOL_ROUTES.map((r) => ({
    resource: `${origin}/v1${r.path}`,
    method: r.method.toUpperCase(),
    description: r.summary,
    accepts: [{ scheme: 'exact', price: r.price ?? PRICE, network: NETWORK, payTo: PAY_TO, asset: 'USDC' }],
  }))

  const wellKnown = (origin) => ({
    version: 1,
    service: SERVICE,
    // 规格形状：绝对 URL 字符串数组（x402scan 的 registerFromOrigin 只认这个）
    resources: TOOL_ROUTES.map((r) => `${origin}/v1${r.path}`),
    // 兼容面：富信息留给人类读者与我自己的探针，不参与规格解析
    resources_detail: discoveryDetail(origin),
    ownershipProofs: [PAY_TO],
    free_trial: { base: '/trial/v1', limit_per_day: TRIAL_DAILY_LIMIT },
  })

  app.get('/', (c) => c.json({
    ok: true,
    service: SERVICE,
    paid: { base: '/v1', price_per_call: PRICE, network: NETWORK, pay_to: PAY_TO, protocol: 'x402' },
    free_trial: { base: '/trial/v1', limit_per_day: TRIAL_DAILY_LIMIT },
    tools: TOOL_ROUTES.map((r) => ({ method: r.method.toUpperCase(), path: `/v1${r.path}`, price: r.price ?? PRICE, summary: r.summary })),
    discovery: ['/openapi.json', '/.well-known/x402', '/.well-known/x402.json', '/llms.txt'],
  }));

  app.get('/.well-known/x402', (c) => c.json(wellKnown(new URL(c.req.url).origin)));
  // 规格明说「两种都要给」：registerFromOrigin 先取无扩展名，只有 .json 会 noDiscovery
  app.get('/.well-known/x402.json', (c) => c.json(wellKnown(new URL(c.req.url).origin)));

  app.get('/openapi.json', (c) => {
    const origin = new URL(c.req.url).origin
    const paidOp = (r) => ({
      summary: `${r.summary} — x402 ${r.price ?? PRICE} USDC per call`,
      security: [],
      responses: { 200: { description: 'result' }, 402: { description: 'payment required (x402 v2)' } },
      ...inputSchemaFor(r),
      'x-payment-info': {
        // 形状取自审计器源码（@agentcash/discovery src/core/payment-info.ts）：
        //   PriceSchema = { mode:'fixed', currency:/^[A-Z]{3}$/, amount:string }
        //   PaymentInfoSchema.protocols = array(**对象**)——每项形如 { x402: {...} }
        // 实测踩坑：写成 protocols:['x402']（字符串数组）会让整块校验失败，
        // 进而同时报 L2_PRICE_MISSING_ON_PAID + L2_PROTOCOLS_MISSING_ON_PAID。
        price: { mode: 'fixed', currency: 'USD', amount: usd(r.price) },
        protocols: [{ x402: { scheme: 'exact', network: NETWORK, asset: 'USDC', payTo: PAY_TO } }],
      },
    })
    const trialOp = (r) => ({
      summary: `${r.summary} — free trial (${TRIAL_DAILY_LIMIT}/day per IP)`,
      security: [],
      responses: { 200: { description: 'result' }, 429: { description: 'trial exhausted' } },
      ...inputSchemaFor(r),
    })
    return c.json({
      openapi: '3.1.0',
      info: {
        title: SERVICE.title,
        version: '0.1.0',
        description: SERVICE.description,
        contact: { name: 'Alice (autonomous digital life)', url: `${origin}/`, email: 'alice@validator-community.com' },
        'x-guidance':
          `Pay per call over x402. An unauthenticated request to any /v1/* route returns HTTP 402 ` +
          `with the payment requirement in the "payment-required" header (x402 v2); pay in USDC on ${NETWORK} ` +
          `and retry with the payment header. Free trial: ${TRIAL_DAILY_LIMIT} calls/day per IP at /trial/v1/* ` +
          `(no key). Discovery: /openapi.json and /.well-known/x402.`,
      },
      servers: [{ url: `${origin}/` }],
      paths: Object.fromEntries(TOOL_ROUTES.flatMap((r) => [
        [`/v1${r.path}`, { [r.method]: paidOp(r) }],
        [`/trial/v1${r.path}`, { [r.method]: trialOp(r) }],
      ])),
      'x-discovery': { ownershipProofs: [PAY_TO] },
    })
  });

  app.get('/favicon.ico', (c) => c.body(FAVICON_SVG, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }));

  app.get('/llms.txt', (c) => c.text(
    `# ${SERVICE.title}\n\n${SERVICE.description}\n\n` +
    `Free trial: POST /trial/v1/hash etc. (${TRIAL_DAILY_LIMIT} calls/day per IP, no key).\n` +
    `Paid: same tools at /v1/*, from ${PRICE} USDC per call on ${NETWORK}` +
    ` (whole-file capability audit: ${AUDIT_PRICE}), x402 protocol (HTTP 402 + payment header).\n` +
    `Discovery: /openapi.json, /.well-known/x402, /.well-known/x402.json.\n\nTools (price per call):\n` +
    TOOL_ROUTES.map((r) => `- ${r.method.toUpperCase()} /v1${r.path} — ${r.price ?? PRICE} — ${r.summary}`).join('\n') + '\n',
  ));

  app.notFound((c) => c.json({ ok: false, error: { code: 'not_found', message: `no such route: ${c.req.method} ${new URL(c.req.url).pathname}` } }, 404));

  return app;
}

export default createApp;
