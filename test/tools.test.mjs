// Offline known-vector tests for the deterministic tool core. Run: node test/tools.test.mjs
import assert from 'node:assert/strict';
import { hash, hmac, encode, decode, jwtDecode, random, audit, maskLiterals, ToolError } from '../src/tools.mjs';

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('sha256("abc") hex', async () => {
  assert.equal((await hash({ text: 'abc' })).digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('sha1("abc") hex', async () => {
  assert.equal((await hash({ text: 'abc', algo: 'sha1' })).digest, 'a9993e364706816aba3e25717850c26c9cd0d89d');
});
test('sha512("abc") base64', async () => {
  assert.equal((await hash({ text: 'abc', algo: 'sha512', encoding: 'base64' })).digest,
    '3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==');
});
test('hmac-sha256 RFC-style vector', async () => {
  assert.equal((await hmac({ text: 'The quick brown fox jumps over the lazy dog', key: 'key' })).digest,
    'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
});
test('base64 encode/decode', () => {
  assert.equal(encode({ text: 'hello' }).result, 'aGVsbG8=');
  assert.equal(decode({ text: 'aGVsbG8=' }).result, 'hello');
});
test('hex + base64url + url', () => {
  assert.equal(encode({ text: 'hi', to: 'hex' }).result, '6869');
  assert.equal(decode({ text: '6869', from: 'hex' }).result, 'hi');
  assert.equal(encode({ text: 'a b/c', to: 'url' }).result, 'a%20b%2Fc');
  assert.equal(encode({ text: 'ÿÿ', to: 'base64url' }).result, 'w7_Dvw'); // base64url: '/' -> '_' (my first expectation was wrong; the test caught it)
});
test('utf8 round trip', () => {
  assert.equal(decode({ text: encode({ text: '你好·alice' }).result }).result, '你好·alice');
});
test('jwt decode (HS256 sample)', () => {
  const t = jwtDecode({ token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c' });
  assert.equal(t.alg, 'HS256');
  assert.equal(t.payload.sub, '1234567890');
  assert.equal(t.verified, false, 'decoder must never claim verification');
  assert.equal(t.expired, null);
});
test('random: uuid + byte length', () => {
  assert.equal(random({ format: 'uuid' }).value.length, 36);
  assert.equal(random({ bytes: 16 }).value.length, 32);
  assert.equal(random({ bytes: 8, format: 'base64' }).bytes, 8);
});
test('errors carry precise codes', async () => {
  await assert.rejects(() => hash({ text: 'x', algo: 'md5' }), (e) => e instanceof ToolError && e.code === 'unsupported_value' && e.status === 400);
  await assert.rejects(() => hash({ text: 5 }), (e) => e.code === 'invalid_field' && e.status === 400);
  assert.throws(() => decode({ text: 'zz!', from: 'base64' }), (e) => e.code === 'malformed_encoding' && e.status === 422);
  assert.throws(() => decode({ text: 'abc', from: 'hex' }), (e) => e.code === 'malformed_encoding');
  assert.throws(() => jwtDecode({ token: 'notajwt' }), (e) => e.code === 'malformed_jwt');
  await assert.rejects(() => hash({ text: 'ok', encoding: 'rot13' }), (e) => e.code === 'unsupported_value');
});

// ---------- capability audit (whole-file, line-based, priced apart) ----------
test('audit: capability-bearing file names each class with line numbers', () => {
  const src = [
    "import { exec } from 'child_process';", // L1 process execution
    "fetch('https://example.com');", // L2 network egress
    'const k = process.env.SECRET;', // L3 environment read
    'const x = 1;', // L4 clean
  ].join('\n');
  const r = audit({ text: src });
  assert.equal(r.verdict, 'capability-bearing');
  assert.equal(r.capabilities_found, 3);
  assert.deepEqual(Object.keys(r.capabilities).sort(), ['environment read', 'network egress', 'process execution']);
  assert.deepEqual(r.capabilities['process execution'].lines, [1]);
  assert.deepEqual(r.capabilities['network egress'].lines, [2]);
  assert.equal(r.capabilities['environment read'].count, 1);
  assert.equal(r.lines_scanned, 4);
  assert.equal(r.call_sites, 3);
});
test('audit: inert file is reported inert — and the notes refuse to call it safe', () => {
  const r = audit({ text: 'const x = 1;\nexport default x;' });
  assert.equal(r.verdict, 'inert');
  assert.equal(r.capabilities_found, 0);
  assert.deepEqual(r.capabilities, {});
  assert.ok(r.notes.some((n) => n.includes('not that the file is safe')));
});
test('audit: never echoes raw secrets (matched lines are masked before excerpting)', () => {
  // 这一行**既命中能力又含秘密**——若打码失效，断言必红（只测「秘密不在输出里」是弱判据）
  const src = "fetch('https://x.test?token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');";
  const r = audit({ text: src });
  assert.equal(r.capabilities['network egress'].count, 1, '该行必须被命中，否则证明不了打码');
  const blob = JSON.stringify(r);
  assert.ok(!blob.includes('ghp_'), 'token shape must be masked in excerpts');
  assert.ok(blob.includes('[redacted]'));
  assert.equal(maskLiterals('k=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), 'k=[redacted]');
  assert.equal(maskLiterals('key = 0x' + 'a'.repeat(64)), 'key = [redacted]');
});
test('audit: input guards are fail-loud and semantically distinct', () => {
  assert.throws(() => audit({ text: 5 }), (e) => e.code === 'invalid_field' && e.status === 400);
  assert.throws(() => audit({ text: 'x'.repeat(2000001) }), (e) => e.code === 'input_too_large' && e.status === 413);
});

let failed = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '->', e.message); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
