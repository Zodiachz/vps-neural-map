/* Demo data: a made-up but realistic web server, so the map can be tried (and screenshotted)
   without exposing a real machine. Works in the browser (window.NMDemo) and in Node (--demo).
   Every address is from the documentation ranges 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.NMDemo = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function rng(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const fmtBytes = (b) => { b = +b || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return (i ? b.toFixed(b < 10 ? 1 : 0) : b) + ' ' + u[i]; };
  const lg = (x) => Math.log2(1 + Math.max(0, x || 0));
  const GB = 1024 * 1024 * 1024; const MB = 1024 * 1024;

  let CACHE = null;

  function build() {
    const R = rng(7);
    const ri = (a, b) => a + Math.floor(R() * (b - a + 1));
    const N = new Map(); const L = new Map();
    const node = (id, l, g, t, s, m, p, st) => {
      let n = N.get(id);
      if (!n) { n = { id, l: String(l), g, t, s: +(s || 1).toFixed(2) }; if (p) n.p = p; if (m) n.m = m; if (st) n.st = st; N.set(id, n); }
      return n;
    };
    const link = (a, b, k) => { if (!a || !b || a === b) return; const id = a + '>' + b; if (L.has(id)) L.get(id).w++; else L.set(id, { a, b, k, w: 1 }); };
    let pidSeq = 300;
    const pid = () => (pidSeq += ri(3, 60));
    const proc = (label, parent, mb, extra, st) => {
      const id = 'proc:' + pid();
      node(id, label, 'proc', 'proc', 1.2 + lg(mb) * 0.42, Object.assign({ pid: +id.slice(5), rss: fmtBytes(mb * MB), threads: ri(1, 12) }, extra || {}), parent, st);
      return id;
    };

    // ---- host + hardware
    node('host', 'demo-vps', 'core', 'host', 18, { os: 'Ubuntu 24.04.1 LTS', kernel: '6.8.0-45-generic', ip: '203.0.113.10', cpus: '8 × AMD EPYC 7B13', ram: '32 GB', uptime: '512 h' });
    node('hw', 'Hardware', 'core', 'hub', 6, null, 'host');
    node('hw:cpu', 'CPU ×8', 'core', 'cpu', 6, { model: 'AMD EPYC 7B13', mhz: 3050 }, 'hw');
    for (let i = 0; i < 8; i++) node('hw:core:' + i, 'core ' + i, 'core', 'core', 1.8, { mhz: 3050 }, 'hw:cpu');
    node('hw:mem', 'RAM 32 GB', 'core', 'mem', 5, { total: '32 GB', available: '19.4 GB', cached: '8.1 GB' }, 'hw');
    node('hw:swap', 'Swap 4.0 GB', 'core', 'mem', 2.5, { total: '4.0 GB', free: '3.9 GB' }, 'hw');
    node('hw:if:eth0', 'eth0', 'core', 'iface', 3.2, { addresses: '203.0.113.10 · 2001:db8::10' }, 'hw');
    node('hw:if:lo', 'lo', 'core', 'iface', 1.6, { addresses: '127.0.0.1 · ::1' }, 'hw');
    node('hw:if:docker0', 'docker0', 'core', 'iface', 2.4, { addresses: '172.17.0.1' }, 'hw');
    node('hw:mnt:/', '/', 'core', 'disk', 5, { device: '/dev/nvme0n1p1', fs: 'ext4', size: '160 GB', used: '71 GB', free: '89 GB', use: '44%' }, 'hw');
    node('hw:mnt:/boot', '/boot', 'core', 'disk', 2.6, { device: '/dev/nvme0n1p2', fs: 'ext4', size: '1.0 GB', used: '180 MB', use: '18%' }, 'hw');
    node('hw:mnt:/data', '/data', 'core', 'disk', 5.4, { device: '/dev/nvme1n1', fs: 'xfs', size: '500 GB', used: '421 GB', free: '79 GB', use: '84%' }, 'hw', 'warn');

    // ---- init + kernel
    node('proc:1', 'systemd (PID 1)', 'svc', 'hub', 8, { pid: 1, user: 'root' }, 'host');
    node('proc:2', 'kthreadd · kernel', 'kern', 'hub', 5, { pid: 2 }, 'host');
    const kt = ['kworker/%:1', 'kworker/%:0H', 'ksoftirqd/%', 'migration/%', 'cpuhp/%', 'idle_inject/%', 'kworker/u16:%'];
    let kp = 3;
    for (let c = 0; c < 8; c++) for (const k of kt) node('proc:' + (kp++), k.replace('%', c), 'kern', 'kthread', 0.7, { pid: kp }, 'proc:2');
    for (const k of ['rcu_preempt', 'kswapd0', 'khugepaged', 'kcompactd0', 'jbd2/nvme0n1p1-8', 'xfsaild/nvme1n1', 'kauditd', 'oom_reaper', 'writeback', 'kblockd', 'ext4-rsv-conver', 'watchdogd'])
      node('proc:' + (kp++), k, 'kern', 'kthread', 0.7, { pid: kp }, 'proc:2');

    // ---- systemd services
    const svc = (name, desc, mb, st, parent) => {
      const id = 'svc:' + name + '.service';
      node(id, name, 'svc', 'svc', mb ? 2.2 + lg(mb) * 0.45 : 1.3, { unit: name + '.service', description: desc, state: st === 'off' ? 'inactive/dead' : st === 'bad' ? 'failed/failed' : 'active/running', memory: mb ? fmtBytes(mb * MB) : undefined, enabled: 'enabled' }, parent || 'proc:1', st);
      return id;
    };
    const running = [['ssh', 'OpenBSD Secure Shell server', 9], ['cron', 'Regular background program processing daemon', 3], ['nginx', 'A high performance web server', 38],
      ['postgresql@16-main', 'PostgreSQL Cluster 16-main', 820], ['redis-server', 'Advanced key-value store', 410], ['fail2ban', 'Fail2Ban Service', 64],
      ['docker', 'Docker Application Container Engine', 120], ['containerd', 'containerd container runtime', 52], ['systemd-journald', 'Journal Service', 48],
      ['systemd-logind', 'User Login Management', 7], ['systemd-networkd', 'Network Configuration', 6], ['systemd-resolved', 'Network Name Resolution', 12],
      ['systemd-timesyncd', 'Network Time Synchronization', 5], ['systemd-udevd', 'Rule-based Manager for Device Events', 11], ['rsyslog', 'System Logging Service', 8],
      ['dbus', 'D-Bus System Message Bus', 6], ['polkit', 'Authorization Manager', 9], ['unattended-upgrades', 'Unattended Upgrades Shutdown', 21],
      ['multipathd', 'Device-Mapper Multipath Device Controller', 26], ['snapd', 'Snap Daemon', 34], ['node_exporter', 'Prometheus Node Exporter', 22], ['pm2-root', 'PM2 process manager', 0]];
    for (const [n, d, mb] of running) svc(n, d, mb);
    for (const n of ['apt-daily', 'apt-daily-upgrade', 'logrotate', 'man-db', 'e2scrub_all', 'fstrim', 'motd-news', 'certbot', 'systemd-tmpfiles-clean', 'dpkg-db-backup', 'sysstat-collect'])
      svc(n, n + ' (oneshot)', 0, 'off');
    svc('backup-sync', 'Nightly offsite backup', 0, 'bad');
    const timers = ['apt-daily', 'apt-daily-upgrade', 'logrotate', 'man-db', 'e2scrub_all', 'fstrim', 'motd-news', 'certbot', 'systemd-tmpfiles-clean', 'dpkg-db-backup', 'sysstat-collect', 'backup-sync'];
    for (const t of timers) {
      node('tmr:' + t + '.timer', t + ' ⏱', 'sched', 'timer', 1.6, { timer: t + '.timer', triggers: t + '.service', state: 'active', next: 'in ' + ri(1, 23) + ' h' }, 'proc:1');
      link('tmr:' + t + '.timer', 'svc:' + t + '.service', 's');
    }

    // service children
    for (let i = 0; i < 8; i++) proc('nginx: worker process', 'svc:nginx.service', 14, { user: 'www-data' });
    proc('nginx: cache manager', 'svc:nginx.service', 6, { user: 'www-data' });
    const pg = 'svc:postgresql@16-main.service';
    for (const b of ['checkpointer', 'background writer', 'walwriter', 'autovacuum launcher', 'logical replication launcher']) proc('postgres: 16/main: ' + b, pg, 18, { user: 'postgres' });
    for (let i = 0; i < 18; i++) proc('postgres: 16/main: app app 127.0.0.1 idle', pg, 24, { user: 'postgres' });
    const sshd = 'svc:ssh.service';
    const priv = proc('sshd: deploy [priv]', sshd, 9);
    const sess = proc('sshd: deploy@pts/0', priv, 7, { user: 'deploy' });
    const bash = proc('bash', sess, 5, { user: 'deploy' });
    proc('htop', bash, 6, { user: 'deploy' });
    proc('fail2ban-server', 'svc:fail2ban.service', 58);
    proc('agetty', 'proc:1', 2); proc('agetty', 'proc:1', 2);

    // ---- docker containers
    const dockerd = 'svc:docker.service';
    const ctr = (name, image, mb, children) => {
      const shim = proc('containerd-shim-runc-v2', 'svc:containerd.service', 12);
      const id = 'ctr:' + name;
      node(id, '🐳 ' + name, 'docker', 'ctr', 3 + lg(mb) * 0.5, { image, state: 'running', status: 'Up ' + ri(2, 30) + ' days', rss: fmtBytes(mb * MB) }, shim);
      for (const c of children || []) proc(c, id, ri(8, 60));
      return id;
    };
    ctr('grafana', 'grafana/grafana:11.2.0', 180, ['grafana server']);
    ctr('prometheus', 'prom/prometheus:v2.54.1', 640, []);
    ctr('uptime-kuma', 'louislam/uptime-kuma:1', 150, ['node server/server.js']);
    ctr('minio', 'minio/minio:latest', 260, []);
    node('ctr:old-import', '🐳 old-import', 'docker', 'ctr', 2.2, { image: 'app/importer:0.9', state: 'exited', status: 'Exited (0) 3 weeks ago' }, dockerd, 'off');
    for (let i = 0; i < 4; i++) proc('docker-proxy', dockerd, 4);

    // ---- pm2 apps
    node('pm2:daemon', 'PM2 daemon', 'pm2', 'hub', 7, { apps: 12, online: 10 }, 'svc:pm2-root.service');
    const apps = [['api', 420, '/opt/app/api'], ['api-worker', 310, '/opt/app/api'], ['web', 260, '/opt/app/web'], ['queue-worker', 190, '/opt/app/api'],
      ['mailer', 90, '/opt/app/mailer'], ['discord-bot', 120, '/opt/bots/discord'], ['scheduler', 70, '/opt/app/api'], ['image-resizer', 230, '/opt/app/media'],
      ['webhooks', 110, '/opt/app/hooks'], ['metrics-exporter', 60, '/opt/app/metrics']];
    for (const [n, mb, cwd] of apps) {
      node('pm2:' + n, n, 'pm2', 'pm2', 3.2 + lg(mb) * 0.55, { status: 'online', restarts: ri(0, 6), rss: fmtBytes(mb * MB), cwd, script: cwd + '/dist/' + n + '.js', interpreter: 'node', mode: 'fork_mode' }, 'pm2:daemon');
    }
    proc('ffmpeg', 'pm2:image-resizer', 140); proc('ffmpeg', 'pm2:image-resizer', 120);
    node('pm2:legacy-sync', 'legacy-sync', 'pm2', 'pm2', 2.4, { status: 'stopped', restarts: 0 }, 'pm2:daemon', 'off');
    node('pm2:report-gen', 'report-gen', 'pm2', 'pm2', 2.4, { status: 'errored', restarts: 15 }, 'pm2:daemon', 'bad');

    // ---- listening ports
    const port = (p, owner, pub, extra, proto) => {
      const id = 'port:' + (proto || 'tcp') + ':' + p;
      node(id, ':' + p + (proto === 'udp' ? '/udp' : ''), 'port', 'port', 1.9, Object.assign({ proto: proto || 'tcp', port: p, bind: pub ? '0.0.0.0 · ::' : '127.0.0.1', exposure: pub ? 'public' : 'loopback only', firewall: pub ? 'ufw ALLOW' : '—' }, extra || {}), owner);
      return id;
    };
    port(22, sshd, true); port(80, 'svc:nginx.service', true); port(443, 'svc:nginx.service', true);
    port(5432, pg, false); port(6379, 'svc:redis-server.service', false);
    port(3000, 'pm2:api', false); port(8080, 'pm2:web', false); port(3002, 'pm2:webhooks', false); port(9464, 'pm2:metrics-exporter', false);
    port(9100, 'svc:node_exporter.service', false); port(3100, 'ctr:grafana', false); port(9090, 'ctr:prometheus', false);
    port(3001, 'ctr:uptime-kuma', false); port(9000, 'ctr:minio', false); port(53, 'svc:systemd-resolved.service', false, null, 'udp');
    port(53, 'svc:systemd-resolved.service', false);

    // ---- internal wiring (ipc)
    const ipc = [['pm2:api', 5432], ['pm2:api', 6379], ['pm2:api-worker', 5432], ['pm2:api-worker', 6379], ['pm2:queue-worker', 6379], ['pm2:queue-worker', 5432],
      ['pm2:web', 3000], ['pm2:scheduler', 6379], ['pm2:mailer', 6379], ['pm2:webhooks', 5432], ['pm2:webhooks', 6379], ['pm2:discord-bot', 3000],
      ['pm2:image-resizer', 9000], ['pm2:image-resizer', 6379], ['ctr:grafana', 9090], ['ctr:prometheus', 9100], ['ctr:prometheus', 9464], ['ctr:uptime-kuma', 443],
      ['svc:nginx.service', 3000], ['svc:nginx.service', 8080]];
    for (const [a, p] of ipc) link(a, 'port:tcp:' + p, 'i');

    // ---- internet peers
    const used = new Set();
    const ip = (pre) => { for (;;) { const x = pre + '.' + ri(1, 254); if (!used.has(x)) { used.add(x); return x; } } };
    const peer = (addr, from, dir, ports, conns, st) => {
      node('peer:' + addr, addr, 'net', 'peer', 1 + lg(conns) * 0.7, { direction: dir, conns, ports, sent: fmtBytes(ri(10, 9000) * 1024), received: fmtBytes(ri(5, 4000) * 1024), rtt: (R() * 120 + 4).toFixed(1) + ' ms' }, from, st);
      link(from, 'peer:' + addr, 'n');
    };
    for (let i = 0; i < 150; i++) peer(ip('203.0.113'), 'port:tcp:443', 'inbound', '443', ri(1, 9));
    for (let i = 0; i < 26; i++) peer(ip('198.51.100'), 'port:tcp:80', 'inbound', '80', ri(1, 3));
    for (let i = 0; i < 50; i++) peer('2001:db8:' + ri(1, 0xffff).toString(16) + '::' + ri(1, 0xffff).toString(16), 'port:tcp:443', 'inbound', '443', ri(1, 6));
    const admin = ip('198.51.100'); peer(admin, 'port:tcp:22', 'inbound', '22', 1);
    for (let i = 0; i < 4; i++) peer(ip('192.0.2'), 'port:tcp:22', 'inbound', '22', 1);
    for (const [from, n, p] of [['pm2:api', 9, '443'], ['pm2:mailer', 3, '587'], ['pm2:discord-bot', 4, '443'], ['pm2:webhooks', 12, '443'], ['pm2:api-worker', 6, '443'], ['svc:snapd.service', 1, '443'], ['svc:systemd-timesyncd.service', 1, '123']])
      for (let i = 0; i < n; i++) peer(ip('198.51.100'), from, 'outbound', p, ri(1, 4));

    // ---- nginx domains + TLS
    const ngx = 'svc:nginx.service';
    const doms = [['example.com', 8080], ['api.example.com', 3000], ['hooks.example.com', 3002], ['grafana.example.com', 3100], ['status.example.com', 3001], ['files.example.com', 9000], ['admin.example.com', 3005]];
    for (const [d, p] of doms) {
      node('dom:' + d, d, 'web', 'domain', 3.2, { names: d + (d === 'example.com' ? ' www.example.com' : ''), listen: '80 443/ssl', tls: 'yes', proxy: 'http://127.0.0.1:' + p, config: 'sites-enabled/' + d }, ngx);
      if (!N.has('port:tcp:' + p)) node('port:tcp:' + p, ':' + p + ' ✕', 'port', 'port', 1.6, { port: p, problem: 'nginx proxies here but nothing is listening' }, 'dom:' + d, 'bad');
      link('dom:' + d, 'port:tcp:' + p, 'x');
    }
    node('dom:_', 'default server (_)', 'web', 'domain', 3.2, { names: '_', listen: '80 443/ssl', tls: 'yes', proxy: '—' }, ngx);
    node('tls', 'TLS certificates', 'web', 'hub', 4, { count: doms.length }, ngx);
    doms.forEach(([d], i) => {
      const days = [71, 64, 12, 58, 45, 33, 80][i];
      node('cert:' + d, '🔒 ' + d, 'web', 'cert', 1.9, { domains: d, days_left: days, issuer: "Let's Encrypt" }, 'tls', days < 20 ? 'warn' : null);
      link('cert:' + d, 'dom:' + d, 'c');
    });

    // ---- postgres
    const pgdb = (name, size, tables, schema) => {
      const id = 'pg:' + name;
      node(id, '🐘 ' + name, 'pg', 'pgdb', 3.5 + lg(size / MB) * 0.35, { size: fmtBytes(size), connections: ri(1, 18), tables: tables.length, version: '16.4' }, pg);
      let parent = id;
      if (schema) { parent = 'pgs:' + name + '.' + schema; node(parent, schema, 'pg', 'pgschema', 2, { database: name }, id); }
      for (const [t, rows] of tables) node('pgt:' + name + '.' + t, t, 'pg', 'pgtable', 1 + Math.log10(1 + rows) * 0.5, { rows, size: fmtBytes(rows * ri(90, 600)) }, parent);
    };
    pgdb('app', 14 * GB, [['users', 48210], ['sessions', 190332], ['orders', 381204], ['order_items', 1120450], ['products', 8120], ['product_images', 30110], ['carts', 20440],
      ['payments', 360121], ['refunds', 2210], ['events', 2140000], ['audit_log', 880412], ['api_keys', 1320], ['webhooks', 410], ['webhook_deliveries', 512000],
      ['jobs', 70220], ['coupons', 380], ['reviews', 44010], ['addresses', 51200], ['notifications', 240100], ['migrations', 118]]);
    pgdb('analytics', 31 * GB, [['pageviews_daily', 910000], ['sessions_daily', 220000], ['funnels', 4200], ['cohorts', 1800], ['referrers', 61000], ['devices', 900]], 'rollup');
    pgdb('postgres', 8 * MB, []);

    // ---- redis
    const rs = 'svc:redis-server.service';
    node('rdb:0', 'redis db0', 'redis', 'redisdb', 7, { keys: 184220, expiring: 170100 }, rs);
    node('rdb:1', 'redis db1', 'redis', 'redisdb', 4.5, { keys: 2210, expiring: 40 }, rs);
    const ns = { sess: 41200, cache: 98000, 'bull': 21000, rate: 18000, lock: 90, feature: 60 };
    const subs = { cache: ['product', 'user', 'page', 'search', 'cart'], bull: ['email', 'image', 'webhook', 'report'], rate: ['ip', 'user', 'key'] };
    for (const [k, n] of Object.entries(ns)) {
      const id = 'rk:0:' + k;
      node(id, k + (subs[k] ? ':*' : ''), 'redis', 'redisns', 1 + Math.log10(1 + n) * 0.9, { pattern: k + ':…', keys: n }, 'rdb:0');
      for (const s of subs[k] || []) node(id + ':' + s, k + ':' + s, 'redis', 'redisns', 0.9 + Math.log10(1 + n / 5) * 0.8, { pattern: k + ':' + s + ':…', keys: Math.round(n / 5) }, id);
    }
    for (const k of ['config', 'stats', 'leader']) node('rk:1:' + k, k + ':*', 'redis', 'redisns', 2.2, { keys: ri(20, 900) }, 'rdb:1');

    // ---- filesystem
    const dir = (p, parent, mb, st) => node('dir:' + p, p.split('/').pop() || '/', 'fs', 'dir', 0.7 + Math.log10(1 + mb) * 0.75, { path: p, size: fmtBytes(mb * MB) }, parent, st);
    node('dir:/', '/', 'fs', 'dir', 4, { mount: '/' }, 'hw:mnt:/');
    const top = { '/opt': 9200, '/var/log': 3100, '/var/lib': 38000, '/home': 2100, '/etc': 12, '/var/www': 800, '/usr/local': 900, '/root': 400, '/var/backups': 6400 };
    for (const [p, mb] of Object.entries(top)) { node('dir:' + p, p, 'fs', 'dir', 0.7 + Math.log10(1 + mb) * 0.75, { path: p, size: fmtBytes(mb * MB) }, 'dir:/', p === '/var/backups' ? 'off' : null); }
    for (const [a, sub] of [['/opt/app', ['api', 'web', 'mailer', 'media', 'hooks', 'metrics']], ['/opt/bots', ['discord']], ['/opt/scripts', []]]) {
      dir(a, 'dir:/opt', ri(200, 4000));
      for (const s of sub) {
        const p = a + '/' + s; dir(p, 'dir:' + a, ri(40, 900));
        for (const c of ['dist', 'node_modules', 'logs', 'data']) dir(p + '/' + c, 'dir:' + p, ri(1, 400));
      }
    }
    for (const s of ['nginx', 'postgresql', 'journal', 'redis', 'fail2ban.log', 'apt', 'letsencrypt', 'pm2']) dir('/var/log/' + s, 'dir:/var/log', ri(5, 1200));
    for (const s of ['postgresql', 'redis', 'docker', 'fail2ban', 'apt', 'snapd', 'dpkg', 'systemd']) dir('/var/lib/' + s, 'dir:/var/lib', ri(10, 20000));
    dir('/home/deploy', 'dir:/home', 1800); dir('/var/www/html', 'dir:/var/www', 600); dir('/var/www/uploads', 'dir:/var/www', 200);
    for (const [a, p] of [['pm2:api', '/opt/app/api'], ['pm2:api-worker', '/opt/app/api'], ['pm2:queue-worker', '/opt/app/api'], ['pm2:scheduler', '/opt/app/api'], ['pm2:web', '/opt/app/web'],
      ['pm2:mailer', '/opt/app/mailer'], ['pm2:image-resizer', '/opt/app/media'], ['pm2:webhooks', '/opt/app/hooks'], ['pm2:metrics-exporter', '/opt/app/metrics'], ['pm2:discord-bot', '/opt/bots/discord'],
      [pg, '/var/lib/postgresql'], [rs, '/var/lib/redis'], [dockerd, '/var/lib/docker'], ['dom:example.com', '/var/www/html'], ['dom:files.example.com', '/var/www/uploads']])
      link(a, 'dir:' + p, 'f');

    // ---- sqlite
    const sq = (p, parent, mb, by, tables, st) => {
      const id = 'sq:' + p;
      node(id, '🗄 ' + p.split('/').slice(-2).join('/'), 'sqlite', 'sqlite', 1.6 + lg(mb) * 0.45, { path: p, size: fmtBytes(mb * MB), open_by: by || '—' }, parent, st);
      for (const [t, r] of tables || []) node('sqt:' + p + ':' + t, t, 'sqlite', 'sqtable', 0.9 + Math.log10(1 + r) * 0.5, { rows: r, db: p }, id);
      return id;
    };
    link('pm2:discord-bot', sq('/opt/bots/discord/data/bot.db', 'dir:/opt/bots/discord/data', 12, 'discord-bot', [['guilds', 140], ['members', 21000], ['reminders', 330], ['settings', 140]]), 'f');
    link('pm2:image-resizer', sq('/opt/app/media/data/thumbs.db', 'dir:/opt/app/media/data', 90, 'image-resizer', [['thumbs', 88000], ['jobs', 1200]]), 'f');
    link('proc:fail2ban', sq('/var/lib/fail2ban/fail2ban.sqlite3', 'dir:/var/lib/fail2ban', 6, 'fail2ban-server', [['bans', 1840], ['jails', 3], ['logs', 12], ['bips', 1840]]), 'f');
    sq('/opt/app/web/data/old-cache.db', 'dir:/opt/app/web/data', 40, null, null, 'off');

    // ---- cron
    const cron = [['backup.sh', '10 4 * * *', '/opt/scripts/backup.sh'], ['cleanup-uploads.sh', '30 3 * * *', '/opt/scripts/cleanup-uploads.sh'], ['vacuum.sh', '0 5 * * 0', '/opt/scripts/vacuum.sh'],
      ['rotate-keys.js', '0 0 1 * *', 'node /opt/app/api/dist/rotate-keys.js'], ['0anacron', '@daily', '/etc/cron.daily/0anacron'], ['logrotate', '@daily', '/etc/cron.daily/logrotate'],
      ['apt-compat', '@daily', '/etc/cron.daily/apt-compat'], ['dpkg', '@daily', '/etc/cron.daily/dpkg'], ['popularity', '@weekly', '/etc/cron.weekly/popularity']];
    for (const [l, s, c] of cron) {
      const id = 'cron:' + l;
      node(id, '⏰ ' + l, 'sched', 'cron', 1.7, { schedule: s, user: 'root', command: c }, 'svc:cron.service');
      if (c.includes('/opt/scripts')) link(id, 'dir:/opt/scripts', 'f');
      if (c.includes('/opt/app/api')) link(id, 'dir:/opt/app/api', 'f');
    }

    // ---- security
    node('sec', 'Security', 'sec', 'hub', 5, { fail2ban_jails: 3, ufw_rules: 5 }, 'host');
    node('ufw', 'UFW firewall', 'sec', 'ufw', 3.2, { status: 'active', allow: 3, 'deny/reject': 2 }, 'sec');
    for (const p of [22, 80, 443]) link('ufw', 'port:tcp:' + p, 's');
    link('sec', 'svc:fail2ban.service', 's');
    for (const [j, n] of [['sshd', 46], ['nginx-limit-req', 14], ['recidive', 6]]) {
      const jid = 'jail:' + j;
      node(jid, 'jail ' + j, 'sec', 'jail', 2.4 + lg(n) * 0.3, { banned_now: n, banned_total: n * ri(4, 20), failing: ri(0, 9) }, 'svc:fail2ban.service');
      for (let i = 0; i < n; i++) { const b = ip('192.0.2'); node('ban:' + b, b, 'sec', 'ban', 0.9, { jail: j }, jid); }
    }
    node('user:root', '👤 root', 'sec', 'user', 2.4, { uid: 0, home: '/root', shell: '/bin/bash' }, 'sec');
    node('user:deploy', '👤 deploy', 'sec', 'user', 2.4, { uid: 1000, home: '/home/deploy', shell: '/bin/bash' }, 'sec');
    link('user:deploy', 'peer:' + admin, 'n');

    // ---- packages
    const P = {
      admin: 'adduser apt apt-utils base-files base-passwd cron debconf dpkg fail2ban logrotate lsb-release passwd rsyslog sudo systemd systemd-timesyncd tzdata ufw unattended-upgrades',
      libs: 'libacl1 libapparmor1 libargon2-1 libattr1 libaudit1 libblkid1 libbrotli1 libbsd0 libcap-ng0 libcom-err2 libcrypt1 libcryptsetup12 libdb5.3 libdbus-1-3 libdevmapper1.02.1 libedit2 libelf1 libexpat1 libfdisk1 libgcrypt20 libgdbm6 libglib2.0-0 libgpg-error0 libgssapi-krb5-2 libhogweed6 libicu74 libip4tc2 libjson-c5 libk5crypto3 libkeyutils1 libkmod2 libmnl0 libmount1 libnettle8 libnewt0.52 libnftnl11 libnl-3-200 libnpth0 libp11-kit0 libpcap0.8 libpci3 libpipeline1 libpopt0 libprocps8 libpsl5 libpython3.12 librtmp1 libsasl2-2 libsemanage2 libsepol2 libslang2 libsmartcols1 libsodium23 libssh-4 libtasn1-6 libtext-iconv-perl libunistring5 libwrap0 libxxhash0 libc6 libssl3 libcurl4 libpcre2-8-0 libzstd1 liblz4-1 libxml2 libyaml-0-2 libsqlite3-0 libpq5 libgcc-s1 libstdc++6 libsystemd0 libudev1 libcap2 libffi8 libgmp10 libgnutls30 libidn2-0 libkrb5-3 libldap2 libncursesw6 libnghttp2-14 libpam0g libreadline8 libseccomp2 libselinux1 libtinfo6 libuuid1 zlib1g libbz2-1.0 liblzma5 libmd0 libnss3 libjemalloc2 libevent-2.1-7',
      net: 'curl wget openssh-server openssh-client iproute2 iputils-ping netcat-openbsd dnsutils rsync ca-certificates tcpdump nftables iptables ethtool',
      web: 'nginx nginx-common certbot python3-certbot-nginx',
      database: 'postgresql-16 postgresql-client-16 postgresql-common redis-server redis-tools sqlite3',
      utils: 'coreutils findutils grep sed gawk tar gzip zstd xz-utils unzip less file procps psmisc htop tmux jq tree bc lsof strace sysstat',
      python: 'python3 python3-minimal python3-pip python3-venv python3-yaml python3-requests python3-apt python3-dbus',
      devel: 'git make gcc g++ build-essential pkg-config autoconf nodejs',
      kernel: 'linux-image-6.8.0-45-generic linux-modules-6.8.0-45-generic linux-firmware kmod',
      shells: 'bash dash zsh bash-completion',
      editors: 'vim vim-common nano',
      misc: 'containerd docker-ce docker-ce-cli docker-compose-plugin snapd ubuntu-minimal ubuntu-standard',
      perl: 'perl perl-base perl-modules-5.38',
      vcs: 'git-man',
      mail: 'bsd-mailx postfix',
    };
    let total = 0;
    for (const s of Object.values(P)) total += s.split(' ').length;
    node('pkg', 'Packages (' + total + ')', 'pkg', 'hub', 5, { installed: total }, 'host');
    for (const [s, list] of Object.entries(P)) {
      const names = list.split(' ');
      node('pkgs:' + s, s, 'pkg', 'pkgsec', 1.8 + lg(names.length) * 0.3, { packages: names.length }, 'pkg');
      for (const n of names) node('pkg:' + n, n, 'pkg', 'pkg', 0.6 + Math.log10(1 + ri(20, 90000)) * 0.3, { version: ri(1, 9) + '.' + ri(0, 30) + '.' + ri(0, 12) }, 'pkgs:' + s);
    }

    // the one process id the sqlite link above refers to
    const f2b = [...N.values()].find((n) => n.l === 'fail2ban-server');
    for (const [id, l] of [...L]) if (l.a === 'proc:fail2ban') { L.delete(id); link(f2b.id, l.b, l.k); }

    // ---- tie the tree
    for (const n of N.values()) {
      if (n.id === 'host') continue;
      if (!n.p || !N.has(n.p) || n.p === n.id) n.p = 'host';
      link(n.p, n.id, 't');
    }
    for (const [id, l] of L) if (!N.has(l.a) || !N.has(l.b)) L.delete(id);
    const layers = {};
    for (const n of N.values()) layers[n.g] = (layers[n.g] || 0) + 1;
    return { ok: true, demo: true, at: Date.now(), ms: 0, host: 'demo-vps', ip: '203.0.113.10', root: true, layers, errors: [], nodes: [...N.values()], links: [...L.values()] };
  }

  function graph() {
    if (!CACHE) CACHE = build();
    CACHE.at = Date.now();
    return CACHE;
  }

  // ---- live layer: a gently drifting load with bursts of traffic ----
  let S = null;
  function pulse() {
    const g = graph();
    if (!S) {
      S = { cpu: 22, mem: 39, t: 0 };
      S.busy = g.nodes.filter((n) => /^(pm2|svc|ctr):/.test(n.id) || /nginx: worker|postgres: 16\/main: app|ffmpeg/.test(n.l)).map((n) => n.id);
      S.wires = g.links.filter((l) => l.k === 'n' || l.k === 'i' || l.k === 'x').map((l) => l.a + '>' + l.b);
    }
    S.t++;
    const wave = Math.sin(S.t / 9) * 0.5 + 0.5;
    S.cpu = Math.max(4, Math.min(92, S.cpu + (Math.random() - 0.5) * 8 + (wave - 0.5) * 3));
    S.mem = Math.max(30, Math.min(70, S.mem + (Math.random() - 0.5) * 0.6));
    const act = {};
    for (const id of S.busy) if (Math.random() < 0.35 + wave * 0.3) act[id] = +(Math.random() * Math.random() * 90 + 0.5).toFixed(1);
    const traffic = {};
    for (const k of S.wires) if (Math.random() < 0.18 + wave * 0.25) traffic[k] = Math.round(Math.exp(Math.random() * 14) + 200);
    const cores = Array.from({ length: 8 }, () => Math.round(Math.max(1, Math.min(100, S.cpu + (Math.random() - 0.5) * 40))));
    const mt = 32 * GB;
    return {
      at: Date.now(), dt: 1.5, act, traffic,
      host: {
        cpu: +S.cpu.toFixed(1), cores, mem: +S.mem.toFixed(1), memUsed: Math.round(mt * S.mem / 100), memTotal: mt, swap: 2.1,
        rx: Math.round((2 + wave * 9) * MB * Math.random() + 300000), tx: Math.round((4 + wave * 20) * MB * Math.random() + 600000),
        diskR: Math.round(Math.random() * 6 * MB), diskW: Math.round(Math.random() * 14 * MB),
        load: [+(S.cpu / 12).toFixed(2), 1.62, 1.48], uptime: 1843200, procs: 412, tcp: 540 + Math.round(wave * 120), redisOps: Math.round(800 + wave * 2400 + Math.random() * 300),
      },
    };
  }

  return { graph, pulse };
});
