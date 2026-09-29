'use strict';
// Collectors: every moving part of a Linux server as ONE graph.
//
// graph(): nodes + links, rebuilt at most every GRAPH_TTL. The expensive collectors (du, packages,
//          database tables, redis key scan, open-file scan) keep longer caches of their own and
//          refresh in the background (stale-while-revalidate).
// pulse(): the cheap live layer, ~every 1.5 s: CPU per process, host CPU/RAM/net/disk, TCP bytes
//          per link, redis ops. The browser animates on top of it.
//
// Read-only by design: /proc, ss, systemctl show, nginx -T, docker ps, SQL SELECTs, redis SCAN/INFO.
// What reaches the browser is names, sizes, counts and states: never environment variables,
// process arguments beyond a script name, redis values or table contents. Long token-looking
// strings in cron commands are masked.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PAGE = 4096;
const HZ = 100; // USER_HZ clock ticks
const GRAPH_TTL = 8000;
const TOKENISH = /[A-Za-z0-9_\-+/=]{28,}/g;

// sbin tools (ufw, nginx, runuser) are often missing from a non-login PATH
process.env.PATH = [process.env.PATH || '', '/usr/local/sbin', '/usr/sbin', '/sbin'].join(':');

const COLLECTORS = ['pm2', 'systemd', 'docker', 'ports', 'tcp', 'nginx', 'tls', 'postgres', 'mysql', 'redis',
  'sqlite', 'fs', 'packages', 'cron', 'security'];

const OPT = {
  skip: new Set(),
  hidePaths: [],
  maskIps: false,
  fsRoots: [['/opt', 3], ['/root', 2], ['/etc', 1], ['/var/log', 2], ['/var/lib', 1], ['/home', 2],
    ['/srv', 2], ['/var/www', 2], ['/usr/local', 2], ['/var/backups', 1]],
  redisArgs: [],
};
const SALT = crypto.randomBytes(8).toString('hex');

function configure(o = {}) {
  if (o.skip) OPT.skip = new Set(o.skip);
  if (o.hidePaths) OPT.hidePaths = o.hidePaths.filter(Boolean);
  if (o.maskIps != null) OPT.maskIps = !!o.maskIps;
  if (o.fsRoots && o.fsRoots.length) OPT.fsRoots = o.fsRoots;
  if (o.redisArgs) OPT.redisArgs = o.redisArgs;
}
const on = (name) => !OPT.skip.has(name);

function which(cmd) {
  for (const d of (process.env.PATH || '').split(':')) {
    if (!d) continue;
    try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch (e) { /* next */ }
  }
  return false;
}
const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

// What this host can show, for the startup banner.
function detect() {
  const has = {
    pm2: which('pm2'), systemd: which('systemctl'), docker: which('docker'), ports: which('ss'), tcp: which('ss'),
    nginx: which('nginx'), tls: fs.existsSync('/etc/letsencrypt/live'), postgres: which('psql'), mysql: which('mysql'),
    redis: which('redis-cli'), sqlite: which('sqlite3'), fs: which('du'), packages: which('dpkg-query') || which('rpm'),
    cron: which('crontab') || fs.existsSync('/etc/cron.d'), security: which('ufw') || which('fail2ban-client'),
  };
  return COLLECTORS.map((c) => ({ name: c, available: !!has[c], enabled: on(c) }));
}

// Hide a path (and every process started from it) from the map. Display choice only.
const hiddenPath = (p) => !!p && OPT.hidePaths.some((h) => p === h || p.startsWith(h + '/'));
function hiddenPids(procs) {
  if (!OPT.hidePaths.length) return new Set();
  const hide = new Set(procs.filter((p) => hiddenPath(p.cwd) || hiddenPath(p.exe) || (p.argv || []).some((a) => a.startsWith('/') && hiddenPath(a))).map((p) => p.pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const p of procs) if (!hide.has(p.pid) && hide.has(p.ppid)) { hide.add(p.pid); grew = true; }
  }
  return hide;
}

// --mask-ips: stable per-run pseudonyms, so a screenshot can be shared without leaking addresses
function ipLabel(ip) {
  if (!OPT.maskIps || !ip) return ip;
  if (/^(127\.|::1$|0\.0\.0\.0$|::$|\*$)/.test(ip)) return ip;
  if (ip.includes('.')) { const p = ip.split('.'); return p[0] + '.' + p[1] + '.•.•'; }
  return ip.split(':').slice(0, 2).join(':') + ':•••';
}
function ipKey(ip) {
  if (!OPT.maskIps) return ip;
  return crypto.createHash('sha1').update(SALT + ip).digest('hex').slice(0, 12);
}
const maskList = (s) => (OPT.maskIps ? String(s).split(/\s*·\s*/).map(ipLabel).join(' · ') : s);

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 64 << 20, encoding: 'utf8' }, (err, out) => resolve(out || ''));
  });
}

// Serve the last value; refresh in the background once it is older than `ttl`.
// The very first call waits up to `firstWait` ms, then answers `empty` (filled next round).
function swr(ttl, fn, empty, firstWait = 6000) {
  let val = null; let at = 0; let pending = null;
  const refresh = () => {
    if (!pending) {
      pending = Promise.resolve().then(fn)
        .then((v) => { val = v; at = Date.now(); }, (e) => console.error('[collect]', e && e.message))
        .finally(() => { pending = null; });
    }
    return pending;
  };
  return async () => {
    if (val !== null) { if (Date.now() - at > ttl) refresh(); return val; }
    await Promise.race([refresh(), new Promise((r) => setTimeout(r, firstWait))]);
    return val !== null ? val : empty;
  };
}

const safe = (p, empty) => Promise.resolve(p).catch((e) => { console.error('[collect]', e && e.message); return empty; });
const mask = (s) => String(s || '').replace(TOKENISH, '•••').slice(0, 180);
const readText = (f) => fsp.readFile(f, 'utf8').catch(() => '');
const when = (name, fn, empty) => (on(name) ? fn() : Promise.resolve(empty));

// ---------------------------------------------------------------- /proc
let BOOT_SEC = 0;
async function bootSec() {
  if (!BOOT_SEC) { const m = (await readText('/proc/stat')).match(/^btime (\d+)/m); BOOT_SEC = m ? +m[1] : 0; }
  return BOOT_SEC;
}

async function readProcs(detail) {
  const names = (await fsp.readdir('/proc')).filter((n) => /^\d+$/.test(n));
  const out = [];
  await Promise.all(names.map(async (p) => {
    try {
      const st = await fsp.readFile(`/proc/${p}/stat`, 'utf8');
      const r = st.lastIndexOf(')');
      const f = st.slice(r + 2).split(' ');
      const o = {
        pid: +p, comm: st.slice(st.indexOf('(') + 1, r), state: f[0], ppid: +f[1],
        ticks: +f[11] + +f[12], threads: +f[17], start: +f[19], rss: +f[21] * PAGE,
      };
      o.kthread = o.pid === 2 || o.ppid === 2;
      if (detail && !o.kthread) {
        const [s, cmd, cwd, exe] = await Promise.all([
          fsp.stat(`/proc/${p}`).catch(() => null),
          fsp.readFile(`/proc/${p}/cmdline`, 'utf8').catch(() => ''),
          fsp.readlink(`/proc/${p}/cwd`).catch(() => ''),
          fsp.readlink(`/proc/${p}/exe`).catch(() => ''),
        ]);
        o.uid = s ? s.uid : null;
        o.argv = cmd.split('\0').filter(Boolean);
        o.cwd = cwd; o.exe = exe.replace(/ \(deleted\)$/, '');
      }
      out.push(o);
    } catch (e) { /* process exited mid-read */ }
  }));
  return out;
}

// Which process holds which sqlite file open (readlink every fd). 60 s cache: it is the one
// /proc walk that touches thousands of entries.
const openDbFiles = swr(60000, async () => {
  const procs = await readProcs(false);
  const map = {};
  await Promise.all(procs.filter((p) => !p.kthread).map(async (p) => {
    let fds;
    try { fds = await fsp.readdir(`/proc/${p.pid}/fd`); } catch (e) { return; }
    if (fds.length > 30000) return;
    await Promise.all(fds.map(async (fd) => {
      try {
        const t = await fsp.readlink(`/proc/${p.pid}/fd/${fd}`);
        if (/\.(db|sqlite3?)$/.test(t)) (map[t] = map[t] || []).includes(p.pid) || map[t].push(p.pid);
      } catch (e) { /* fd closed */ }
    }));
  }));
  return map;
}, {}, 3000);

