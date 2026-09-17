/**
 * deploy.mjs — 部署 Worker，**token 不进上下文**（值只在子进程 env 里）。
 *
 * 背景：以前部署要先 `vault.ps1 get -Field notes` 把 token 取到会话里再拼命令——
 * 那违背我自己新立的隐私纪律（值最小暴露）。这里改为：
 *   读库（非密 notes）→ 在**本进程内**提取 token → 只以 env 交给 wrangler → 输出脱敏。
 *
 * 用法：node deploy.mjs
 * 前置：E:\alice\.dsh\vault（alice-identity）内有 cloudflare-api 条目，notes 含 api-token=<53 字符>
 */
import { spawn } from 'node:child_process';

const VAULT = process.env.VAULT_SCRIPT || 'E:\\alice\\projects\\self\\alice-identity\\scripts\\vault.ps1';
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '200b6c00e5294186a46e588b4385ab5d';
const SITE = process.env.CF_VAULT_SITE || 'cloudflare-api';

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8') });
    child.stderr.on('data', (d) => { err += d.toString('utf8') });
    child.on('error', (e) => resolve({ code: null, out, err: err + e.message }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const got = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', VAULT, 'get', '-Site', SITE, '-Field', 'notes']);
if (got.code !== 0) {
  console.error(`读 vault 失败（code=${got.code}）：${got.err.trim() || '(no stderr)'}`);
  process.exit(2);
}
const notes = got.out.trim();                       // 形态：api-token=<53 字符>（可能带别的键）
const m = /api-token\s*=\s*([A-Za-z0-9_\-]+)/.exec(notes);
if (!m) {
  console.error('vault notes 里找不到 api-token=<...>（形态变了？先查条目字段名）');
  process.exit(3);
}
const token = m[1];
const fingerprint = token.slice(0, 4) + '…' + token.slice(-3) + ` (len ${token.length})`;
console.log(`[deploy] token 已从 vault 取出：${fingerprint}（值不落盘、不进上下文）`);

const redact = (s) => (token && s.includes(token) ? s.split(token).join('[redacted]') : s);

// Windows 两个坑（都实测踩过）：① spawn 'npx' → ENOENT（它是 .cmd 垫片）；
// ② spawn 'npx.cmd' → EINVAL（Node ≥20 出于安全禁止直接 spawn .cmd/.bat）。
// 正解：交给 cmd.exe 解析，argv 形式传整条命令（不用 shell:true，避免二次转义）。
const res = process.platform === 'win32'
  ? await run('cmd.exe', ['/d', '/s', '/c', 'npx -y wrangler@3 deploy'], {
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
      cwd: process.cwd(),
    })
  : await run('npx', ['-y', 'wrangler@3', 'deploy'], {
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
      cwd: process.cwd(),
    });
console.log(redact(res.out.trim().split('\n').slice(-18).join('\n')));
if (res.err.trim()) console.error(redact(res.err.trim().split('\n').slice(-8).join('\n')));
console.log(`[deploy] exit=${res.code}`);
process.exit(res.code === 0 ? 0 : 1);
