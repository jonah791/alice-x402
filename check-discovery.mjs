/**
 * check-discovery.mjs — 本地校验发现面是否符合 x402scan 官方 DISCOVERY.md 规格。
 *
 * 为什么要有它：这些形状错误（resources 用对象数组、OpenAPI 缺 x-payment-info）
 * **只有被爬虫抓的时候才暴露**，本地不测就等于把验收交给运气。
 * 依据：x402scan docs/DISCOVERY.md + 官方审计器 `npx -y @agentcash/discovery <domain> -v` 实测输出。
 *
 * 用法：node check-discovery.mjs
 */
process.env.PRICE ||= '$0.002';
process.env.AUDIT_PRICE ||= '$0.05';
process.env.NETWORK ||= 'eip155:8453';
process.env.PAY_TO ||= '0xA96b64ac53196021f4a939a69CccF8e7aF161378';

const ORIGIN = 'https://alice-deterministic-tools.judicious-entrance.workers.dev';

const { default: createApp } = await import('./src/app.mjs');

const steps = [];
let passed = 0;
const record = (label, ok, detail = '') => {
  steps.push({ label, ok, detail });
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} · ${label}${detail ? ` — ${detail}` : ''}`);
};

const app = createApp({});
const get = async (path) => {
  const res = await app.request(new URL(path, ORIGIN));
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, type, body };
};

// ── OpenAPI（发现优先级 1） ─────────────────────────────────────────────────
const oa = await get('/openapi.json');
record('OpenAPI 200', oa.status === 200, `status=${oa.status}`);
record('OpenAPI 顶层必备字段', Boolean(oa.body?.openapi && oa.body?.info?.title && oa.body?.info?.version && oa.body?.paths),
  `openapi=${oa.body?.openapi} paths=${Object.keys(oa.body?.paths ?? {}).length}`);
record('OpenAPI info.contact 有 url 或 email', Boolean(oa.body?.info?.contact?.url || oa.body?.info?.contact?.email));
record('OpenAPI info.x-guidance 存在（agent 可读指引）', Boolean(oa.body?.info?.['x-guidance']));

const paths = oa.body?.paths ?? {};
const paidPaths = Object.entries(paths).filter(([p]) => p.startsWith('/v1/'));
const trialPaths = Object.entries(paths).filter(([p]) => p.startsWith('/trial/v1/'));
record('付费与试用路由都在（各 7 条）', paidPaths.length === 7 && trialPaths.length === 7,
  `paid=${paidPaths.length} trial=${trialPaths.length}`);

let missingPaymentInfo = [];
let badPrice = [];
let missing402 = [];
let missingSecurity = [];
for (const [p, ops] of paidPaths) {
  for (const [, op] of Object.entries(ops)) {
    const pi = op['x-payment-info'];
    if (!pi) { missingPaymentInfo.push(p); continue; }
    // protocols 必须是**对象数组**（审计器 schema：array(record)），每项含 x402 键
    if (!(Array.isArray(pi.protocols) && pi.protocols.some((x) => x && typeof x === 'object' && 'x402' in x))) {
      missingPaymentInfo.push(`${p}(protocols)`);
    }
    if (!(pi.price?.mode === 'fixed' && pi.price?.currency === 'USD' && /^[0-9]+(\.[0-9]+)?$/.test(String(pi.price?.amount ?? '')))) {
      badPrice.push(`${p}=${JSON.stringify(pi.price)}`);
    }
    if (!op.responses?.['402']) missing402.push(p);
    if (!(Array.isArray(op.security) && op.security.length === 0)) missingSecurity.push(p);
  }
}
record('每个付费操作都有 x-payment-info（protocols 含 x402）', missingPaymentInfo.length === 0, missingPaymentInfo.join(',') || '7/7');
record('x-payment-info.price 是 fixed/USD/十进制字符串', badPrice.length === 0, badPrice.join(',') || 'ok');
record('每个付费操作都有 402 响应', missing402.length === 0, missing402.join(',') || '7/7');
record('每个付费操作都声明 security: []（显式公开）', missingSecurity.length === 0, missingSecurity.join(',') || '7/7');

const trialNoSecurity = trialPaths.filter(([, ops]) => Object.values(ops).some((op) => !(Array.isArray(op.security) && op.security.length === 0)));
record('每个试用操作也声明 security: []', trialNoSecurity.length === 0, trialNoSecurity.map(([p]) => p).join(',') || '7/7');

record('OpenAPI 带 x-discovery.ownershipProofs', Boolean(oa.body?.['x-discovery']?.ownershipProofs?.length));

// ── /.well-known/x402（发现优先级 2）+ .json 变体 ───────────────────────────
const wk = await get('/.well-known/x402');
record('/.well-known/x402 200', wk.status === 200, `status=${wk.status}`);
record('version === 1', wk.body?.version === 1, `version=${wk.body?.version}`);

const res = wk.body?.resources;
const allStrings = Array.isArray(res) && res.length > 0 && res.every((r) => typeof r === 'string');
record('resources 是**非空字符串数组**（规格形状）', allStrings, Array.isArray(res) ? `len=${res.length} first=${String(res[0]).slice(0, 60)}` : typeof res);
record('resources 是**绝对 URL**', Array.isArray(res) && res.every((r) => typeof r === 'string' && r.startsWith('https://')),
  Array.isArray(res) ? `sample=${res[2] ?? ''}` : '');
record('ownershipProofs 含 payTo', (wk.body?.ownershipProofs ?? []).includes(process.env.PAY_TO));

const wkj = await get('/.well-known/x402.json');
record('/.well-known/x402.json 200（规格要求两种都给）', wkj.status === 200, `status=${wkj.status}`);
record('.json 变体与无扩展名版内容一致', JSON.stringify(wkj.body) === JSON.stringify(wk.body));

// ── 其他发现面 ──────────────────────────────────────────────────────────────
const fav = await get('/favicon.ico');
record('favicon.ico 200 且是图片类型', fav.status === 200 && /^image\//.test(fav.type), `status=${fav.status} type=${fav.type}`);

const root = await get('/');
record('服务卡列出三种发现文档', ['/openapi.json', '/.well-known/x402', '/.well-known/x402.json']
  .every((d) => (root.body?.discovery ?? []).includes(d)), JSON.stringify(root.body?.discovery));

// ── 运行时 402 权威性（规格：运行时高于静态元数据） ─────────────────────────
// 注意：这一节**打已部署服务**（fetch），不走本地 app.request——
// 本地没有 facilitator 的 live /supported 列表，会 RouteConfigurationError（502），
// 那是环境产物，不是发现面缺陷。运行时行为以线上为准。
const probe = await fetch(`${ORIGIN}/v1/hash`, { method: 'POST' });
const pr = probe.headers.get('payment-required');
record('不带 body 的 POST /v1/hash 直接得到 402（校验不得先于支付闸门）', probe.status === 402, `status=${probe.status}`);
record('402 携带 payment-required 头（x402 v2）', Boolean(pr), pr ? `header len=${pr.length}` : 'ABSENT');
if (pr) {
  const decoded = JSON.parse(Buffer.from(pr, 'base64').toString('utf8'));
  const a0 = decoded?.accepts?.[0];
  record('accepts[0].amount 是代币最小单位（"2000" = $0.002）', /^[0-9]+$/.test(String(a0?.amount ?? '')), `amount=${a0?.amount}`);
  record('402 带 bazaar 扩展（info.input/output）', Boolean(decoded?.extensions?.bazaar?.info?.input), Object.keys(decoded?.extensions ?? {}).join(','));
  record('accepts[0].payTo = 我的收款地址', String(a0?.payTo).toLowerCase() === String(process.env.PAY_TO).toLowerCase(), String(a0?.payTo).slice(0, 12) + '…');
  const auditProbe = await fetch(`${ORIGIN}/v1/audit`, { method: 'POST' });
  const apr = auditProbe.headers.get('payment-required');
  const aDecoded = apr ? JSON.parse(Buffer.from(apr, 'base64').toString('utf8')) : null;
  record('/audit 的 402 报价 = 50000（$0.05，未回退到默认价）', String(aDecoded?.accepts?.[0]?.amount) === '50000', `amount=${aDecoded?.accepts?.[0]?.amount}`);
}

// ── 线上发现文档是否已部署（本地源码更新后未部署时会 FAIL——这是部署闸门） ──
const liveOa = await fetch(`${ORIGIN}/openapi.json`).then((r) => r.json()).catch(() => null);
const liveHasPaymentInfo = Object.values(liveOa?.paths ?? {}).some((ops) => Object.values(ops).some((op) => op['x-payment-info']));
record('线上 OpenAPI 已含 x-payment-info（= 本次改动已部署）', liveHasPaymentInfo, liveHasPaymentInfo ? 'deployed' : 'NOT deployed yet');
const liveWk = await fetch(`${ORIGIN}/.well-known/x402`).then((r) => r.json()).catch(() => null);
record('线上 /.well-known/x402 的 resources 已是字符串数组（= 已部署）',
  Array.isArray(liveWk?.resources) && liveWk.resources.every((x) => typeof x === 'string'), `type=${Array.isArray(liveWk?.resources) ? 'array' : typeof liveWk?.resources}`);
record('线上 /.well-known/x402.json 已可访问（= 已部署）', (await fetch(`${ORIGIN}/.well-known/x402.json`)).status === 200);


console.log(`\n结果：${passed}/${steps.length} ${passed === steps.length ? '通过' : '有失败项'}`);
process.exit(passed === steps.length ? 0 : 1);