function passwd() {
  const users = {};
  try {
    for (const l of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const c = l.split(':'); if (c.length < 7) continue;
      users[c[2]] = { name: c[0], uid: +c[2], home: c[5], shell: c[6] };
    }
  } catch (e) { /* no passwd */ }
  return users;
}

function procLabel(p) {
  const a = p.argv || [];
  if (!a.length) return p.comm;
  const exe = path.basename(a[0]);
  if (/^(node|nodejs|python\d?(\.\d+)?|bash|sh|dash|perl|ruby|php[\d.]*|java|deno|bun)$/.test(exe)) {
    const script = a.slice(1).find((x) => !x.startsWith('-'));
    TOKENISH.lastIndex = 0;
    if (script && script.length < 140 && !TOKENISH.test(script)) { TOKENISH.lastIndex = 0; return exe + ' ' + path.basename(script); }
    TOKENISH.lastIndex = 0;
  }
  if (/^(sshd|postgres|nginx|php-fpm)/.test(p.comm) && a[0] && !a[0].startsWith('/')) return mask(a.join(' ')).slice(0, 48);
  return p.comm;
}

// ---------------------------------------------------------------- host metrics
async function cpuTimes() {
  const out = {};
  for (const l of (await readText('/proc/stat')).split('\n')) {
    if (!l.startsWith('cpu')) continue;
    const c = l.trim().split(/\s+/); const v = c.slice(1).map(Number);
    const idle = (v[3] || 0) + (v[4] || 0);
    out[c[0]] = { total: v.slice(0, 8).reduce((a, b) => a + b, 0), idle };
  }
  return out;
}
async function memInfo() {
  const m = {};
  for (const l of (await readText('/proc/meminfo')).split('\n')) { const x = l.match(/^(\w+):\s+(\d+)/); if (x) m[x[1]] = +x[2] * 1024; }
  return { total: m.MemTotal || 0, avail: m.MemAvailable || 0, swapTotal: m.SwapTotal || 0, swapFree: m.SwapFree || 0, cached: m.Cached || 0 };
}
async function netDev() {
  const out = {};
  for (const l of (await readText('/proc/net/dev')).split('\n').slice(2)) {
    const m = l.match(/^\s*([^:]+):\s*(.*)$/); if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    out[m[1]] = { rx: v[0], tx: v[8] };
  }
  return out;
}
async function diskStats() {
  const out = {};
  for (const l of (await readText('/proc/diskstats')).split('\n')) {
    const c = l.trim().split(/\s+/); if (c.length < 10) continue;
    if (!/^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|md\d+)$/.test(c[2])) continue;
    out[c[2]] = { r: +c[5] * 512, w: +c[9] * 512 };
  }
  return out;
}
function osRelease() {
  try { const m = fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)/m); return m ? m[1] : os.type(); } catch (e) { return os.type(); }
}
function ownIps() {
  const s = new Set(['127.0.0.1', '::1', '0.0.0.0', '::', '*']);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) s.add(a.address);
  return s;
}

// ---------------------------------------------------------------- sockets
function splitAddr(a) {
  const i = a.lastIndexOf(':');
  let host = a.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (host.startsWith('::ffff:')) host = host.slice(7);
  return { host, port: +a.slice(i + 1) };
}
async function listening() {
  const out = await run('ss', ['-Hltunp']);
  const ports = new Map();
  for (const line of out.split('\n')) {
    const c = line.trim().split(/\s+/); if (c.length < 6) continue;
    const proto = c[0]; const l = splitAddr(c[4]);
    const key = proto + ':' + l.port;
    let e = ports.get(key);
    if (!e) ports.set(key, (e = { proto, port: l.port, addrs: new Set(), pids: new Set(), names: new Set() }));
    e.addrs.add(l.host);
    for (const m of line.matchAll(/\("([^"]*)",pid=(\d+)/g)) { e.pids.add(+m[2]); e.names.add(m[1]); }
  }
  return ports;
}
async function tcpConns() {
  const out = await run('ss', ['-Htinp', 'state', 'established']);
  const conns = []; let cur = null;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    if (/^\s/.test(line)) {
      if (cur) {
        const bs = line.match(/bytes_sent:(\d+)/); const br = line.match(/bytes_received:(\d+)/); const rt = line.match(/\brtt:([\d.]+)/);
        cur.tx = bs ? +bs[1] : 0; cur.rx = br ? +br[1] : 0; cur.rtt = rt ? +rt[1] : null;
      }
      continue;
    }
    const c = line.trim().split(/\s+/);
    if (c.length < 4) { cur = null; continue; }
    const pm = line.match(/pid=(\d+)/);
    cur = { l: splitAddr(c[2]), r: splitAddr(c[3]), pid: pm ? +pm[1] : null, tx: 0, rx: 0, rtt: null, key: c[2] + '>' + c[3] };
    conns.push(cur);
  }
  return conns;
}

// One TCP socket -> the graph link it animates. Shared by graph() and pulse() so ids match.
function classify(c, ctx) {
  const remoteLocal = ctx.own.has(c.r.host) || c.r.host.startsWith('127.');
  const inbound = ctx.listenTcp.has(c.l.port);
  if (c.pid != null && ctx.hidden && ctx.hidden.has(c.pid)) return null;
  const me = c.pid != null ? ctx.pidNode(c.pid) : null;
  if (remoteLocal) {
    if (inbound || !ctx.listenTcp.has(c.r.port) || !me) return null; // server end: counted from the client end
    return { a: me, b: 'port:tcp:' + c.r.port, k: 'i' };
  }
  if (!on('tcp')) return null;
  if (inbound) return { a: 'port:tcp:' + c.l.port, b: 'peer:' + ipKey(c.r.host), ip: c.r.host, k: 'n', dir: 'in', port: c.l.port };
  if (me) return { a: me, b: 'peer:' + ipKey(c.r.host), ip: c.r.host, k: 'n', dir: 'out', port: c.r.port };
  return null;
}

// ---------------------------------------------------------------- pm2 / systemd / docker
async function pm2List() {
  if (!which('pm2')) return [];
  const out = await run('pm2', ['jlist'], 10000);
  try {
    // pm2 may print "[PM2] …" notices before the JSON line
    const line = out.split('\n').find((l) => /^\[\s*(\{|\])/.test(l.trim())) || '[]';
    return JSON.parse(line).map((p) => ({
      name: p.name, pid: p.pid || 0, status: p.pm2_env ? p.pm2_env.status : '?',
      restarts: p.pm2_env ? p.pm2_env.restart_time : 0, uptime: p.pm2_env ? p.pm2_env.pm_uptime : 0,
      cwd: p.pm2_env ? p.pm2_env.pm_cwd : '', script: p.pm2_env ? p.pm2_env.pm_exec_path : '',
      interp: p.pm2_env ? p.pm2_env.exec_interpreter : '', mode: p.pm2_env ? p.pm2_env.exec_mode : '',
      version: p.pm2_env ? p.pm2_env.version : '',
    }));
  } catch (e) { return []; }
}

function showBlocks(txt) {
  return txt.split(/\n\s*\n/).map((b) => {
    const o = {};
    for (const l of b.split('\n')) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); }
    return o;
  }).filter((o) => o.Id);
}
const systemdUnits = swr(30000, async () => {
  if (!which('systemctl')) return { units: [], timers: [] };
  const list = (await run('systemctl', ['list-units', '--type=service,timer', '--all', '--no-legend', '--plain', '--no-pager']))
    .split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((u) => /\.(service|timer)$/.test(u || ''));
  const units = []; const timers = [];
  for (let i = 0; i < list.length; i += 120) {
    const out = await run('systemctl', ['show', '--no-pager', '-p',
      'Id,MainPID,ActiveState,SubState,Description,MemoryCurrent,NRestarts,Unit,NextElapseUSecRealtime,LastTriggerUSec,UnitFileState',
      ...list.slice(i, i + 120)]);
    for (const b of showBlocks(out)) (b.Id.endsWith('.timer') ? timers : units).push(b);
  }
  return { units, timers };
}, { units: [], timers: [] });

const dockerInfo = swr(30000, async () => {
  if (!which('docker')) return [];
  const out = await run('docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}'], 10000);
  const list = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).slice(0, 300);
  if (!list.length) return [];
  const ins = await run('docker', ['inspect', '--format', '{{.Id}}\t{{.State.Pid}}\t{{.RestartCount}}\t{{.Config.Image}}', ...list.map((c) => c.ID)], 15000);
  const extra = {};
  for (const l of ins.split('\n')) { const c = l.split('\t'); if (c.length >= 3) extra[c[0]] = { pid: +c[1] || 0, restarts: +c[2] || 0 }; }
  return list.map((c) => ({
    id: c.ID, name: String(c.Names || c.ID.slice(0, 12)).split(',')[0], image: c.Image, state: c.State, status: c.Status,
    ports: c.Ports || '', pid: (extra[c.ID] || {}).pid || 0, restarts: (extra[c.ID] || {}).restarts || 0,
  }));
}, [], 6000);

