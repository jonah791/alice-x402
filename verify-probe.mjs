// verify-probe.mjs — 直接问 facilitator：我们的 bazaar 声明到底发生了什么？
//
// 背景（2026-09-17）：向自己的服务发过一次完整的 x402 支付尝试（buyer-trigger.mjs），
// 但 /discovery/listing-status 对 /v1/random、/v1/hash、/v1/audit 三条全返 404
// ——即「既无目录行、也无写入结果」⇒ facilitator 从未处理过我们的声明。
//
// 本探针把链路拆开逐段验：
//   ① 取 402 → ② 用 client 构造 payment payload（**关键：看 payload.extensions 有没有被复制**）
//   → ③ 直接打 facilitator 的 /verify → ④ 解 EXTENSION-RESPONSES 头（文档说的官方诊断口径）
//
// 用法：$env:ALICE_EVM_PRIVATE_KEY = <vault wallet-evm password>; node verify-probe.mjs [targetUrl]

import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const TARGET =
  process.argv[2] || 'https://alice-deterministic-tools.judicious-entrance.workers.dev/v1/random?bytes=8&format=hex';
const FACILITATOR = process.argv[3] || 'https://facilitator.payai.network';

const raw = (process.env.ALICE_EVM_PRIVATE_KEY ?? '').trim();
if (raw === '') {
  console.error('ALICE_EVM_PRIVATE_KEY is required');
  process.exit(2);
}
const account = privateKeyToAccount(raw.startsWith('0x') ? raw : `0x${raw}`);
console.log('buyer:', account.address);
console.log('target:', TARGET);

const client = new x402Client().register('eip155:8453', new ExactEvmScheme(account));
const httpClient = new x402HTTPClient(client);

// ① 取 402
const res = await fetch(TARGET, { method: 'GET' });
console.log('[1] status=' + res.status);
const prHeader = res.headers.get('payment-required');
if (!prHeader) {
  console.error('    no payment-required header — cannot continue');
  process.exit(3);
}
let prBody;
try {
  prBody = JSON.parse(Buffer.from(prHeader, 'base64').toString('utf8'));
} catch {
  prBody = undefined;
}
const paymentRequired = httpClient.getPaymentRequiredResponse((n) => res.headers.get(n), prBody);
console.log('    accepts[0]=' + JSON.stringify(paymentRequired.accepts?.[0] ?? {}).slice(0, 220));
console.log('    paymentRequired.extensions keys=' + (Object.keys(paymentRequired.extensions ?? {}).join(',') || '(none)'));

// ② 构造 payload（关键判据：extensions 是否被复制进 payload）
let payload;
try {
  payload = await client.createPaymentPayload(paymentRequired);
  console.log('[2] payload keys=' + Object.keys(payload).join(','));
  const pe = Object.keys(payload.extensions ?? {});
  console.log('    payload.extensions keys=' + (pe.join(',') || '(none)'));
  if (pe.length === 0) console.log('    ⚠ 声明没有进 payload —— 这就是断点（文档点名的 Step 2）');
} catch (e) {
  console.error('[2] createPaymentPayload threw: ' + (e?.message ?? String(e)));
  process.exit(4);
}

// ③ 直连 facilitator /verify
try {
  const vres = await fetch(FACILITATOR + '/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: paymentRequired.accepts?.[0],
    }),
  });
  console.log('[3] verify status=' + vres.status);
  const er = vres.headers.get('extension-responses');
  console.log('    EXTENSION-RESPONSES=' + (er ?? '(none)'));
  if (er) {
    try {
      console.log('    decoded=' + Buffer.from(er, 'base64').toString('utf8'));
    } catch {
      console.log('    (header not base64-decodable)');
    }
  }
  const text = await vres.text();
  console.log('    body=' + text.slice(0, 700));
} catch (e) {
  console.error('[3] verify threw: ' + (e?.message ?? String(e)));
}

console.log('done');
