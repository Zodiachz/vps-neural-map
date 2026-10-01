#!/usr/bin/env node
'use strict';
// vps-neural-map: serves the 3D map of this server on a local port, behind a random token.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const pkg = require('../package.json');

const HELP = `vps-neural-map ${pkg.version}
Your whole Linux server as a live 3D neural network.

Usage: vps-neural-map [options]

  -p, --port <n>        port to listen on (default 7777)
      --host <addr>     address to bind (default 127.0.0.1 — reach it with an SSH tunnel)
      --token <str>     access token (default: random each start, or $VNM_TOKEN)
      --skip <list>     collectors to turn off, comma-separated:
                        ${require('../lib/collect').COLLECTORS.join(', ')}
      --hide <paths>    comma-separated paths whose processes/dirs are left off the map
      --fs-roots <l>    du roots as path:depth, e.g. /opt:3,/var/www:2
      --redis-args <s>  extra redis-cli arguments, e.g. "-p 6380 --user me --pass secret"
      --mask-ips        show IP addresses as 203.0.•.• (for screenshots)
      --demo            serve a generated demo server instead of this machine
  -h, --help            this help
  -v, --version         version

Example:
  sudo vps-neural-map
  ssh -L 7777:127.0.0.1:7777 you@server     # on your computer, then open the printed link
`;

function parseArgs(argv) {
  const o = { port: 7777, host: '127.0.0.1', token: process.env.VNM_TOKEN || '', skip: [], hide: [], fsRoots: null, redisArgs: [], maskIps: false, demo: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) fail(`${a} needs a value`); return argv[++i]; };
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const val = () => (inline != null ? inline : next());
    switch (flag) {
      case '-p': case '--port': o.port = +val(); break;
      case '--host': o.host = val(); break;
      case '--token': o.token = val(); break;
      case '--skip': o.skip = val().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--hide': o.hide = val().split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean); break;
      case '--fs-roots': o.fsRoots = val().split(',').filter(Boolean).map((s) => { const [p, d] = s.split(':'); return [p.replace(/\/+$/, '') || '/', Math.max(1, Math.min(4, +d || 2))]; }); break;
      case '--redis-args': o.redisArgs = val().split(/\s+/).filter(Boolean); break;
      case '--mask-ips': o.maskIps = true; break;
      case '--demo': o.demo = true; break;
      case '-h': case '--help': process.stdout.write(HELP); process.exit(0); break;
      case '-v': case '--version': console.log(pkg.version); process.exit(0); break;
      default: fail(`unknown option ${a}  (see --help)`);
    }
  }
  if (!(Number.isInteger(o.port) && o.port > 0 && o.port < 65536)) fail('invalid --port (expected an integer 1-65535)');
  return o;
}
function fail(msg) { console.error('vps-neural-map: ' + msg); process.exit(2); }

const opt = parseArgs(process.argv.slice(2));
const token = opt.token || crypto.randomBytes(18).toString('base64url');
if (token.length < 12) fail('--token must be at least 12 characters');

let source;
if (opt.demo) {
  source = require('../public/demo.js');
} else {
  if (process.platform !== 'linux') fail('reads /proc, so it runs on Linux only. Try --demo to see it anywhere.');
  source = require('../lib/collect');
  const unknown = opt.skip.filter((s) => !source.COLLECTORS.includes(s));
  if (unknown.length) fail('unknown collector(s) in --skip: ' + unknown.join(', '));
  source.configure({ skip: opt.skip, hidePaths: opt.hide, fsRoots: opt.fsRoots, redisArgs: opt.redisArgs, maskIps: opt.maskIps });
}

// ---- static files, loaded once ----
const PUB = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const FILES = new Map();
for (const rel of ['index.html', 'app.js', 'style.css', 'demo.js', 'favicon.svg', 'vendor/three.min.js', 'vendor/d3-force-3d.min.js']) {
  const buf = fs.readFileSync(path.join(PUB, rel));
  FILES.set('/' + rel, { type: TYPES[path.extname(rel)], buf, gz: zlib.gzipSync(buf, { level: 9 }) });
}
FILES.set('/', FILES.get('/index.html'));