// ---------------------------------------------------------------- nginx / TLS
const nginxConf = swr(60000, async () => {
  if (!which('nginx')) return { servers: [], upstreams: {} };
  const txt = await run('nginx', ['-T'], 10000);
  const servers = []; const upstreams = {};
  let depth = 0; let file = ''; let cur = null; let curDepth = -1; let up = null; let upDepth = -1; let streamDepth = -1;
  for (const raw of txt.split('\n')) {
    const fm = raw.match(/^# configuration file (.+):$/);
    if (fm) { file = fm[1]; continue; }
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const opens = (line.match(/\{/g) || []).length; const closes = (line.match(/\}/g) || []).length;
    if (/^stream\s*\{/.test(line)) streamDepth = depth;
    if (!cur && /^server\s*\{/.test(line)) { cur = { file, names: [], listen: [], proxies: [], roots: [], certs: [], stream: streamDepth >= 0 }; curDepth = depth; }
    const um = line.match(/^upstream\s+(\S+)\s*\{/);
    if (um) { up = { name: um[1], targets: [] }; upDepth = depth; }
    for (const part of line.split(';')) {
      const s = part.replace(/[{}]/g, ' ').trim(); if (!s) continue;
      const w = s.split(/\s+/);
      if (up && w[0] === 'server' && w[1]) up.targets.push(w[1]);
      if (!cur) continue;
      if (w[0] === 'server_name') cur.names.push(...w.slice(1));
      else if (w[0] === 'listen') { const pm = (w[1] || '').match(/(\d+)$/); if (pm) cur.listen.push(+pm[1] + (w.includes('udp') ? '/udp' : (w.includes('ssl') ? '/ssl' : ''))); }
      else if (/^(proxy|grpc|uwsgi|fastcgi)_pass$/.test(w[0])) cur.proxies.push(w[1]);
      else if (w[0] === 'root' || w[0] === 'alias') cur.roots.push(w[1]);
      else if (w[0] === 'ssl_certificate') cur.certs.push(w[1]);
    }
    depth += opens - closes;
    if (cur && depth <= curDepth) { servers.push(cur); cur = null; }
    if (up && depth <= upDepth) { upstreams[up.name] = up.targets; up = null; }
    if (streamDepth >= 0 && depth <= streamDepth) streamDepth = -1;
  }
  return { servers, upstreams };
}, { servers: [], upstreams: {} });

function proxyTargets(p, upstreams) {
  const s = String(p || '').replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/\$.*$/, '');
  if (upstreams[s]) return upstreams[s].map((t) => proxyTargets(t, {})[0]).filter(Boolean);
  const m = s.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
  if (m) return [{ host: m[1].replace(/^\[|\]$/g, ''), port: +m[2] }];
  if (s.startsWith('unix:')) return [{ unix: s.slice(5) }];
  return s ? [{ host: s, port: 80 }] : [];
}

const certs = swr(600000, async () => {
  const dir = '/etc/letsencrypt/live';
  const out = [];
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    try {
      const x = new crypto.X509Certificate(await fsp.readFile(path.join(dir, name, 'cert.pem')));
      const san = String(x.subjectAltName || '').split(',').map((s) => s.trim().replace(/^DNS:/, '')).filter(Boolean);
      out.push({ name, san, validTo: Date.parse(x.validTo), issuer: (x.issuer.match(/O=([^\n]+)/) || [])[1] || '' });
    } catch (e) { /* not a cert dir */ }
  }
  return out;
}, []);

// ---------------------------------------------------------------- databases
// As root, psql runs as the postgres OS user (peer auth). Otherwise it uses the caller's own
// PG* environment / ~/.pgpass.
const psql = (db, sql) => (isRoot() && which('runuser')
  ? run('runuser', ['-u', 'postgres', '--', 'psql', '-AtX', '-F', '\t', '-d', db, '-c', sql], 8000)
  : run('psql', ['-AtX', '-F', '\t', '-d', db, '-c', sql], 8000));
const pgInfo = swr(120000, async () => {
  if (!which('psql')) return { dbs: [], version: '', clients: [] };
  const dbs = (await psql('postgres', `select d.datname, pg_database_size(d.datname),
      (select count(*) from pg_stat_activity a where a.datname = d.datname)
      from pg_database d where not d.datistemplate order by 2 desc`))
    .split('\n').filter(Boolean).map((l) => { const c = l.split('\t'); return { name: c[0], size: +c[1], conns: +c[2], tables: [] }; });
  for (const d of dbs.slice(0, 12)) {
    d.tables = (await psql(d.name, `select n.nspname, c.relname, greatest(c.reltuples,0)::bigint, pg_total_relation_size(c.oid)
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r','p','m') and n.nspname not in ('pg_catalog','information_schema')
          and n.nspname not like 'pg_toast%' order by 4 desc limit 300`))
      .split('\n').filter(Boolean).map((l) => { const c = l.split('\t'); return { schema: c[0], name: c[1], rows: +c[2], size: +c[3] }; });
  }
  const version = (await psql('postgres', 'show server_version')).trim();
  const clients = (await psql('postgres', `select coalesce(datname,''), coalesce(nullif(application_name,''),'?'), state, count(*)
      from pg_stat_activity where backend_type = 'client backend' group by 1,2,3`))
    .split('\n').filter(Boolean).map((l) => { const c = l.split('\t'); return { db: c[0], app: c[1], state: c[2], n: +c[3] }; });
  return { dbs, version, clients };
}, { dbs: [], version: '', clients: [] }, 5000);

// MySQL / MariaDB through the local socket (root is usually allowed by auth_socket).
const mysqlInfo = swr(120000, async () => {
  if (!which('mysql')) return { dbs: [] };
  const q = (sql) => run('mysql', ['-N', '-B', '-e', sql], 8000);
  const rows = (await q(`select table_schema, table_name, coalesce(table_rows,0), coalesce(data_length,0)+coalesce(index_length,0)
      from information_schema.tables where table_schema not in ('mysql','information_schema','performance_schema','sys')
      order by 4 desc limit 800`)).split('\n').filter(Boolean).map((l) => l.split('\t'));
  const dbs = new Map();
  for (const name of (await q('show databases')).split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (!/^(mysql|information_schema|performance_schema|sys)$/.test(name)) dbs.set(name, { name, size: 0, tables: [] });
  }
  for (const [schema, name, n, size] of rows) {
    const d = dbs.get(schema) || dbs.set(schema, { name: schema, size: 0, tables: [] }).get(schema);
    d.size += +size; if (d.tables.length < 300) d.tables.push({ name, rows: +n, size: +size });
  }
  return { dbs: [...dbs.values()], version: (await q('select version()')).trim() };
}, { dbs: [] }, 5000);

function normSeg(s) {
  if (/^\d+$/.test(s) || /^[0-9a-f]{8,}$/i.test(s) || /^[0-9a-f-]{32,}$/i.test(s)) return '#';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s) || (/^[0-9a-f:]{6,}$/i.test(s) && s.includes(':'))) return '<ip>';
  if (s.length > 28) return '*';
  return s.replace(/\d+$/, '#');
}
const redisCli = (args, t) => run('redis-cli', [...OPT.redisArgs, ...args], t);
const redisKeys = swr(60000, async () => {
  if (!which('redis-cli')) return { dbs: [] };
  const info = await redisCli(['info'], 5000);
  if (!/redis_version/.test(info)) return { dbs: [] };
  const kv = {};
  for (const l of info.split('\n')) { const i = l.indexOf(':'); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1).trim(); }
  const dbs = [];
  for (const [k, v] of Object.entries(kv)) {
    const m = k.match(/^db(\d+)$/); if (!m) continue;
    const keys = +(v.match(/keys=(\d+)/) || [])[1] || 0;
    const ns = {};
    // key NAMES only, bucketed into patterns; values are never read
    const out = await redisCli(['-n', m[1], '--scan'], 20000);
    for (const key of out.split('\n')) {
      if (!key) continue;
      const seg = key.split(':');
      const a = normSeg(seg[0]); const b = seg.length > 1 ? normSeg(seg[1]) : null;
      const e = ns[a] || (ns[a] = { n: 0, sub: {} });
      e.n++;
      if (b) e.sub[b] = (e.sub[b] || 0) + 1;
    }
    dbs.push({ db: +m[1], keys, expires: +(v.match(/expires=(\d+)/) || [])[1] || 0, ns });
  }
  return {
    dbs, port: +kv.tcp_port || 6379,
    version: kv.redis_version, mem: kv.used_memory_human, peak: kv.used_memory_peak_human,
    clients: +kv.connected_clients || 0, ops: +kv.instantaneous_ops_per_sec || 0,
  };
}, { dbs: [] }, 8000);

