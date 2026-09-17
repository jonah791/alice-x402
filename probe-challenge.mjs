// probe-challenge.mjs — inspect the LIVE 402 challenge shape against the indexing recipe.
// No payment, no secrets: sends an unauthenticated request and decodes what came back.
// Usage: node probe-challenge.mjs
const BASE = process.env.X402_BASE || 'https://alice-deterministic-tools.judicious-entrance.workers.dev';

const targets = [
  ['POST', '/v1/hash'],
  ['GET', '/v1/random'],
  ['GET', '/.well-known/x402'],
  ['GET', '/.well-known/x402.json'],
];

for (const [method, path] of targets) {
  let r;
  try {
    r = await fetch(BASE + path, { method });
  } catch (e) {
    console.log(`\n=== ${method} ${path} -> FETCH FAILED: ${e.message}`);
    continue;
  }
  const body = await r.text();
  console.log(`\n=== ${method} ${path} -> ${r.status}  body=${body.length} chars`);
  console.log(`  content-type: ${r.headers.get('content-type')}`);

  const pr = r.headers.get('payment-required');
  if (pr) {
    let raw = '';
    try { raw = Buffer.from(pr, 'base64').toString('utf8'); } catch (e) { raw = `<b64 fail: ${e.message}>`; }
    console.log(`  [payment-required] header len=${pr.length} decoded=${raw.length} chars`);
    try {
      const j = JSON.parse(raw);
      console.log(`  top keys: ${Object.keys(j).join(', ')}`);
      const a0 = j.accepts && j.accepts[0];
      console.log(`  accepts[0]: ${a0 ? JSON.stringify(a0).slice(0, 260) : '(none)'}`);
      console.log(`  x402Version: ${j.x402Version}  resource: ${JSON.stringify(j.resource)}`);
      const ex = j.extensions;
      console.log(`  extensions: ${ex ? Object.keys(ex).join(',') : '(none)'}`);
      if (ex && ex.bazaar) {
        const b = ex.bazaar;
        console.log(`  bazaar keys: ${Object.keys(b).join(', ')}`);
        const info = b.info || b;
        console.log(`  bazaar.info keys: ${info && typeof info === 'object' ? Object.keys(info).join(', ') : typeof info}`);
        const s = JSON.stringify(b);
        console.log(`  bazaar size: ${s.length} chars`);
        console.log(`  bazaar snippet: ${s.slice(0, 700)}`);
      }
      const whole = JSON.stringify(j);
      const count = (re) => (whole.match(re) || []).length;
      console.log(`  [recipe checks] outputSchema=${count(/outputSchema/g)} inputSchema=${count(/inputSchema/g)} `
        + `discoverable=${count(/discoverable/g)} bodyType=${count(/bodyType/g)} example=${count(/example/g)}`);
    } catch (e) {
      console.log(`  decode/parse failed: ${e.message}`);
      console.log(`  raw head: ${raw.slice(0, 240)}`);
    }
  } else {
    console.log('  [payment-required] ABSENT');
    console.log(`  body head: ${body.slice(0, 300)}`);
  }
}
