#!/usr/bin/env node
/**
 * lucid-mcp-bridge: a tiny stdio -> HTTPS bridge for MCP clients that only speak stdio
 * (older Claude Desktop builds, some editors). No dependencies: Node 18+ only.
 *
 * The client starts this script; it reads JSON-RPC messages (one per line) on stdin, POSTs each one to the
 * Lucid Labs server with your key, and writes the answers back on stdout.
 *
 * Your key comes from (first found):
 *   1. the LUCID_MCP_KEY environment variable
 *   2. --key-file <path>   (a file containing only the key)
 * Optional: LUCID_MCP_URL (default https://mcp.159.195.252.107.nip.io/mcp)
 *
 * Logs go to stderr only (stdout is the protocol).
 */
import fs from 'node:fs';
import readline from 'node:readline';

const URL_ = process.env.LUCID_MCP_URL || 'https://mcp.159.195.252.107.nip.io/mcp';
const kf = process.argv.indexOf('--key-file');
const KEY = (process.env.LUCID_MCP_KEY || (kf > 0 ? fs.readFileSync(process.argv[kf + 1], 'utf8') : '')).trim();
if (!/^lk_[A-Za-z0-9]{32,}$/.test(KEY)) {
  process.stderr.write('lucid-mcp-bridge: no valid key. Set LUCID_MCP_KEY=lk_... or pass --key-file <file>\n');
  process.exit(2);
}

let sessionId = '';
let protocolVersion = '';
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const fail = (id, message) => { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code: -32000, message } }); };

async function forward(msg) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${KEY}` };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
  let res;
  try {
    res = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(300_000) });
  } catch (e) {
    return fail(msg.id, `cannot reach the Lucid Labs server: ${e.message}`);
  }
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  if (res.status === 202) return; // notification accepted
  if (res.status === 401) return fail(msg.id, 'the server refused the key (401): check LUCID_MCP_KEY');
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!res.ok && !type.includes('json')) return fail(msg.id, `server answered HTTP ${res.status}: ${text.slice(0, 300)}`);
  const emit = (j) => {
    for (const m of Array.isArray(j) ? j : [j]) {
      if (m?.result?.protocolVersion) protocolVersion = m.result.protocolVersion;
      write(m);
    }
  };
  if (type.includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) { try { emit(JSON.parse(data)); } catch { /* keep-alive */ } }
    }
  } else if (text.trim()) {
    try { emit(JSON.parse(text)); } catch { fail(msg.id, `unreadable answer from the server: ${text.slice(0, 200)}`); }
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Set();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { process.stderr.write(`lucid-mcp-bridge: ignoring a non-JSON line\n`); return; }
  const p = forward(msg).catch((e) => fail(msg.id, e.message)).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on('close', async () => { await Promise.allSettled([...pending]); process.exit(0); });
