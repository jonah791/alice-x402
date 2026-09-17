// Alice's x402 utility service — deterministic tool core (v0).
//
// Design rules (from the market data, 2026-09-16):
//   · agents pay for DETERMINISTIC tools they cannot produce themselves, at fractions of a cent
//   · explicit input → explicit output; no "AI", no quality claims, just correctness + uptime
//   · WebCrypto only (runs unchanged on Node and Cloudflare Workers)
//   · pure functions here so they can be unit-tested offline with known vectors
//
// Every handler returns a plain object; invalid input throws ToolError with a precise code
// (semantic precision: invalid-input ≠ unsupported-algorithm ≠ malformed-encoding).

export class ToolError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const DIGESTS = { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
const UTF8 = new TextEncoder();

function needString(v, field) {
  if (typeof v !== 'string') throw new ToolError('invalid_field', `field "${field}" must be a string`, 400);
  return v;
}

function pick(map, value, field, fallback) {
  const key = (value === undefined || value === null ? fallback : String(value)).toLowerCase();
  if (!map[key]) {
    throw new ToolError('unsupported_value', `unsupported ${field} "${value}"; supported: ${Object.keys(map).join(', ')}`, 400);
  }
  return key;
}

const toHex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

function fromB64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function encodeOut(bytes, encoding) {
  if (encoding === 'hex') return toHex(bytes);
  if (encoding === 'base64') return toB64(bytes);
  if (encoding === 'base64url') return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  throw new ToolError('unsupported_value', `unsupported encoding "${encoding}"; supported: hex, base64, base64url`, 400);
}

// ---------- tools ----------

export async function hash({ text, algo = 'sha256', encoding = 'hex' }) {
  needString(text, 'text');
  const a = pick(DIGESTS, algo, 'algo', 'sha256');
  const bytes = UTF8.encode(text);
  const digest = await crypto.subtle.digest(DIGESTS[a], bytes);
  return { algo: a, encoding, input_bytes: bytes.length, digest: encodeOut(digest, encoding) };
}

export async function hmac({ text, key, algo = 'sha256', encoding = 'hex' }) {
  needString(text, 'text');
  needString(key, 'key');
  const a = pick(DIGESTS, algo, 'algo', 'sha256');
  const k = await crypto.subtle.importKey('raw', UTF8.encode(key), { name: 'HMAC', hash: DIGESTS[a] }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, UTF8.encode(text));
  return { algo: `hmac-${a}`, encoding, digest: encodeOut(sig, encoding) };
}

export function encode({ text, to = 'base64' }) {
  needString(text, 'text');
  const f = pick({ base64: 1, base64url: 1, hex: 1, url: 1 }, to, 'to', 'base64');
  const bytes = UTF8.encode(text);
  if (f === 'url') return { to: f, input_bytes: bytes.length, result: encodeURIComponent(text) };
  return { to: f, input_bytes: bytes.length, result: encodeOut(bytes, f) };
}

export function decode({ text, from = 'base64' }) {
  needString(text, 'text');
  const f = pick({ base64: 1, base64url: 1, hex: 1, url: 1 }, from, 'from', 'base64');
  if (f === 'url') {
    try { return { from: f, result: decodeURIComponent(text) }; }
    catch { throw new ToolError('malformed_encoding', 'url input is not valid percent-encoding', 422); }
  }
  if (f === 'hex') {
    if (!/^[0-9a-fA-F]*$/.test(text) || text.length % 2 !== 0) {
      throw new ToolError('malformed_encoding', 'hex input must have an even number of hex digits', 422);
    }
    const pairs = text.match(/../g) ?? [];
    return { from: f, result: new TextDecoder().decode(Uint8Array.from(pairs, (h) => parseInt(h, 16))) };
  }
  try {
    const norm = f === 'base64url' ? text.replace(/-/g, '+').replace(/_/g, '/') : text;
    const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
    return { from: f, result: new TextDecoder().decode(fromB64(padded)) };
  } catch {
    throw new ToolError('malformed_encoding', `${f} input could not be decoded`, 422);
  }
}

export function jwtDecode({ token }) {
  needString(token, 'token');
  const parts = token.split('.');
  if (parts.length < 2) throw new ToolError('malformed_jwt', 'a JWT needs at least header.payload', 422);
  const seg = (s, what) => {
    try {
      const norm = s.replace(/-/g, '+').replace(/_/g, '/');
      const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
      return JSON.parse(new TextDecoder().decode(fromB64(padded)));
    } catch {
      throw new ToolError('malformed_jwt', `${what} segment is not valid base64url JSON`, 422);
    }
  };
  const header = seg(parts[0], 'header');
  const payload = seg(parts[1], 'payload');
  const now = Math.floor(Date.now() / 1000);
  return {
    header,
    payload,
    signature_b64url: parts[2] ?? null,
    signed: parts.length === 3 && Boolean(parts[2]),
    verified: false, // this tool DECODES; it never verifies signatures — say so loudly
    alg: header?.alg ?? null,
    issued_at: typeof payload?.iat === 'number' ? payload.iat : null,
    expires_at: typeof payload?.exp === 'number' ? payload.exp : null,
    expired: typeof payload?.exp === 'number' ? payload.exp <= now : null,
    now,
  };
}

export function random({ bytes = 32, format = 'hex' }) {
  const n = Number(bytes);
  if (!Number.isInteger(n) || n < 1 || n > 1024) throw new ToolError('invalid_field', 'bytes must be an integer 1..1024', 400);
  if (String(format).toLowerCase() === 'uuid') return { format: 'uuid', bytes: 16, value: crypto.randomUUID() };
  const f = pick({ hex: 1, base64: 1, base64url: 1 }, format, 'format', 'hex');
  const buf = crypto.getRandomValues(new Uint8Array(n));
  return { format: f, bytes: n, value: encodeOut(buf, f) };
}

// ---------- capability audit (whole-file analysis; priced apart from the primitives) ----------
//
// Answers a question an agent cannot answer by itself: what can this source file actually DO?
// Deterministic by construction — a fixed rule table over lines, no drifting heuristics.
// Output never echoes raw source: matching lines are masked first (a capability audit must not
// become a secret-exfiltration channel — our own identity discipline, applied to our own service).

const CAPABILITY_RULES = [
  { name: 'process execution', patterns: [/\bchild_process\b/, /\bexec(?:Sync|File|FileSync)?\s*\(/, /\bspawn(?:Sync)?\s*\(/, /\bfork\s*\(/, /\beval\s*\(/, /\bnew\s+Function\s*\(/] },
  { name: 'network egress', patterns: [/\bfetch\s*\(/, /\bhttps?\.(?:request|get|post)\b/, /\bnet\.connect\b/, /\bnew\s+WebSocket\s*\(/, /\baxios\b/, /\bundici\b/, /\bnavigator\.sendBeacon\b/] },
  { name: 'filesystem write', patterns: [/\bwriteFile(?:Sync)?\s*\(/, /\bappendFile(?:Sync)?\s*\(/, /\bmkdir(?:Sync)?\s*\(/, /\brm(?:Sync|dir(?:Sync)?)\s*\(/, /\bunlink(?:Sync)?\s*\(/, /\brename(?:Sync)?\s*\(/, /\bcreateWriteStream\s*\(/] },
  { name: 'listening socket', patterns: [/\bcreateServer\s*\(/, /\blisten\s*\(/, /\bexpress\s*\(/, /\bapp\.listen\b/] },
  { name: 'environment read', patterns: [/\bprocess\.env\b/, /\bDeno\.env\b/, /\bimport\.meta\.env\b/] },
];

const SECRET_SHAPES = [
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghr|xox[baprs]|AKIA|ASIA|AIza)[A-Za-z0-9_-]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b0x[0-9a-fA-F]{64}\b/g,
  /\b[A-Za-z0-9+/]{60,}={0,2}\b/g,
];

/** Mask likely secrets before echoing any source line (token prefixes / JWT / private-key shape / long base64). */
export function maskLiterals(line) {
  let out = String(line);
  for (const re of SECRET_SHAPES) out = out.replace(re, '[redacted]');
  return out;
}

const AUDIT_MAX_TEXT = 2_000_000;
const AUDIT_MAX_EXAMPLES = 3;

/**
 * Static capability audit of one source file (line-based, no AST, no execution).
 * Verdict is deliberately narrow: "inert" means *no listed capability pattern matched* — it is
 * not a safety claim, and the notes say so.
 */
export function audit({ text }) {
  needString(text, 'text');
  if (text.length > AUDIT_MAX_TEXT) {
    throw new ToolError('input_too_large', `audit accepts text up to ${AUDIT_MAX_TEXT} characters`, 413);
  }
  const lines = text.split(/\r?\n/);
  const capabilities = {};
  let callSites = 0;
  for (const rule of CAPABILITY_RULES) {
    const hits = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      for (const re of rule.patterns) {
        if (re.test(line)) {
          hits.push({ line: i + 1, excerpt: maskLiterals(line).trim().slice(0, 160) });
          break;
        }
      }
    }
    if (hits.length > 0) {
      capabilities[rule.name] = {
        count: hits.length,
        lines: hits.slice(0, 20).map((h) => h.line),
        examples: hits.slice(0, AUDIT_MAX_EXAMPLES),
      };
      callSites += hits.length;
    }
  }
  const found = Object.keys(capabilities).length;
  return {
    verdict: found > 0 ? 'capability-bearing' : 'inert',
    capabilities_found: found,
    call_sites: callSites,
    lines_scanned: lines.length,
    capabilities,
    notes: [
      'static text scan over lines; no AST, no execution',
      'a verdict of "inert" means no listed capability pattern matched — not that the file is safe',
      'excerpts are masked; the service never echoes raw matched source',
    ],
  };
}

export const TOOLS = { hash, hmac, encode, decode, jwtDecode, random, audit };
