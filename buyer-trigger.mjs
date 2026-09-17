// buyer-trigger.mjs — 一次真实的 x402 支付尝试：让自己的服务被 facilitator 的 Bazaar 收录。
//
// 为什么需要这一步（2026-09-17 取证）：
//   PayAI Bazaar 的收录是**自动**的（无注册表单），但它靠 facilitator 在 /verify 或 /settle 时
//   从**买方 payment payload** 里提取我们的 bazaar 声明。我们从没有过任何一次支付尝试
//   ⇒ 25,522 条索引里 0 命中 ⇒ 对 agent 而言等于不存在。
//
// 本脚本扮演 buyer：向自己的 GET /v1/random 发起请求 → 收到 402 → 用钱包签名授权 →
// 重试一次。facilitator 的 /verify 会看到声明（verify 不动资金）。钱包 USDC 余额为 0，
// 因此即便进入 settle 也会因余额不足失败——本脚本的产出是**目录收录**，不是资金流动。
//
// 用法（私钥只经环境变量，绝不落盘）：
//   $env:ALICE_EVM_PRIVATE_KEY = <vault wallet-evm password>
//   node buyer-trigger.mjs [url]

import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const DEFAULT_TARGET =
  'https://alice-deterministic-tools.judicious-entrance.workers.dev/v1/random?bytes=8&format=hex';

const target = process.argv[2] || DEFAULT_TARGET;
const raw = process.env.ALICE_EVM_PRIVATE_KEY;

if (!raw || raw.trim() === '') {
  console.error('ALICE_EVM_PRIVATE_KEY is required (pass it via env, never as an argument)');
  process.exit(2);
}

const pk = raw.trim().startsWith('0x') ? raw.trim() : `0x${raw.trim()}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error(`private key shape looks wrong: len=${pk.length} (expected 0x + 64 hex)`);
  process.exit(2);
}

const account = privateKeyToAccount(pk);
console.log('buyer address:', account.address);
console.log('target       :', target);

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(account) }],
});

// 1) 先裸看一眼 402（确认服务确实在要价，也留下 payment-required 的形状证据）
try {
  const bare = await fetch(target, { method: 'GET' });
  const pr = bare.headers.get('payment-required');
  console.log(`[1] bare request -> status=${bare.status} payment-required=${pr ? pr.slice(0, 40) + '…' : '(none)'}`);
  if (pr) {
    const decoded = JSON.parse(Buffer.from(pr, 'base64').toString('utf8'));
    console.log('    accepts:', JSON.stringify(decoded.accepts?.[0] ?? {}).slice(0, 200));
    console.log('    has_bazaar_extension:', Boolean(decoded.extensions?.bazaar));
  }
} catch (e) {
  console.log('[1] bare request threw:', e?.message ?? String(e));
}

// 2) 带支付重试（verify 阶段不动资金；目录收录就发生在这里）
try {
  const res = await fetchWithPayment(target, { method: 'GET' });
  const body = await res.text();
  console.log(`[2] paid attempt -> status=${res.status}`);
  console.log('    payment-response:', res.headers.get('payment-response')?.slice(0, 80) ?? '(none)');
  console.log('    body:', body.slice(0, 400));
} catch (e) {
  console.log('[2] paid attempt threw:', e?.message ?? String(e));
  if (e?.cause) console.log('    cause:', String(e.cause).slice(0, 400));
}

console.log('done — now re-check the Bazaar index for this resource.');
