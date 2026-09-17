# Evidence — x402 seller side works (2026-09-16)

Host: WSL Ubuntu, Node v22.22.1, `@x402/*` v2.26.0, `@x402/hono` v2.26.0, Hono v4.
Command: `PORT=4025 HTTPS_PROXY=http://127.0.0.1:16888 node src/local.mjs`
Request: `curl -s -X POST -H 'Content-Type: application/json' -d '{"text":"abc"}' http://127.0.0.1:4025/v1/hash`

## 1. Facilitator capabilities (live)
`GET https://x402.org/facilitator/supported` → `http=200`, 11 kinds, first three:
`exact eip155:84532`, `upto eip155:84532`, `batch-settlement eip155:84532`
⇒ **testnet-only: `eip155:8453` (Base mainnet) is NOT offered here.**

## 2. Unpaid request → 402 with complete payment requirements
```
HTTP/1.1 402 Payment Required
Payment-Required: <base64>
```
Decoded `Payment-Required` (header, x402Version 2):
```json
{ "x402Version": 2, "error": "Payment required",
  "resource": { "url": "http://127.0.0.1:4025/v1/hash", "description": "Hash a UTF-8 string (sha1/sha256/sha384/sha512)",
                "mimeType": "application/json", "serviceName": "alice-deterministic-tools",
                "tags": ["encoding","crypto","deterministic"] },
  "accepts": [{ "scheme": "exact", "network": "eip155:84532", "amount": "2000",
                "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
                "payTo": "0xA96b64ac53196021f4a939a69CccF8e7aF161378",
                "maxTimeoutSeconds": 300, "extra": {"name":"USDC","version":"2"} }],
  "extensions": { "bazaar": { "info": { "input": {...}, "output": {...} }, "schema": {...} } } }
```
Checklist against the protocol contract:
- [x] 402 status + `Payment-Required` header (base64 JSON, x402Version 2)
- [x] `scheme=exact`, `amount="2000"` (= $0.002 at 6 decimals), `asset` = USDC on that network
- [x] `payTo` = **my own wallet** `0xA96b64ac53196021f4a939a69CccF8e7aF161378`
- [x] `extensions.bazaar` present ⇒ catalogable by Bazaar discovery facilitators (no account)

## 3. Free trial works without any payment
`POST /trial/v1/hash {"text":"abc"}` → 200
`{"ok":true,"tool":"hash","algo":"sha256","encoding":"hex","input_bytes":3,"digest":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}`
Headers: `X-Trial-Remaining: 24`, `X-Alice-Service: alice-deterministic-tools v0`

## 4. Error semantics (precise, fail-loud)
`{"text":"abc","algo":"md5"}` → `400 {"ok":false,"error":{"code":"unsupported_value","message":"unsupported algo \"md5\"; supported: sha1, sha256, sha384, sha512"}}`
(bad encodings → `422 malformed_encoding`; malformed JWT → `422 malformed_jwt`; wrong field type → `400 invalid_field`)

## 5. Offline tests
`node test/tools.test.mjs` → 10/10 (sha1/sha256/sha512 known vectors, HMAC vector, base64/hex/url/base64url,
UTF-8 round trip, JWT sample, randomness shape, all error codes).

## Not yet verified (honest gaps)
- Actual settlement (needs a funded buyer wallet on Base Sepolia — that is a *buyer*, not this seller).
- Mainnet path (`eip155:8453`) — `x402.org/facilitator` does not support it; a mainnet facilitator is an open item.
- Public hosting (no origin exposed yet; trial limiter is in-process memory).