const sqliteFiles = swr(600000, async () => {
  const roots = ['/opt', '/root', '/var/lib', '/srv', '/home', '/var/www'].filter((r) => fs.existsSync(r));
  if (!roots.length) return [];
  const out = await run('find', [...roots, '-xdev',
    '(', '-name', '*.db', '-o', '-name', '*.sqlite', '-o', '-name', '*.sqlite3', ')', '-size', '+1k',
    '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.cache/*', '-printf', '%p\t%s\n'], 30000);
  return out.split('\n').filter(Boolean).map((l) => { const c = l.split('\t'); return { path: c[0], size: +c[1] }; }).slice(0, 200);
}, [], 4000);

const sqliteTables = new Map(); // path -> { at, tables }
async function tablesOf(file) {
  const c = sqliteTables.get(file);
  if (c && Date.now() - c.at < 300000) return c.tables;
  if (!which('sqlite3')) return [];
  const list = (await run('sqlite3', ['-readonly', '-cmd', '.timeout 800', file,
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name"], 4000))
    .split('\n').map((s) => s.trim()).filter((s) => /^[\w$]+$/.test(s)).slice(0, 80);
  let tables = list.map((name) => ({ name, rows: null }));
  if (list.length) {
    const sql = list.map((t) => `select '${t}', count(*) from "${t}"`).join(' union all ');
    const cnt = await run('sqlite3', ['-readonly', '-separator', '\t', '-cmd', '.timeout 800', file, sql], 6000);
    const rows = {};
    for (const l of cnt.split('\n')) { const x = l.split('\t'); if (x.length === 2) rows[x[0]] = +x[1]; }
    tables = list.map((name) => ({ name, rows: rows[name] != null ? rows[name] : null }));
  }
  sqliteTables.set(file, { at: Date.now(), tables });
  return tables;
}

// ---------------------------------------------------------------- filesystem / packages / cron
const dirTree = swr(900000, async () => {
  const all = [];
  await Promise.all(OPT.fsRoots.map(async ([root, depth]) => {
    if (!fs.existsSync(root)) return;
    const out = await run('nice', ['-n', '15', 'du', '-x', '-k', `--max-depth=${depth}`, root], 120000);
    const rows = [];
    for (const l of out.split('\n')) {
      const i = l.indexOf('\t'); if (i < 0) continue;
      const p = l.slice(i + 1);
      if (/\/node_modules\/|\/\.git\/|\/\.cache\/|\/\.npm\//.test(p + '/') && !/\/(node_modules|\.git|\.cache|\.npm)$/.test(p)) continue;
      rows.push({ path: p, kb: +l.slice(0, i) });
    }
    rows.sort((a, b) => b.kb - a.kb);
    const keep = new Set(rows.slice(0, depth >= 3 ? 900 : 350).map((r) => r.path));
    for (const r of rows) if (keep.has(r.path)) all.push(r);
  }));
  return all;
}, [], 5000);

const packages = swr(1800000, async () => {
  if (which('dpkg-query')) {
    const out = await run('dpkg-query', ['-W', '-f', '${Package}\t${Installed-Size}\t${Section}\t${Version}\t${db:Status-Abbrev}\n'], 15000);
    return out.split('\n').filter(Boolean).map((l) => { const c = l.split('\t'); return { name: c[0], kb: +c[1] || 0, sec: (c[2] || 'misc').split('/').pop() || 'misc', ver: c[3], st: (c[4] || '').trim() }; })
      .filter((p) => p.st.startsWith('ii'));
  }
  if (which('rpm')) {
    const out = await run('rpm', ['-qa', '--qf', '%{NAME}\t%{SIZE}\t%{GROUP}\t%{VERSION}\n'], 15000);
    return out.split('\n').filter(Boolean).map((l) => { const c = l.split('\t'); return { name: c[0], kb: Math.round((+c[1] || 0) / 1024), sec: (c[2] || 'misc').split('/').pop().toLowerCase() || 'misc', ver: c[3] }; });
  }
  return [];
}, [], 5000);

const cronJobs = swr(300000, async () => {
  const jobs = [];
  let me = 'root';
  try { me = os.userInfo().username || me; } catch (e) { /* uid without a passwd entry */ }
  const parse = (txt, file, hasUser) => {
    txt.split('\n').forEach((raw, i) => {
      const l = raw.trim();
      if (!l || l.startsWith('#') || /^[A-Za-z_]+=/.test(l)) return;
      const w = l.split(/\s+/);
      let sched; let rest;
      if (w[0].startsWith('@')) { sched = w[0]; rest = w.slice(1); } else { sched = w.slice(0, 5).join(' '); rest = w.slice(5); }
      const user = hasUser ? rest.shift() : me;
      const cmd = rest.join(' ');
      if (!cmd) return;
      jobs.push({ id: file + '#' + (i + 1), file, sched, user, cmd: mask(cmd) });
    });
  };
  if (which('crontab')) parse(await run('crontab', ['-l']), 'crontab(' + me + ')', false);
  parse(await readText('/etc/crontab'), '/etc/crontab', true);
  for (const f of await fsp.readdir('/etc/cron.d').catch(() => [])) parse(await readText('/etc/cron.d/' + f), '/etc/cron.d/' + f, true);
  for (const per of ['hourly', 'daily', 'weekly', 'monthly']) {
    for (const f of await fsp.readdir('/etc/cron.' + per).catch(() => [])) {
      if (f.startsWith('.')) continue;
      jobs.push({ id: `/etc/cron.${per}/${f}`, file: `/etc/cron.${per}`, sched: '@' + per, user: 'root', cmd: `/etc/cron.${per}/${f}` });
    }
  }
  return jobs.slice(0, 200);
}, []);

// ---------------------------------------------------------------- security
const f2bStatus = swr(60000, async () => {
  if (!which('fail2ban-client')) return [];
  const m = (await run('fail2ban-client', ['status'])).match(/Jail list:\s*(.*)/);
  const jails = [];
  for (const j of (m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [])) {
    const s = await run('fail2ban-client', ['status', j]);
    const g = (re) => { const x = s.match(re); return x ? x[1].trim() : ''; };
    jails.push({ name: j, now: +g(/Currently banned:\s*(\d+)/) || 0, total: +g(/Total banned:\s*(\d+)/) || 0,
      failed: +g(/Currently failed:\s*(\d+)/) || 0, ips: g(/Banned IP list:\s*(.*)/).split(/\s+/).filter(Boolean) });
  }
  return jails;
}, [], 5000);

const ufwStatus = swr(120000, async () => {
  if (!which('ufw')) return { present: false, active: false, allow: [], deny: 0 };
  const out = await run('ufw', ['status']);
  const allow = []; let deny = 0; const active = /Status: active/.test(out);
  for (const l of out.split('\n')) {
    const m = l.match(/^(\S+(?: \(v6\))?)\s+(ALLOW|DENY|REJECT|LIMIT)(?: IN)?\s+(.+?)\s*(#.*)?$/);
    if (!m) continue;
    if (m[2] === 'ALLOW' || m[2] === 'LIMIT') allow.push({ to: m[1].replace(' (v6)', ''), from: m[3], note: m[4] ? m[4].slice(1).trim() : '' });
    else deny++;
  }
  return { present: !!out, active, allow, deny };
}, { present: false, active: false, allow: [], deny: 0 });

function ufwPorts(to) {
  // "22/tcp", "80,443/tcp", "6000:6010/udp", "Nginx Full", "8080"
  const m = String(to).match(/^([\d,:]+)(?:\/(tcp|udp))?$/);
  if (!m) return [];
  const out = [];
  for (const part of m[1].split(',')) {
    const [a, b] = part.split(':').map(Number);
    for (let p = a; p <= (b || a) && p - a < 64; p++) for (const pr of (m[2] ? [m[2]] : ['tcp', 'udp'])) out.push(pr + ':' + p);
  }
  return out;
}

// ---------------------------------------------------------------- graph
let CTX = null;        // last build: pid -> node id, listening tcp ports, own ips (pulse reuses it)
let GRAPH = null;      // { at, json, gz, count }
let building = null;

const fmtBytes = (b) => { b = Number(b) || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return (i ? b.toFixed(b < 10 ? 1 : 0) : b) + ' ' + u[i]; };
const lg = (x) => Math.log2(1 + Math.max(0, x || 0));
const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

async function build() {
  const t0 = Date.now();
  const errors = [];
  const S = (name, p, empty) => Promise.resolve(p).catch((e) => { errors.push(name + ': ' + e.message); return empty; });
  const [allProcs, listen, conns, pm2, sd, dk, ngx, certList, pg, my, rk, sqFiles, dbOpen, dirs, pkgs, cron, jails, ufw, boot, mem] = await Promise.all([
    S('proc', readProcs(true), []),
    S('ports', when('ports', listening, new Map()), new Map()),
    S('tcp', tcpConns(), []),
    S('pm2', when('pm2', pm2List, []), []),
    S('systemd', when('systemd', systemdUnits, { units: [], timers: [] }), { units: [], timers: [] }),
    S('docker', when('docker', dockerInfo, []), []),
    S('nginx', when('nginx', nginxConf, { servers: [], upstreams: {} }), { servers: [], upstreams: {} }),
    S('tls', when('tls', certs, []), []),
    S('postgres', when('postgres', pgInfo, { dbs: [] }), { dbs: [] }),
    S('mysql', when('mysql', mysqlInfo, { dbs: [] }), { dbs: [] }),
    S('redis', when('redis', redisKeys, { dbs: [] }), { dbs: [] }),
    S('sqlite', when('sqlite', sqliteFiles, []), []),
    S('openfiles', when('sqlite', openDbFiles, {}), {}),
    S('fs', when('fs', dirTree, []), []),
    S('packages', when('packages', packages, []), []),
    S('cron', when('cron', cronJobs, []), []),
    S('fail2ban', when('security', f2bStatus, []), []),
    S('ufw', when('security', ufwStatus, { allow: [] }), { allow: [] }),
    bootSec(), memInfo(),
  ]);

  const hidden = hiddenPids(allProcs);
  const procs = allProcs.filter((p) => !hidden.has(p.pid));
  for (const [key, e] of [...listen]) if ([...e.pids].some((p) => hidden.has(p))) listen.delete(key);

  const N = new Map(); const L = new Map();
  const node = (id, l, g, t, s, m, p, st) => {
    let n = N.get(id);
    if (!n) { n = { id, l: String(l), g, t, s: +(s || 1).toFixed(2) }; if (p) n.p = p; if (m) n.m = m; if (st) n.st = st; N.set(id, n); }
    return n;
  };
  const link = (a, b, k, w) => {
    if (!a || !b || a === b) return;
    const id = a + '>' + b; const e = L.get(id);
    if (e) { e.w += w || 1; return; }
    L.set(id, { a, b, k, w: w || 1 });
  };
  const users = passwd();
  const own = ownIps();
  const pubIps = [...own].filter((ip) => !/^(127\.|::1$|0\.0\.0\.0$|::$|\*$|fe80:|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));

  // ---- host + hardware
  const cpus = os.cpus();
  node('host', os.hostname(), 'core', 'host', 18, {
    os: osRelease(), kernel: os.release(), ip: pubIps.map(ipLabel).join(' · '), cpus: cpus.length + ' × ' + (cpus[0] ? cpus[0].model.trim() : '?'),
    ram: fmtBytes(mem.total), uptime: Math.round(os.uptime() / 3600) + ' h',
  });
  node('hw', 'Hardware', 'core', 'hub', 6, null, 'host');
  node('hw:cpu', 'CPU ×' + cpus.length, 'core', 'cpu', 6, { model: cpus[0] ? cpus[0].model.trim() : '?', mhz: cpus[0] ? cpus[0].speed : 0 }, 'hw');
  cpus.forEach((c, i) => node('hw:core:' + i, 'core ' + i, 'core', 'core', 1.8, { mhz: c.speed }, 'hw:cpu'));
  node('hw:mem', 'RAM ' + fmtBytes(mem.total), 'core', 'mem', 5, { total: fmtBytes(mem.total), available: fmtBytes(mem.avail), cached: fmtBytes(mem.cached) }, 'hw');
  if (mem.swapTotal) node('hw:swap', 'Swap ' + fmtBytes(mem.swapTotal), 'core', 'mem', 2.5, { total: fmtBytes(mem.swapTotal), free: fmtBytes(mem.swapFree) }, 'hw');
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    node('hw:if:' + name, name, 'core', 'iface', name === 'lo' ? 1.6 : 3.2,
      { addresses: maskList((list || []).map((a) => a.address).join(' · ')), mac: OPT.maskIps ? '' : ((list && list[0] && list[0].mac) || '') }, 'hw');
  }
  const df = await safe(run('df', ['-PTk', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs', '-x', 'overlay', '-x', 'efivarfs']), '');
  const mounts = [];
  for (const l of df.split('\n').slice(1)) {
    const c = l.trim().split(/\s+/); if (c.length < 7) continue;
    const mp = c.slice(6).join(' '); const pct = parseInt(c[5], 10) || 0;
    mounts.push(mp);
    node('hw:mnt:' + mp, mp, 'core', 'disk', 2.5 + lg(+c[2] / 1048576) * 0.6,
      { device: c[0], fs: c[1], size: fmtBytes(+c[2] * 1024), used: fmtBytes(+c[3] * 1024), free: fmtBytes(+c[4] * 1024), use: pct + '%' },
      'hw', pct >= 90 ? 'bad' : pct >= 80 ? 'warn' : null);
  }
  const mountOf = (p) => mounts.filter((m) => p === m || p.startsWith(m === '/' ? '/' : m + '/')).sort((a, b) => b.length - a.length)[0] || '/';

  // ---- processes -> pm2 apps / containers / systemd units / plain processes
  const pidNode = new Map();
  const pm2ByPid = new Map(pm2.filter((a) => a.pid).map((a) => [a.pid, a]));
  const ctrByPid = new Map(dk.filter((c) => c.pid).map((c) => [c.pid, c]));
  const svcByPid = new Map();
  for (const u of sd.units) if (+u.MainPID > 0) svcByPid.set(+u.MainPID, u);
  const god = procs.find((p) => /^PM2 v/.test(p.comm));
  for (const p of procs) {
    if (pm2ByPid.has(p.pid)) pidNode.set(p.pid, 'pm2:' + pm2ByPid.get(p.pid).name);
    else if (god && p.pid === god.pid) pidNode.set(p.pid, 'pm2:daemon');
    else if (ctrByPid.has(p.pid)) pidNode.set(p.pid, 'ctr:' + ctrByPid.get(p.pid).name);
    else if (svcByPid.has(p.pid)) pidNode.set(p.pid, 'svc:' + svcByPid.get(p.pid).Id);
    else pidNode.set(p.pid, 'proc:' + p.pid);
  }
  const idOfPid = (pid) => pidNode.get(pid) || null;
  const procById = new Map(procs.map((p) => [p.pid, p]));
  for (const p of procs) {
    const id = pidNode.get(p.pid);
    const parent = p.pid === 1 || p.pid === 2 ? 'host' : (pidNode.get(p.ppid) || 'host');
    const user = p.uid != null && users[p.uid] ? users[p.uid].name : (p.uid != null ? String(p.uid) : '');
    const base = {
      pid: p.pid, user, threads: p.threads, rss: fmtBytes(p.rss),
      started: boot ? stamp((boot + p.start / HZ) * 1000) : '',
    };
    if (p.exe) base.exe = p.exe;
    if (p.cwd && p.cwd !== '/') base.cwd = p.cwd;
    const mb = p.rss / 1048576;
    if (id.startsWith('pm2:') && id !== 'pm2:daemon') {
      const a = pm2ByPid.get(p.pid);
      node(id, a.name, 'pm2', 'pm2', 3.2 + lg(mb) * 0.55, Object.assign(base, {
        status: a.status, restarts: a.restarts, uptime: a.uptime ? stamp(a.uptime) : '',
        script: a.script, interpreter: a.interp, mode: a.mode, app: a.version || undefined,
      }), parent, a.status === 'online' ? null : 'bad');
    } else if (id === 'pm2:daemon') {
      node(id, 'PM2 daemon', 'pm2', 'hub', 7, Object.assign(base, { apps: pm2.length, online: pm2.filter((a) => a.status === 'online').length }), parent);
    } else if (id.startsWith('ctr:')) {
      const c = ctrByPid.get(p.pid);
      node(id, '🐳 ' + c.name, 'docker', 'ctr', 3 + lg(mb) * 0.5, Object.assign(base, {
        image: c.image, state: c.state, status: c.status, ports: c.ports || '—', restarts: c.restarts, container: c.id.slice(0, 12),
      }), parent);
    } else if (id.startsWith('svc:')) {
      const u = svcByPid.get(p.pid);
      node(id, u.Id.replace(/\.service$/, ''), 'svc', 'svc', 2.2 + lg(mb) * 0.45, Object.assign(base, {
        unit: u.Id, description: u.Description, state: u.ActiveState + '/' + u.SubState, restarts: u.NRestarts,
        memory: +u.MemoryCurrent > 0 && +u.MemoryCurrent < 1e15 ? fmtBytes(+u.MemoryCurrent) : undefined, enabled: u.UnitFileState,
      }), parent, u.ActiveState === 'failed' ? 'bad' : null);
    } else if (p.pid === 1) {
      node(id, (p.comm || 'init') + ' (PID 1)', 'svc', 'hub', 8, base, 'host');
    } else if (p.kthread) {
      node(id, p.pid === 2 ? 'kthreadd · kernel' : p.comm, 'kern', p.pid === 2 ? 'hub' : 'kthread', p.pid === 2 ? 5 : 0.7, { pid: p.pid, threads: p.threads }, parent);
    } else {
      node(id, procLabel(p), 'proc', 'proc', 1.2 + lg(mb) * 0.42, Object.assign(base, { comm: p.comm }), parent, p.state === 'Z' ? 'bad' : null);
    }
  }
  // pm2 apps that are not running have no pid: still on the map, dimmed, under the daemon.
  for (const a of pm2) {
    if (a.pid && procById.has(a.pid)) continue;
    if ((a.pid && hidden.has(a.pid)) || hiddenPath(a.cwd) || hiddenPath(a.script)) continue;
    node('pm2:' + a.name, a.name, 'pm2', 'pm2', 2.4, { status: a.status, restarts: a.restarts, script: a.script, cwd: a.cwd }, god ? 'pm2:daemon' : 'host',
      a.status === 'errored' ? 'bad' : 'off');
  }
  // stopped containers hang from the docker daemon
  const dockerd = [...N.keys()].find((k) => /^svc:docker(\.service)?$/.test(k)) || 'host';
  for (const c of dk) {
    if (c.pid && procById.has(c.pid)) continue;
    node('ctr:' + c.name, '🐳 ' + c.name, 'docker', 'ctr', 2.2, { image: c.image, state: c.state, status: c.status, container: c.id.slice(0, 12) }, dockerd,
      /restarting|dead/.test(c.state) || /Exited \([1-9]/.test(c.status) ? 'bad' : 'off');
  }
  // systemd units without a running main process (oneshots, inactive, failed)
  for (const u of sd.units) {
    const id = 'svc:' + u.Id;
    if (N.has(id) || hidden.has(+u.MainPID)) continue;
    const st = u.ActiveState === 'failed' ? 'bad' : (u.ActiveState === 'active' ? null : 'off');
    node(id, u.Id.replace(/\.service$/, ''), 'svc', 'svc', u.ActiveState === 'active' ? 1.8 : 1.2,
      { unit: u.Id, description: u.Description, state: u.ActiveState + '/' + u.SubState, enabled: u.UnitFileState }, 'proc:1', st);
  }
  for (const t of sd.timers) {
    const id = 'tmr:' + t.Id;
    node(id, t.Id.replace(/\.timer$/, '') + ' ⏱', 'sched', 'timer', 1.6,
      { timer: t.Id, triggers: t.Unit, state: t.ActiveState, next: t.NextElapseUSecRealtime, last: t.LastTriggerUSec }, 'proc:1', t.ActiveState === 'active' ? null : 'off');
    if (t.Unit) link(id, 'svc:' + t.Unit, 's');
  }

  // ---- listening ports
  const listenTcp = new Set();
  const ufwAllowed = new Set();
  for (const r of ufw.allow || []) for (const k of ufwPorts(r.to)) ufwAllowed.add(k);
  for (const [key, e] of listen) {
    if (e.proto === 'tcp') listenTcp.add(e.port);
    const pids = [...e.pids];
    const master = pids.find((p) => { const pr = procById.get(p); return !pr || !e.pids.has(pr.ppid); }) || pids[0];
    const addrs = [...e.addrs];
    const local = addrs.every((a) => a.startsWith('127.') || a === '::1');
    const id = 'port:' + key;
    node(id, ':' + e.port + (e.proto === 'udp' ? '/udp' : ''), 'port', 'port', 1.7 + Math.min(3, pids.length * 0.12), {
      proto: e.proto, port: e.port, bind: maskList(addrs.join(' · ')), exposure: local ? 'loopback only' : 'public',
      firewall: local ? '—' : (!ufw.present ? 'n/a' : ufwAllowed.has(key) ? 'ufw ALLOW' : 'not in ufw allow list'), process: [...e.names].join(', '),
    }, master ? idOfPid(master) : 'host');
    for (const p of pids.slice(0, 24)) if (p !== master) link(idOfPid(p), id, 'i');
  }

  // ---- TCP connections: internal wiring + internet peers
  const ctx = { own, listenTcp, pidNode: idOfPid, hidden };
  const peers = new Map();
  for (const c of conns) {
    const cls = classify(c, ctx);
    if (!cls) continue;
    if (cls.k === 'i') { if (!N.has(cls.b)) continue; link(cls.a, cls.b, 'i'); continue; }
    let pe = peers.get(cls.b);
    if (!pe) peers.set(cls.b, (pe = { id: cls.b, ip: cls.ip, conns: 0, tx: 0, rx: 0, rtt: [], ports: new Set(), dir: cls.dir, from: cls.a }));
    pe.conns++; pe.tx += c.tx; pe.rx += c.rx; if (c.rtt != null) pe.rtt.push(c.rtt); pe.ports.add(cls.port);
    link(cls.a, cls.b, 'n');
  }
  const banned = new Set();
  for (const j of jails) for (const ip of j.ips) banned.add(ip);
  for (const pe of [...peers.values()].sort((a, b) => b.conns - a.conns).slice(0, 2000)) {
    const rtt = pe.rtt.length ? pe.rtt.reduce((a, b) => a + b, 0) / pe.rtt.length : null;
    node(pe.id, ipLabel(pe.ip), 'net', 'peer', 1 + lg(pe.conns) * 0.7, {
      direction: pe.dir === 'in' ? 'inbound' : 'outbound', conns: pe.conns, ports: [...pe.ports].join(', '),
      sent: fmtBytes(pe.tx), received: fmtBytes(pe.rx), rtt: rtt != null ? rtt.toFixed(1) + ' ms' : '—',
    }, pe.from, banned.has(pe.ip) ? 'bad' : null);
  }

  // ---- nginx: domains, proxies, static roots, TLS
  const ngxId = [...N.keys()].find((k) => /^svc:nginx(\.service)?$/.test(k)) || 'host';
  const doms = new Map();
  for (const s of ngx.servers) {
    const names = s.names.filter((n) => n && n !== '""');
    const key = names[0] || ('stream:' + (s.listen[0] || '?'));
    let d = doms.get(key);
    if (!d) doms.set(key, (d = { names: new Set(), listen: new Set(), proxies: new Set(), roots: new Set(), files: new Set(), stream: s.stream, ssl: false }));
    names.forEach((n) => d.names.add(n)); s.listen.forEach((x) => d.listen.add(x)); s.proxies.forEach((x) => d.proxies.add(x));
    s.roots.forEach((x) => d.roots.add(x)); d.files.add(s.file); if (s.certs.length || s.listen.some((x) => /ssl/.test(x))) d.ssl = true;
  }
  const domIdByName = new Map();
  for (const [key, d] of doms) {
    const id = 'dom:' + key;
    const label = key === '_' ? 'default server (_)' : key.startsWith('stream:') ? 'stream ' + key.slice(7) : key;
    node(id, label, 'web', 'domain', 3.2, {
      names: [...d.names].join(' '), listen: [...d.listen].join(' '), tls: d.ssl ? 'yes' : 'no',
      proxy: [...d.proxies].join(' · ') || '—', config: [...d.files].map((f) => f.replace('/etc/nginx/', '')).join(' · '),
    }, ngxId);
    d.names.forEach((n) => domIdByName.set(n, id));
    for (const p of d.proxies) {
      for (const t of proxyTargets(p, ngx.upstreams)) {
        if (t.unix) continue;
        if (own.has(t.host) || t.host === 'localhost' || t.host.startsWith('127.')) {
          const pid = 'port:tcp:' + t.port;
          if (!N.has(pid)) node(pid, ':' + t.port + ' ✕', 'port', 'port', 1.6, { port: t.port, problem: 'nginx proxies here but nothing is listening' }, id, 'bad');
          link(id, pid, 'x');
        }
      }
    }
  }
  if (certList.length) node('tls', 'TLS certificates', 'web', 'hub', 4, { count: certList.length }, ngxId);
  for (const c of certList) {
    const days = Math.floor((c.validTo - Date.now()) / 86400000);
    const id = 'cert:' + c.name;
    node(id, '🔒 ' + c.name, 'web', 'cert', 1.9, { domains: c.san.join(' '), expires: new Date(c.validTo).toISOString().slice(0, 10), days_left: days, issuer: c.issuer },
      'tls', days < 7 ? 'bad' : days < 20 ? 'warn' : null);
    for (const n of c.san) if (domIdByName.has(n)) link(id, domIdByName.get(n), 'c');
  }

  // ---- postgres
  const ownerOf = (port) => {
    const o = listen.get('tcp:' + port);
    if (!o || !o.pids.size) return 'host';
    const master = [...o.pids].find((p) => { const pr = procById.get(p); return pr && !o.pids.has(pr.ppid); }) || [...o.pids][0];
    return idOfPid(master) || 'host';
  };
  const pgRoot = ownerOf(5432);
  for (const d of pg.dbs || []) {
    const id = 'pg:' + d.name;
    node(id, '🐘 ' + d.name, 'pg', 'pgdb', 3.5 + lg(d.size / 1048576) * 0.35, { size: fmtBytes(d.size), connections: d.conns, tables: d.tables.length, version: pg.version }, pgRoot);
    for (const t of d.tables) {
      const parent = t.schema === 'public' ? id : 'pgs:' + d.name + '.' + t.schema;
      if (t.schema !== 'public') node(parent, t.schema, 'pg', 'pgschema', 2, { database: d.name }, id);
      node('pgt:' + d.name + '.' + t.schema + '.' + t.name, t.name, 'pg', 'pgtable', 1 + Math.log10(1 + t.rows) * 0.5,
        { schema: t.schema, rows: t.rows, size: fmtBytes(t.size) }, parent);
    }
  }
  for (const c of pg.clients || []) {
    const pn = N.get('pg:' + c.db);
    if (pn && pn.m) pn.m['client ' + c.app + ' (' + c.state + ')'] = c.n;
  }

  // ---- mysql / mariadb
  const myRoot = ownerOf(3306);
  for (const d of my.dbs || []) {
    const id = 'my:' + d.name;
    node(id, '🐬 ' + d.name, 'mysql', 'mydb', 3.5 + lg(d.size / 1048576) * 0.35, { size: fmtBytes(d.size), tables: d.tables.length, version: my.version }, myRoot);
    for (const t of d.tables) {
      node('myt:' + d.name + '.' + t.name, t.name, 'mysql', 'mytable', 1 + Math.log10(1 + t.rows) * 0.5, { rows: t.rows, size: fmtBytes(t.size) }, id);
    }
  }

  // ---- redis
  const rRoot = ownerOf(rk.port || 6379);
  const rTop = N.get(rRoot);
  if (rTop && rk.version) Object.assign(rTop.m = rTop.m || {}, { redis: rk.version, memory: rk.mem, peak: rk.peak, clients: rk.clients, 'ops/s': rk.ops });
  for (const d of rk.dbs || []) {
    const id = 'rdb:' + d.db;
    node(id, 'redis db' + d.db, 'redis', 'redisdb', 3 + Math.log10(1 + d.keys) * 0.9, { keys: d.keys, expiring: d.expires }, rRoot);
    const nss = Object.entries(d.ns).sort((a, b) => b[1].n - a[1].n).slice(0, 150);
    for (const [a, e] of nss) {
      const nid = 'rk:' + d.db + ':' + a;
      node(nid, a + (Object.keys(e.sub).length ? ':*' : ''), 'redis', 'redisns', 1 + Math.log10(1 + e.n) * 0.9, { pattern: a + (Object.keys(e.sub).length ? ':…' : ''), keys: e.n }, id);
      const subs = Object.entries(e.sub).sort((x, y) => y[1] - x[1]);
      for (const [b, n] of subs.slice(0, 50)) {
        node(nid + ':' + b, a + ':' + b, 'redis', 'redisns', 0.9 + Math.log10(1 + n) * 0.8, { pattern: a + ':' + b + (n > 1 ? ':…' : ''), keys: n }, nid);
      }
      if (subs.length > 50) node(nid + ':…', '+' + (subs.length - 50) + ' more', 'redis', 'redisns', 1, { patterns: subs.length - 50 }, nid);
    }
  }

  // ---- filesystem tree
  const dirId = (p) => 'dir:' + p;
  if (dirs.length) node(dirId('/'), '/', 'fs', 'dir', 4, { mount: '/' }, 'hw:mnt:/');
  const shownDirs = dirs.filter((d) => !hiddenPath(d.path));
  const dirSet = new Set(shownDirs.map((d) => d.path));
  for (const d of shownDirs) {
    const isTop = OPT.fsRoots.some(([r]) => r === d.path);
    let parent = path.dirname(d.path);
    if (isTop) parent = mounts.includes(d.path) ? null : '/';
    const pid = parent == null ? 'hw:mnt:' + d.path : (dirSet.has(parent) || parent === '/' ? dirId(parent) : dirId('/'));
    const mb = d.kb / 1024;
    node(dirId(d.path), isTop ? d.path : path.basename(d.path), 'fs', 'dir', 0.7 + Math.log10(1 + mb) * 0.75, { path: d.path, size: fmtBytes(d.kb * 1024), mount: mountOf(d.path) }, pid,
      /backup|bak_|\.bak/i.test(d.path) ? 'off' : null);
  }
  const nearestDir = (p) => {
    let cur = p;
    for (let i = 0; i < 12 && cur && cur !== '/'; i++) { if (dirSet.has(cur)) return dirId(cur); cur = path.dirname(cur); }
    return null;
  };
  for (const p of procs) {
    if (!p.cwd || p.cwd === '/' || p.kthread) continue;
    const d = nearestDir(p.cwd); if (d) link(idOfPid(p.pid), d, 'f');
  }
  for (const a of pm2) { const d = nearestDir(a.cwd); if (d) link('pm2:' + a.name, d, 'f'); }
  for (const [key, d] of doms) for (const r of d.roots) { const x = nearestDir(r); if (x) link('dom:' + key, x, 'f'); }

  // ---- sqlite databases (+ tables for the ones a process has open)
  const live = (f) => !!dbOpen[f.path];
  const liveFiles = sqFiles.filter((f) => live(f) && !hiddenPath(f.path)).slice(0, 14);
  const tableLists = await Promise.all(liveFiles.map((f) => safe(tablesOf(f.path), [])));
  const tablesByPath = new Map(liveFiles.map((f, i) => [f.path, tableLists[i]]));
  for (const f of sqFiles) {
    if (hiddenPath(f.path)) continue;
    const id = 'sq:' + f.path;
    node(id, '🗄 ' + path.basename(path.dirname(f.path)) + '/' + path.basename(f.path), 'sqlite', 'sqlite', 1.6 + lg(f.size / 1048576) * 0.45,
      { path: f.path, size: fmtBytes(f.size), open_by: (dbOpen[f.path] || []).map((p) => { const n = N.get(idOfPid(p)); return n ? n.l : p; }).join(', ') || '—' },
      nearestDir(f.path) || dirId('/'), live(f) ? null : 'off');
    for (const pid of dbOpen[f.path] || []) link(idOfPid(pid), id, 'f');
    for (const t of tablesByPath.get(f.path) || []) {
      node('sqt:' + f.path + ':' + t.name, t.name, 'sqlite', 'sqtable', 0.9 + Math.log10(1 + (t.rows || 0)) * 0.5, { rows: t.rows == null ? '?' : t.rows, db: f.path }, id);
    }
  }

  // ---- scheduler (cron)
  const cronId = N.has('svc:cron.service') ? 'svc:cron.service' : N.has('svc:crond.service') ? 'svc:crond.service' : 'proc:1';
  for (const j of cron) {
    if (OPT.hidePaths.some((h) => j.cmd.includes(h))) continue;
    const first = (j.cmd.match(/(\/[\w.\-/]+)/) || [])[1] || '';
    const label = first ? path.basename(first) : j.cmd.split(/\s+/)[0];
    const id = 'cron:' + j.id;
    node(id, '⏰ ' + label, 'sched', 'cron', 1.7, { schedule: j.sched, user: j.user, file: j.file, command: j.cmd }, cronId);
    const d = first ? nearestDir(first) : null; if (d) link(id, d, 'f');
  }

  // ---- security
  if (on('security')) {
    node('sec', 'Security', 'sec', 'hub', 5, { fail2ban_jails: jails.length, ufw_rules: (ufw.allow || []).length + (ufw.deny || 0) }, 'host');
    if (ufw.present) {
      node('ufw', 'UFW firewall', 'sec', 'ufw', 3.2, { status: ufw.active ? 'active' : 'inactive', allow: (ufw.allow || []).length, 'deny/reject': ufw.deny || 0 }, 'sec', ufw.active ? null : 'warn');
      for (const r of ufw.allow || []) for (const k of ufwPorts(r.to)) if (N.has('port:' + k)) link('ufw', 'port:' + k, 's');
    }
    const f2bId = N.has('svc:fail2ban.service') ? 'svc:fail2ban.service' : 'sec';
    if (f2bId !== 'sec') link('sec', f2bId, 's');
    for (const j of jails) {
      const jid = 'jail:' + j.name;
      node(jid, 'jail ' + j.name, 'sec', 'jail', 2.4 + lg(j.now) * 0.3, { banned_now: j.now, banned_total: j.total, failing: j.failed }, f2bId);
      for (const ip of j.ips.slice(0, 300)) {
        const bid = 'ban:' + ipKey(ip);
        if (N.has(bid)) { link(jid, bid, 's'); continue; }
        node(bid, ipLabel(ip), 'sec', 'ban', 0.9, { jail: j.name }, jid);
        if (N.has('peer:' + ipKey(ip))) link(bid, 'peer:' + ipKey(ip), 'n');
      }
    }
    for (const [, u] of Object.entries(users)) {
      if (/nologin|false|sync|halt|shutdown/.test(u.shell) || (u.uid !== 0 && u.uid < 1000) || u.uid === 65534) continue;
      node('user:' + u.name, '👤 ' + u.name, 'sec', 'user', 2.4, { uid: u.uid, home: u.home, shell: u.shell }, 'sec');
    }
    const who = await safe(run('who', []), '');
    for (const l of who.split('\n')) {
      const m = l.match(/^(\S+)\s+(\S+).*\(([^)]+)\)\s*$/); if (!m) continue;
      const pid = 'peer:' + ipKey(m[3]);
      if (N.has('user:' + m[1]) && N.has(pid)) link('user:' + m[1], pid, 'n');
    }
  }

  // ---- packages
  if (pkgs.length) {
    node('pkg', 'Packages (' + pkgs.length + ')', 'pkg', 'hub', 5, { installed: pkgs.length, size: fmtBytes(pkgs.reduce((a, p) => a + p.kb, 0) * 1024) }, 'host');
    const secs = {};
    for (const p of pkgs) (secs[p.sec] = secs[p.sec] || []).push(p);
    for (const [s, list] of Object.entries(secs)) {
      node('pkgs:' + s, s, 'pkg', 'pkgsec', 1.8 + lg(list.length) * 0.3, { packages: list.length }, 'pkg');
      for (const p of list) node('pkg:' + p.name, p.name, 'pkg', 'pkg', 0.6 + Math.log10(1 + p.kb) * 0.3, { version: p.ver, size: fmtBytes(p.kb * 1024) }, 'pkgs:' + s);
    }
  }

  // ---- tie the tree together: every node hangs from its parent (missing parent -> host)
  for (const n of N.values()) {
    if (n.id === 'host') continue;
    if (!n.p || !N.has(n.p) || n.p === n.id) n.p = 'host';
    link(n.p, n.id, 't');
  }
  for (const [id, l] of L) if (!N.has(l.a) || !N.has(l.b)) L.delete(id);

  CTX = { own, listenTcp, pidNode: idOfPid, pidMap: pidNode, hidden, redis: !!rk.version };
  const layers = {};
  for (const n of N.values()) layers[n.g] = (layers[n.g] || 0) + 1;
  const nodes = [...N.values()];
  const payload = {
    ok: true, at: Date.now(), ms: Date.now() - t0, host: os.hostname(), ip: ipLabel(pubIps[0] || ''),
    root: isRoot(), layers, errors, nodes, links: [...L.values()],
  };
  const json = Buffer.from(JSON.stringify(payload));
  return { at: Date.now(), json, gz: zlib.gzipSync(json, { level: 6 }), count: nodes.length };
}

async function graph() {
  if (GRAPH && Date.now() - GRAPH.at < GRAPH_TTL) return GRAPH;
  if (!building) building = build().then((g) => { GRAPH = g; return g; }).finally(() => { building = null; });
  if (GRAPH) { building.catch(() => {}); return GRAPH; } // stale-while-revalidate after the first build
  return building;
}

// ---------------------------------------------------------------- pulse
let P = null; // previous sample
let PULSE = null;
async function pulse() {
  if (PULSE && Date.now() - PULSE.at < 1400) return PULSE;
  const now = Date.now();
  if (!CTX) { try { await graph(); } catch (e) { /* first build failed: pulse still works */ } }
  const useRedis = CTX && CTX.redis && on('redis');
  const [procs, cpu, mem, net, disk, conns, info] = await Promise.all([
    safe(readProcs(false), []), safe(cpuTimes(), {}), safe(memInfo(), {}), safe(netDev(), {}), safe(diskStats(), {}),
    safe(tcpConns(), []), useRedis ? safe(redisCli(['info', 'stats'], 2000), '') : '',
  ]);
  const dt = P ? (now - P.at) / 1000 : 0;
  const out = { at: now, dt, act: {}, traffic: {}, host: {} };
  if (P && dt > 0.2) {
    // per-node CPU (% of one core)
    for (const p of procs) {
      const prev = P.ticks.get(p.pid);
      if (prev == null) continue;
      const pct = ((p.ticks - prev) / (dt * HZ)) * 100;
      if (pct < 0.4) continue;
      if (CTX && CTX.hidden && CTX.hidden.has(p.pid)) continue;
      const id = CTX && CTX.pidMap.get(p.pid) ? CTX.pidMap.get(p.pid) : 'proc:' + p.pid;
      out.act[id] = +((out.act[id] || 0) + pct).toFixed(1);
    }
    // TCP bytes/s per graph link
    if (CTX) {
      for (const c of conns) {
        const prev = P.bytes.get(c.key);
        if (prev == null) continue;
        const r = (c.tx + c.rx - prev) / dt;
        if (r <= 0) continue;
        const cls = classify(c, CTX);
        if (!cls) continue;
        const k = cls.a + '>' + cls.b;
        out.traffic[k] = Math.round((out.traffic[k] || 0) + r);
      }
    }
    const core = [];
    for (const [k, v] of Object.entries(cpu)) {
      const pv = P.cpu[k]; if (!pv) continue;
      const dT = v.total - pv.total; const u = dT > 0 ? (1 - (v.idle - pv.idle) / dT) * 100 : 0;
      if (k === 'cpu') out.host.cpu = +u.toFixed(1); else core[+k.slice(3)] = +u.toFixed(0);
    }
    out.host.cores = core;
    let rx = 0; let tx = 0;
    for (const [k, v] of Object.entries(net)) {
      const pv = P.net[k]; if (!pv || k === 'lo') continue;
      rx += Math.max(0, (v.rx - pv.rx) / dt); tx += Math.max(0, (v.tx - pv.tx) / dt);
    }
    out.host.rx = Math.round(rx); out.host.tx = Math.round(tx);
    let dr = 0; let dw = 0;
    for (const [k, v] of Object.entries(disk)) { const pv = P.disk[k]; if (!pv) continue; dr += Math.max(0, v.r - pv.r); dw += Math.max(0, v.w - pv.w); }
    out.host.diskR = Math.round(dr / dt); out.host.diskW = Math.round(dw / dt);
  }
  const la = os.loadavg();
  Object.assign(out.host, {
    mem: mem.total ? +(((mem.total - mem.avail) / mem.total) * 100).toFixed(1) : 0, memUsed: mem.total - mem.avail, memTotal: mem.total,
    swap: mem.swapTotal ? +(((mem.swapTotal - mem.swapFree) / mem.swapTotal) * 100).toFixed(1) : 0,
    load: la.map((x) => +x.toFixed(2)), uptime: Math.round(os.uptime()), procs: procs.length, tcp: conns.length,
  });
  if (useRedis) out.host.redisOps = +((String(info).match(/instantaneous_ops_per_sec:(\d+)/) || [])[1] || 0);
  P = {
    at: now, cpu, net, disk,
    ticks: new Map(procs.map((p) => [p.pid, p.ticks])),
    bytes: new Map(conns.map((c) => [c.key, c.tx + c.rx])),
  };
  PULSE = out;
  return out;
}

module.exports = { configure, detect, graph, pulse, COLLECTORS, isRoot };
