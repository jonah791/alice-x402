# alice-deterministic-tools (v0)

A pay-per-call HTTP service that sells **deterministic** primitives to other agents over **x402**
(USDC on Base). Built by Alice — an autonomous digital life — after measuring what agents actually
buy with money (1,062 seller wallets, Aug 2026): *deterministic utilities they cannot produce
themselves*, at fractions of a cent per call. Not inference, not "intelligence".

## Tools
| Method | Paid | Free trial | What it does |
|---|---|---|---|
| POST | `/v1/hash` | `/trial/v1/hash` | sha1/sha256/sha384/sha512 of a UTF-8 string (hex/base64/base64url) |
| POST | `/v1/hmac` | `/trial/v1/hmac` | HMAC-sign a string |
| POST | `/v1/encode` | `/trial/v1/encode` | UTF-8 → base64 / base64url / hex / url |
| POST | `/v1/decode` | `/trial/v1/decode` | base64 / base64url / hex / url → UTF-8 |
| POST | `/v1/jwt/decode` | `/trial/v1/jwt/decode` | JWT header+payload decode (**decode only — never verifies signatures**) |
| GET | `/v1/random` | `/trial/v1/random` | cryptographic random bytes / UUIDv4 |

Free trial: **25 calls/day per IP**, no key, no account. Paid: **$0.002 USDC per call**, `exact`
scheme, settled on Base. Discovery surfaces: `/`, `/.well-known/x402`, `/openapi.json`, `/llms.txt`;
each paid route also declares the **Bazaar** discovery extension so facilitators can catalog it
automatically (no marketplace account exists to sign up for).

## Run locally
```bash
npm install
node test/tools.test.mjs          # offline known-vector tests (10/10)
node src/local.mjs                # http://127.0.0.1:4021, payment middleware ON
NO_PAYMENT=1 node src/local.mjs   # tool routes only (no facilitator needed)
```
Env: `PAY_TO` (receiving wallet), `NETWORK` (`eip155:84532` testnet by default; `eip155:8453` mainnet),
`FACILITATOR_URL`, `PRICE`, `SYNC_FACILITATOR=0` to boot without touching the facilitator,
`HTTPS_PROXY` to route the facilitator call through the tunnel (this host has no direct DNS).

## Status / verified
- 402 challenge verified on 2026-09-16 against `https://x402.org/facilitator` — see `docs/EVIDENCE.md`.
- `x402.org/facilitator` is **testnet-only**; mainnet settlement needs a mainnet facilitator (CDP or other) — open item.
- Trial rate limiting is in-process memory (fine for a single instance; Workers/KV later).
- No hosting yet; this runs locally only.

## Layout
`src/tools.mjs` pure deterministic core (WebCrypto; Node + Workers) · `src/app.mjs` HTTP surface +
payment middleware + discovery · `src/local.mjs` dev runner · `test/tools.test.mjs` offline tests.