// ---- auth: ?token=… once, then an HttpOnly cookie ----
const COOKIE = 'vnm_token';
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const TOKEN_D = digest(token);
const tokenOk = (s) => !!s && crypto.timingSafeEqual(digest(s), TOKEN_D);
function cookieOf(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function authed(req) {
  const h = String(req.headers.authorization || '');
  return tokenOk(cookieOf(req)) || (h.startsWith('Bearer ') && tokenOk(h.slice(7)));
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
function send(req, res, code, type, buf, gz, extra) {
  const headers = Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' }, SEC_HEADERS, extra || {});
  if (gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { headers['Content-Encoding'] = 'gzip'; buf = gz; }
  headers['Content-Length'] = buf.length;
  res.writeHead(code, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}
const DENIED = Buffer.from(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>vps-neural-map</title>
<body style="background:#05070c;color:#c9d4e6;font:15px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box">
<div style="max-width:440px"><h2 style="margin:0 0 8px">🧠 vps-neural-map</h2><p>Open the link printed in the terminal where the server was started (it ends with <code>?token=…</code>).</p></div>`);

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'text/plain', Buffer.from('method not allowed'));
    const url = new URL(req.url, 'http://x');
    const q = url.searchParams.get('token');
    if (q != null) {
      if (!tokenOk(q)) return send(req, res, 401, 'text/html; charset=utf-8', DENIED);
      return send(req, res, 302, 'text/plain', Buffer.from('ok'), null, {
        Location: '/',
        'Set-Cookie': `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
      });
    }
    if (!authed(req)) return send(req, res, 401, url.pathname.startsWith('/api/') ? 'application/json' : 'text/html; charset=utf-8',
      url.pathname.startsWith('/api/') ? Buffer.from('{"ok":false,"error":"unauthorized"}') : DENIED);

    if (url.pathname === '/api/graph') {
      if (opt.demo) { const j = Buffer.from(JSON.stringify(source.graph())); return send(req, res, 200, 'application/json', j, zlib.gzipSync(j)); }
      const g = await source.graph();
      return send(req, res, 200, 'application/json', g.json, g.gz);
    }
    if (url.pathname === '/api/pulse') {
      const p = await source.pulse();
      return send(req, res, 200, 'application/json', Buffer.from(JSON.stringify(p)));
    }
    const f = FILES.get(url.pathname);
    if (f) return send(req, res, 200, f.type, f.buf, f.gz);
    return send(req, res, 404, 'text/plain', Buffer.from('not found'));
  } catch (e) {
    console.error('[vps-neural-map]', e && e.stack || e);
    if (!res.headersSent) send(req, res, 500, 'application/json', Buffer.from('{"ok":false,"error":"internal"}'));
  }
});

server.on('error', (e) => fail(e.code === 'EADDRINUSE' ? `port ${opt.port} is already in use (try --port)` : e.message));
server.listen(opt.port, opt.host, () => {
  const shown = opt.host.includes(':') ? `[${opt.host}]` : opt.host;
  const link = `http://${shown === '0.0.0.0' || shown === '[::]' ? '127.0.0.1' : shown}:${opt.port}/?token=${token}`;
  console.log(`\n  🧠 vps-neural-map ${pkg.version}${opt.demo ? '  (demo data)' : ''}\n`);
  console.log(`  Open:  ${link}\n`);
  if (!opt.demo) {
    const list = source.detect();
    console.log('  Layers: ' + list.map((c) => (c.enabled && c.available ? c.name : `\x1b[2m${c.name}\x1b[0m`)).join(' '));
    if (!source.isRoot()) console.log('  Note:   not running as root — other users\' processes, sockets and databases are partly hidden.');
  }
  if (!/^(127\.|::1$|localhost$)/.test(opt.host)) {
    console.log(`\n  \x1b[33mWarning:\x1b[0m listening on ${opt.host}. The map shows processes, ports and peer IPs;`);
    console.log('  anyone who gets the token sees them. Prefer the default 127.0.0.1 + an SSH tunnel.');
  } else {
    console.log(`  From your computer: ssh -N -L ${opt.port}:127.0.0.1:${opt.port} <user>@<server>   then open the link above`);
  }
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
