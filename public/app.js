'use strict';
/* vps-neural-map frontend: the whole server as one living 3D neural network.
   Data: GET api/graph (nodes + links) and GET api/pulse (~1.5 s live layer), or the built-in demo
   generator (window.NMDemo) when opened with ?demo, from a file, or from GitHub Pages.
   Renders with three.js (window.VNM3) + d3-force-3d (window.d3). */

(function () {
  const G = () => window.VNM3;
  const D3 = () => window.d3;
  const $ = (s) => document.querySelector(s);

  const qs = new URLSearchParams(location.search);
  const STATIC_DEMO = qs.has('demo') || location.protocol === 'file:' || /\.github\.io$/.test(location.hostname);

  // ---- palette: one hue family per layer, so clusters read as organs of the machine ----
  const GROUPS = {
    core:   { c: 0xcfe3ff, label: 'Host / hardware' },
    kern:   { c: 0x39425a, label: 'Kernel threads' },
    svc:    { c: 0x7c8cff, label: 'systemd services' },
    pm2:    { c: 0x37d39b, label: 'PM2 apps' },
    docker: { c: 0x2ec5ff, label: 'Docker' },
    proc:   { c: 0x9aa7bd, label: 'Processes' },
    sched:  { c: 0xffb454, label: 'Cron / timers' },
    port:   { c: 0x4fd1ff, label: 'Listening ports' },
    net:    { c: 0x5b8def, label: 'Internet peers' },
    web:    { c: 0xb07cff, label: 'nginx / TLS' },
    pg:     { c: 0x36a0ff, label: 'PostgreSQL' },
    mysql:  { c: 0xf29111, label: 'MySQL' },
    redis:  { c: 0xff5470, label: 'Redis' },
    sqlite: { c: 0xf4a259, label: 'SQLite' },
    fs:     { c: 0x6b7686, label: 'Filesystem' },
    sec:    { c: 0xff7a45, label: 'Security' },
    pkg:    { c: 0x424c61, label: 'Packages' },
  };
  const TYPE_COLOR = { host: 0xffffff };
  const ORIGIN = [0, 0, 0]; // anchor for a layer that first appears after the initial layout
  const ST_COLOR = { bad: 0xff3b57, warn: 0xffb454 };

  const hexToRgb = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
  const hex = (c) => '#' + c.toString(16).padStart(6, '0');
  const fmtBytes = (b) => { b = +b || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return (i ? b.toFixed(b < 10 ? 1 : 0) : b) + ' ' + u[i]; };
  const fmtRate = (b) => fmtBytes(b) + '/s';
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  class HttpError extends Error { constructor(status) { super('HTTP ' + status); this.status = status; } }
  async function getJson(url) {
    const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw new HttpError(r.status);
    return r.json();
  }
  const fetchGraph = () => (STATIC_DEMO ? Promise.resolve(window.NMDemo.graph()) : getJson('api/graph'));
  const fetchPulse = () => (STATIC_DEMO ? Promise.resolve(window.NMDemo.pulse()) : getJson('api/pulse'));

  async function main() {
    const wrap = $('#app');
    const canvas = $('#nCanvas');
    const load = $('#nLoad');
    const fatal = (msg) => { load.textContent = msg; load.classList.add('err'); load.classList.remove('hidden'); };
    if (!G() || !D3()) return fatal('3D engine failed to load (vendor bundle missing).');
    const THREE = G().THREE;

    // ---- scene ----
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: qs.has('capture') }); }
    catch (e) { return fatal('WebGL is not available in this browser.'); }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 1);
    const scene = new THREE.Scene(); // no fog: fog + additive blending = grey veil
    const camera = new THREE.PerspectiveCamera(58, 1, 1, 12000);
    camera.position.set(0, 60, 620);

    const controls = new (G().OrbitControls)(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.7; controls.zoomSpeed = 0.9; controls.maxDistance = 5000;
    controls.autoRotateSpeed = 0.35;
    const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    controls.autoRotate = !reduceMotion;

    // bloom composer — the glow that makes nodes read as stars
    const { EffectComposer, RenderPass, UnrealBloomPass, OutputPass } = G();
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // high threshold: only the bright node cores bloom, the faint synapses stay crisp
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.45, 0.5);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    function resize() {
      const w = wrap.clientWidth, h = wrap.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false); composer.setSize(w, h); bloom.setSize(w, h);
      camera.aspect = w / h;
      // the header HUD covers the top strip: move the optical centre down under the free area
      const top = $('.n-top'); const hh = top ? top.offsetHeight + 14 : 0;
      camera.setViewOffset(w, h, 0, -hh / 2, w, h);
      camera.updateProjectionMatrix();
    }
    new ResizeObserver(resize).observe(wrap);

    // ---- data ----
    let G0;
    try { G0 = await fetchGraph(); }
    catch (e) {
      if (e.status === 401) return fatal('Session expired: open the link printed in the terminal (it ends with ?token=…).');
      return fatal('Failed to load the graph: ' + e.message);
    }

    const state = {
      nodes: [], links: [], byId: new Map(),
      sim: null, showLabels: false, spin: controls.autoRotate, fitted: false,
      selected: null, act: {}, traffic: {},
    };
    $('#nSpin').classList.toggle('on', state.spin);

    // ---- graph → sim nodes/links ----
    // Surviving nodes keep their OBJECT (position, velocity, selection all stay valid); new nodes are
    // born next to their parent so they grow out of the right organ. Returns how many changed.
    function buildGraph(g) {
      const prev = state.byId;
      const nodes = []; const byId = new Map(); let added = 0;
      for (const n of g.nodes) {
        const gg = GROUPS[n.g] || GROUPS.proc;
        let col = TYPE_COLOR[n.t] || gg.c;
        if (n.st && ST_COLOR[n.st]) col = ST_COLOR[n.st];
        let o = prev.get(n.id);
        if (!o) {
          added++;
          const par = prev.get(n.p) || byId.get(n.p);
          const j = () => (Math.random() - 0.5) * (par ? 30 : 400);
          o = { id: n.id, x: (par ? par.x : 0) + j(), y: (par ? par.y : 0) + j(), z: (par ? par.z : 0) + j(), vx: 0, vy: 0, vz: 0 };
        }
        Object.assign(o, { l: n.l, g: n.g, t: n.t, s: n.s || 1, m: n.m || null, p: n.p, st: n.st || null, col, dim: n.st === 'off',
          _search: (n.l + ' ' + (n.m ? Object.values(n.m).join(' ') : '')).toLowerCase() });
        nodes.push(o); byId.set(n.id, o);
      }
      let removed = 0; for (const id of prev.keys()) if (!byId.has(id)) removed++;
      const links = [];
      // `tree` = child hangs from this parent. A parent link can also carry a wiring kind (a port's
      // own peers are 'n'), which colours it; the layout still treats it as a tree link.
      for (const l of g.links) if (byId.has(l.a) && byId.has(l.b)) links.push({ source: l.a, target: l.b, k: l.k, w: l.w || 1, tree: l.k === 't' || byId.get(l.b).p === l.a });
      state.nodes = nodes; state.links = links; state.byId = byId; state.raw = g;
      if (state.selected) state.selected = byId.get(state.selected.id) || null;
      return added + removed;
    }

    // ---- force layout, time-sliced; groups pulled to anchors on a sphere ----
    function initLayout() {
      const d3 = D3();
      // per-group anchor (fibonacci sphere) so each subsystem forms its own lobe
      const gset = [...new Set(state.nodes.map((n) => n.g))];
      const anc = {}; const R = 430;
      gset.forEach((g, i) => {
        const y = 1 - (i / Math.max(1, gset.length - 1)) * 2;
        const r = Math.sqrt(Math.max(0, 1 - y * y)); const th = i * 2.399963;
        anc[g] = [Math.cos(th) * r * R, y * R, Math.sin(th) * r * R];
      });
      state.host = state.byId.get('host'); if (state.host) { state.host.fx = 0; state.host.fy = 0; state.host.fz = 0; }
      const sim = d3.forceSimulation(state.nodes, 3)
        .numDimensions(3)
        // tree links: leaves hug their hub (starburst); cross links (ipc/net/fs…) are long weak
        // synapses that stitch the lobes together without collapsing them
        .force('link', d3.forceLink(state.links).id((d) => d.id)
          .distance((l) => (l.tree ? 10 + Math.sqrt(nodeOf(l.target).s) * 9 : 70))
          .strength((l) => (l.tree ? 0.85 : 0.025)))
        // hubs repel harder than leaves -> dandelion heads like the Opte internet map
        .force('charge', d3.forceManyBody().strength((d) => -(6 + d.s * d.s * 2.6)).theta(0.9).distanceMax(700))
        .force('gx', d3.forceX((d) => (anc[d.g] || ORIGIN)[0]).strength(0.018))
        .force('gy', d3.forceY((d) => (anc[d.g] || ORIGIN)[1]).strength(0.018))
        .force('gz', d3.forceZ((d) => (anc[d.g] || ORIGIN)[2]).strength(0.018))
        .force('center', d3.forceCenter(0, 0, 0))
        .alpha(1).alphaDecay(0.018).velocityDecay(0.36)
        .stop();
      state.sim = sim; state.simTicks = 0;
    }
    // forceLink hands the distance fn either an id (before init) or the resolved node object
    function nodeOf(x) { return typeof x === 'object' ? x : (state.byId.get(x) || { s: 1 }); }

    // frame the whole network: centre of the 3rd–97th percentile box on each axis (one dense
    // cluster must not pull the frame, and a few far outliers must not shrink it) + a radius that
    // covers ~94% of the nodes
    function fitCamera(immediate) {
      const ns = state.nodes.filter((n) => !n._hidden); if (!ns.length) return;
      const mid = (k) => { const a = ns.map((n) => n[k]).sort((p, q) => p - q); return (a[Math.floor(a.length * 0.03)] + a[Math.floor(a.length * 0.97)]) / 2; };
      const cx = mid('x'), cy = mid('y'), cz = mid('z');
      const ds = ns.map((n) => Math.hypot(n.x - cx, n.y - cy, n.z - cz)).sort((a, b) => a - b);
      const r = ds[Math.floor(ds.length * 0.94)] || 300;
      const vfov = (camera.fov * Math.PI) / 180;
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      // ×1.08: breathing room for the header strip on top and the legend at the bottom
      const dist = r / Math.sin(Math.min(vfov, hfov) / 2) * 1.08;
      const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
      if (!isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(0, 0.12, 1).normalize();
      controls.target.set(cx, cy, cz);
      const to = new THREE.Vector3(cx, cy, cz).addScaledVector(dir, dist);
      if (immediate) camera.position.copy(to); else animateCam(to);
    }

    // ---- geometry: points (nodes) + line segments (synapses) + particles (traffic) ----
    let pts, lineSeg, particles, partData;
    const NODE_SHADER = {
      vertex: `
        attribute float size; attribute vec3 acolor; attribute float hot; attribute float dim;
        uniform float uPR; // device pixel ratio: sizes are in CSS pixels, gl_PointSize in buffer pixels
        varying vec3 vC; varying float vHot; varying float vDim;
        void main(){ vC=acolor; vHot=hot; vDim=dim;
          vec4 mv=modelViewMatrix*vec4(position,1.0);
          gl_PointSize = size*(1.0+hot*1.4) * (360.0/-mv.z) * uPR;
          gl_Position = projectionMatrix*mv; }`,
      // saturated colour halo, small white-hot core; the white only grows with live activity
      fragment: `
        varying vec3 vC; varying float vHot; varying float vDim;
        void main(){ float d=length(gl_PointCoord-vec2(0.5));
          if(d>0.5) discard;
          float halo=pow(smoothstep(0.5,0.0,d),1.8);
          float core=pow(smoothstep(0.16,0.0,d),1.5);
          vec3 col = vC*(halo*1.25) + vec3(1.0)*core*(0.28+vHot*0.9);
          float a = (halo+core*0.5)*(vDim>0.5?0.28:1.0);
          gl_FragColor = vec4(col, a); }`, // AdditiveBlending already scales by alpha
    };
    const pointMaterial = () => new THREE.ShaderMaterial({
      uniforms: { uPR: { value: renderer.getPixelRatio() } }, vertexShader: NODE_SHADER.vertex, fragmentShader: NODE_SHADER.fragment,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });

    function buildObjects() {
      for (const o of [pts, lineSeg, particles]) if (o) { scene.remove(o); o.geometry.dispose(); o.material.dispose(); }
      const N = state.nodes.length;
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), hot = new Float32Array(N), dim = new Float32Array(N);
      state.nodes.forEach((n, i) => {
        pos[i * 3] = n.x; pos[i * 3 + 1] = n.y; pos[i * 3 + 2] = n.z;
        const c = (n._rgb = hexToRgb(n.col)); col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
        n._size = 2.2 + n.s * 2.6; n._hidden = !!(state.hidden && state.hidden.has(n.g));
        size[i] = n._hidden ? 0 : n._size; hot[i] = 0; dim[i] = n.dim ? 1 : 0; n._i = i;
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('acolor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('size', new THREE.BufferAttribute(size, 1));
      g.setAttribute('hot', new THREE.BufferAttribute(hot, 1));
      g.setAttribute('dim', new THREE.BufferAttribute(dim, 1));
      pts = new THREE.Points(g, pointMaterial());
      pts.frustumCulled = false; scene.add(pts);

      // synapses
      const L = state.links.length;
      const lp = new Float32Array(L * 6), lc = new Float32Array(L * 6);
      state.links.forEach((l, i) => {
        const a = state.byId.get(l.source.id || l.source), b = state.byId.get(l.target.id || l.target);
        l._a = a; l._b = b;
        const ca = hexToRgb(a.col), cb = hexToRgb(b.col);
        // tree synapses faint, real wiring (net / ipc / proxy) brighter so live paths stand out
        const base = l.k === 't' ? 0.1 : l.k === 'n' ? 0.3 : l.k === 'x' ? 0.55 : l.k === 'i' ? 0.34 : 0.16;
        l._c = [ca[0] * base, ca[1] * base, ca[2] * base, cb[0] * base, cb[1] * base, cb[2] * base];
        const off = a._hidden || b._hidden;
        for (let j = 0; j < 6; j++) lc[i * 6 + j] = off ? 0 : l._c[j];
      });
      const lgeo = new THREE.BufferGeometry();
      lgeo.setAttribute('position', new THREE.BufferAttribute(lp, 3));
      lgeo.setAttribute('color', new THREE.BufferAttribute(lc, 3));
      lineSeg = new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
      lineSeg.frustumCulled = false; scene.add(lineSeg);

      // traffic particles pool
      const PN = 2200;
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PN * 3), 3));
      pg.setAttribute('acolor', new THREE.BufferAttribute(new Float32Array(PN * 3), 3));
      pg.setAttribute('size', new THREE.BufferAttribute(new Float32Array(PN), 1));
      pg.setAttribute('hot', new THREE.BufferAttribute(new Float32Array(PN), 1));
      pg.setAttribute('dim', new THREE.BufferAttribute(new Float32Array(PN), 1));
      pg.setDrawRange(0, 0);
      partData = new Array(PN).fill(null);
      particles = new THREE.Points(pg, pointMaterial());
      particles.frustumCulled = false; scene.add(particles);
      state._PN = PN;
      writeLinePositions();
      if (state.traffic) spawnTraffic();
    }

    function writeLinePositions() {
      const lp = lineSeg.geometry.attributes.position.array;
      state.links.forEach((l, i) => {
        const a = l._a, b = l._b;
        lp[i * 6] = a.x; lp[i * 6 + 1] = a.y; lp[i * 6 + 2] = a.z;
        lp[i * 6 + 3] = b.x; lp[i * 6 + 4] = b.y; lp[i * 6 + 5] = b.z;
      });
      lineSeg.geometry.attributes.position.needsUpdate = true;
    }
    function writeNodePositions() {
      const pa = pts.geometry.attributes.position.array;
      state.nodes.forEach((n, i) => { pa[i * 3] = n.x; pa[i * 3 + 1] = n.y; pa[i * 3 + 2] = n.z; });
      pts.geometry.attributes.position.needsUpdate = true;
    }

    // ---- legend / filters ----
    function buildLegend() {
      const box = $('#nLegend');
      const counts = {}; state.nodes.forEach((n) => { counts[n.g] = (counts[n.g] || 0) + 1; });
      const order = Object.keys(GROUPS).filter((g) => counts[g]);
      state.hidden = state.hidden || new Set();
      box.innerHTML = order.map((g) => `<button type="button" class="n-leg ${state.hidden.has(g) ? 'off' : ''}" data-g="${g}" aria-pressed="${!state.hidden.has(g)}">` +
        `<b style="background:${hex(GROUPS[g].c)};color:${hex(GROUPS[g].c)}"></b>${GROUPS[g].label} <i>${counts[g]}</i></button>`).join('');
      box.querySelectorAll('.n-leg').forEach((el) => { el.onclick = () => {
        const g = el.dataset.g;
        if (state.hidden.has(g)) state.hidden.delete(g); else state.hidden.add(g);
        el.classList.toggle('off'); el.setAttribute('aria-pressed', String(!state.hidden.has(g))); applyVisibility();
      }; });
    }
    // A switched-off layer disappears completely: its points get size 0 and every synapse that
    // touches it goes black (additive blending, so black = invisible).
    function applyVisibility() {
      const sizeA = pts.geometry.attributes.size.array;
      state.nodes.forEach((n, i) => { n._hidden = state.hidden.has(n.g); sizeA[i] = n._hidden ? 0 : n._size; });
      pts.geometry.attributes.size.needsUpdate = true;
      const lc = lineSeg.geometry.attributes.color.array;
      state.links.forEach((l, i) => {
        const off = l._a._hidden || l._b._hidden;
        for (let j = 0; j < 6; j++) lc[i * 6 + j] = off ? 0 : l._c[j];
      });
      lineSeg.geometry.attributes.color.needsUpdate = true;
      if (state.showLabels) renderLabels();
    }

    // ---- picking ----
    const ray = new THREE.Raycaster(); ray.params.Points.threshold = 6;
    const mouse = new THREE.Vector2();
    // gl_PointSize = size*360/depth  ⇒  a point's world radius is size·360·tan(fov/2)/H (= size·k), the
    // same at every depth; ×0.7 because the halo fades out before the disc edge. Score each hit by
    // (distance to ray ÷ its own radius): the cursor must be inside the glowing disc, and a big star
    // wins over a tiny node that merely sits in front of it.
    function pick(ev) {
      const r = canvas.getBoundingClientRect();
      mouse.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
      mouse.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(mouse, camera);
      const k = (360 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, r.height);
      const minR = 6 * camera.position.distanceTo(controls.target) * (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, r.height);
      ray.params.Points.threshold = Math.max(minR, 60 * k);
      let best = null, bestScore = Infinity;
      for (const h of ray.intersectObject(pts)) {
        const n = state.nodes[h.index]; if (!n || n._hidden) continue;
        const rad = Math.max(n._size * 0.7 * k, minR);
        const d = h.distanceToRay / rad;
        if (d > 1) continue;
        const score = d - n.s * 0.03; // slight bias to hubs when discs overlap
        if (score < bestScore) { best = n; bestScore = score; }
      }
      return best;
    }
    const tip = $('#nTip');
    canvas.addEventListener('pointermove', (ev) => {
      if (ev.pointerType === 'touch') return;
      const n = pick(ev);
      if (n) {
        canvas.style.cursor = 'pointer'; tip.classList.remove('hidden');
        tip.innerHTML = `<b style="color:${hex(n.col)}">${escapeHtml(n.l)}</b><span>${GROUPS[n.g] ? GROUPS[n.g].label : escapeHtml(n.g)}</span>`;
        tip.style.left = Math.min(ev.clientX + 14, innerWidth - 200) + 'px'; tip.style.top = (ev.clientY + 14) + 'px';
      } else { canvas.style.cursor = ''; tip.classList.add('hidden'); }
    });
    canvas.addEventListener('pointerleave', () => tip.classList.add('hidden'));
    // a click is a press+release that did not drag the camera
    let down = null;
    canvas.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY }; });
    canvas.addEventListener('pointerup', (ev) => {
      if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 6) { down = null; return; }
      down = null;
      const n = pick(ev); if (n) selectNode(n); else closeDetail();
    });

    const detail = $('#nDetail');
    function selectNode(n) {
      state.selected = n;
      detail.classList.remove('hidden');
      const links = state.links.filter((l) => l._a === n || l._b === n);
      const neigh = links.slice(0, 40).map((l) => { const o = l._a === n ? l._b : l._a; return `<a data-id="${escapeHtml(o.id)}" tabindex="0">${escapeHtml(o.l)}</a>`; }).join('');
      const rows = n.m ? Object.entries(n.m).filter(([, val]) => val !== undefined && val !== '').map(([k, val]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(val))}</td></tr>`).join('') : '';
      detail.innerHTML = `
        <div class="n-dhead"><span class="n-ddot" style="background:${hex(n.col)};color:${hex(n.col)}"></span>
          <div><h3>${escapeHtml(n.l)}</h3><span class="n-dsub">${GROUPS[n.g] ? GROUPS[n.g].label : escapeHtml(n.g)} · ${escapeHtml(n.t)}${n.st ? ' · <b class="st-' + n.st + '">' + n.st + '</b>' : ''}</span></div>
          <button class="n-btn" id="nClose" title="Close (Esc)">✕</button></div>
        ${rows ? `<table class="n-dtable">${rows}</table>` : '<p class="n-dim">No extra detail.</p>'}
        <div class="n-dconn"><h4>Connected (${links.length})</h4><div class="n-dlinks">${neigh || '<span class="n-dim">—</span>'}</div></div>`;
      $('#nClose').onclick = closeDetail;
      detail.querySelectorAll('.n-dlinks a').forEach((a) => {
        const go = () => { const o = state.byId.get(a.dataset.id); if (o) selectNode(o); };
        a.onclick = go; a.onkeydown = (e) => { if (e.key === 'Enter') go(); };
      });
      focusNode(n);
      if (state.showLabels) renderLabels();
    }
    function closeDetail() { state.selected = null; detail.classList.add('hidden'); }
    function focusNode(n) {
      const dst = 90 + n.s * 8;
      const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
      controls.target.set(n.x, n.y, n.z);
      animateCam(new THREE.Vector3(n.x, n.y, n.z).addScaledVector(dir, dst));
    }
    let camAnim = null;
    function animateCam(to) { camAnim = { to, t: 0, from: camera.position.clone() }; }

    // ---- search ----
    const search = $('#nSearch');
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      const hotA = pts.geometry.attributes.hot.array;
      if (!q) { state.searchHit = null; for (let i = 0; i < state.nodes.length; i++) if (!state.act[state.nodes[i].id]) hotA[i] = 0; pts.geometry.attributes.hot.needsUpdate = true; return; }
      let best = null;
      state.nodes.forEach((n, i) => { const m = n._search.includes(q); if (m) { hotA[i] = Math.max(hotA[i], 0.8); if (!best || n.s > best.s) best = n; } });
      pts.geometry.attributes.hot.needsUpdate = true;
      state.searchHit = best; if (best) { controls.target.set(best.x, best.y, best.z); animateCam(new THREE.Vector3(best.x, best.y, best.z).add(new THREE.Vector3(0, 0, 120))); }
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && state.searchHit) selectNode(state.searchHit);
      if (e.key === 'Escape') { search.value = ''; search.dispatchEvent(new Event('input')); search.blur(); }
    });

    const setSpin = (on) => { state.spin = on; controls.autoRotate = on; $('#nSpin').classList.toggle('on', on); };
    const toggleLabels = () => { state.showLabels = !state.showLabels; $('#nLabels').classList.toggle('on', state.showLabels); renderLabels(); };
    $('#nReset').onclick = () => { closeDetail(); fitCamera(false); };
    $('#nSpin').onclick = () => setSpin(!state.spin);
    $('#nLabels').onclick = toggleLabels;
    document.addEventListener('keydown', (e) => {
      if (e.target === search || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '/') { e.preventDefault(); search.focus(); search.select(); }
      else if (e.key === 'Escape') closeDetail();
      else if (e.key === 'f') { closeDetail(); fitCamera(false); }
      else if (e.key === 'r') setSpin(!state.spin);
      else if (e.key === 'l') toggleLabels();
    });

    // ---- HTML labels for the biggest nodes ----
    const labelLayer = document.createElement('div'); labelLayer.className = 'n-labels'; wrap.appendChild(labelLayer);
    // Candidates = the biggest visible nodes (+ the selected one). Placement is greedy by size each
    // frame: a label that would overlap one already placed is skipped, so the text never piles up.
    function renderLabels() {
      if (!state.showLabels) { labelLayer.innerHTML = ''; state._labelNodes = []; state._labelEls = null; return; }
      const cand = state.nodes.filter((n) => n.s >= 2.6 && !n._hidden).sort((a, b) => b.s - a.s).slice(0, 140);
      if (state.selected && !cand.includes(state.selected)) cand.unshift(state.selected);
      state._labelNodes = cand;
      labelLayer.innerHTML = cand.map((n) => `<span class="n-lab">${escapeHtml(n.l)}</span>`).join('');
      state._labelEls = [...labelLayer.children];
      state._labelW = cand.map((n) => Math.min(220, String(n.l).length * 6.3 + 10));
    }
    const _lp = new THREE.Vector3();
    function updateLabels() {
      if (!state.showLabels || !state._labelEls) return;
      const w = wrap.clientWidth, h = wrap.clientHeight; const placed = []; let shown = 0;
      const camD = camera.position.distanceTo(controls.target);
      state._labelNodes.forEach((n, i) => {
        const el = state._labelEls[i]; if (!el) return;
        _lp.set(n.x, n.y, n.z).project(camera);
        const x = (_lp.x * 0.5 + 0.5) * w, y = (-_lp.y * 0.5 + 0.5) * h;
        const lw = state._labelW[i], lh = 15;
        const r = { x0: x - lw / 2, x1: x + lw / 2, y0: y - 22, y1: y - 22 + lh };
        const ok = _lp.z < 1 && _lp.z > -1 && x > 0 && x < w && y > 20 && y < h && shown < 55 &&
          !placed.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0);
        if (!ok) { el.style.display = 'none'; return; }
        placed.push(r); shown++;
        const depth = camera.position.distanceTo(_lp.set(n.x, n.y, n.z));
        el.style.display = 'block';
        el.style.opacity = n === state.selected ? 1 : Math.max(0.35, Math.min(0.95, 1.25 - depth / (camD * 2.2)));
        el.style.transform = `translate(${r.x0}px,${r.y0}px)`;
      });
    }

    // ---- live pulse ----
    async function poll() {
      if (document.hidden) return; // background tab: rAF is paused anyway, don't hammer the server
      let p; try { p = await fetchPulse(); } catch (e) { return; }
      state.act = p.act || {}; state.traffic = p.traffic || {};
      const hotA = pts.geometry.attributes.hot.array;
      const q = (search.value || '').trim().toLowerCase();
      state.nodes.forEach((n, i) => {
        let hv = 0;
        const a = state.act[n.id]; if (a) hv = Math.min(1, Math.log2(1 + a) / 7);
        if (q && n._search.includes(q)) hv = Math.max(hv, 0.8);
        hotA[i] = hv;
      });
      pts.geometry.attributes.hot.needsUpdate = true;
      spawnTraffic();
      renderStats(p.host || {});
    }

    function renderStats(h) {
      const cores = (h.cores || []).map((c) => `<b style="height:${Math.max(2, c)}%" title="${c}%"></b>`).join('');
      const cell = (label, val, sub) => `<div class="n-stat"><span>${label}</span><b>${val}</b>${sub ? '<i>' + sub + '</i>' : ''}</div>`;
      $('#nStats').innerHTML =
        cell('CPU', (h.cpu != null ? h.cpu : 0) + '%', `<div class="n-cores">${cores}</div>`) +
        cell('RAM', (h.mem || 0) + '%', fmtBytes(h.memUsed) + ' / ' + fmtBytes(h.memTotal)) +
        cell('Net ↓', fmtRate(h.rx || 0), '↑ ' + fmtRate(h.tx || 0)) +
        cell('Disk', fmtRate((h.diskR || 0) + (h.diskW || 0)), 'read + write') +
        cell('Load', (h.load || [0])[0], '1 min') +
        cell('TCP', h.tcp || 0, (h.procs || 0) + ' processes') +
        (h.redisOps != null ? cell('Redis', h.redisOps + '/s', 'ops') : '') +
        cell('Map', state.nodes.length, state.links.length + ' links');
      const hh = $('.n-top').offsetHeight;
      if (hh !== state._hh) { state._hh = hh; resize(); }
    }

    // one particle per active link, rate ∝ bytes/s, colour of the source
    function spawnTraffic() {
      const byKey = new Map();
      state.links.forEach((l) => { const k = l._a.id + '>' + l._b.id; if (state.traffic[k]) byKey.set(l, state.traffic[k]); });
      state._active = byKey;
    }

    // ---- animation loop ----
    let last = performance.now();
    function frame(now) {
      requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000); last = now;

      // layout: spend a slice of time on the sim until it cools
      if (state.sim && state.sim.alpha() > state.sim.alphaMin()) {
        const t0 = performance.now(); let ticks = 0;
        while (performance.now() - t0 < 6 && state.sim.alpha() > state.sim.alphaMin() && ticks < 8) { state.sim.tick(); ticks++; state.simTicks++; }
        writeNodePositions(); writeLinePositions();
        // keep the growing network framed: snap early, then one smooth re-frame once it has cooled
        if (!state.fit1 && state.simTicks >= 40) { state.fit1 = true; fitCamera(true); }
        if (!state.fit2 && state.sim.alpha() < 0.06) { state.fit2 = true; fitCamera(false); }
      }

      // camera fly-to
      if (camAnim) { camAnim.t = Math.min(1, camAnim.t + dt * 2.2); const e = 1 - Math.pow(1 - camAnim.t, 3); camera.position.lerpVectors(camAnim.from, camAnim.to, e); if (camAnim.t >= 1) camAnim = null; }

      stepParticles(dt);
      controls.update();
      updateLabels();
      composer.render();
    }

    function stepParticles(dt) {
      const geo = particles.geometry; const pa = geo.attributes.position.array, ca = geo.attributes.acolor.array, sa = geo.attributes.size.array, ha = geo.attributes.hot.array, da = geo.attributes.dim.array;
      const PN = state._PN; let count = 0;
      for (let i = 0; i < PN; i++) {
        const d = partData[i]; if (!d) continue;
        d.t += dt * d.sp;
        if (d.t >= 1 || d.a._hidden || d.b._hidden) partData[i] = null;
      }
      // spawn from active links: up to ~6 pulses/s per link, log-scaled on bytes/s (frame-rate independent)
      if (state._active) {
        let cur = state._pCur || 0;
        for (const [l, rate] of state._active) {
          if (l._a._hidden || l._b._hidden) continue;
          const perSec = Math.min(6, Math.log2(1 + rate) / 3);
          if (Math.random() >= perSec * dt) continue;
          let tries = 0; while (partData[cur] && tries++ < PN) cur = (cur + 1) % PN;
          if (partData[cur]) break; // pool full
          partData[cur] = { a: l._a, b: l._b, t: 0, sp: 0.35 + Math.min(1.4, Math.log2(1 + rate) / 20) };
          cur = (cur + 1) % PN;
        }
        state._pCur = cur;
      }
      for (let i = 0; i < PN; i++) {
        const d = partData[i]; if (!d) continue;
        const t = d.t, a = d.a, b = d.b;
        pa[count * 3] = a.x + (b.x - a.x) * t; pa[count * 3 + 1] = a.y + (b.y - a.y) * t; pa[count * 3 + 2] = a.z + (b.z - a.z) * t;
        const c = a._rgb; ca[count * 3] = c[0]; ca[count * 3 + 1] = c[1]; ca[count * 3 + 2] = c[2];
        sa[count] = 3.4; ha[count] = 1; da[count] = 0; count++;
      }
      geo.setDrawRange(0, count);
      geo.attributes.position.needsUpdate = geo.attributes.acolor.needsUpdate = geo.attributes.size.needsUpdate = geo.attributes.hot.needsUpdate = geo.attributes.dim.needsUpdate = true;
    }

    // ---- graph refresh (positions preserved) ----
    async function refreshGraph() {
      if (document.hidden) return;
      let g; try { g = await fetchGraph(); } catch (e) { return; }
      const changed = buildGraph(g);
      state.sim.nodes(state.nodes);
      state.sim.force('link').links(state.links);
      // warm the layout only as much as the network actually changed (nothing new = no motion)
      if (changed) state.sim.alpha(Math.max(state.sim.alpha(), Math.min(0.22, 0.03 + (changed / state.nodes.length) * 4)));
      partData.fill(null);
      buildObjects(); buildLegend(); applyVisibility(); renderLabels(); setHost(g);
    }
    function setHost(g) {
      $('#nHost').innerHTML = escapeHtml(g.host + (g.ip ? '  ·  ' + g.ip : '')) + (g.demo || STATIC_DEMO ? '<span class="n-demo">DEMO</span>' : '');
      document.title = 'Neural Map · ' + g.host;
    }

    // ---- boot ----
    buildGraph(G0);
    initLayout();
    buildObjects();
    buildLegend();
    resize();
    load.classList.add('hidden');
    setHost(G0);

    // finish the layout at once (for slow machines, screenshots and tests)
    function settle() {
      const s = state.sim; let n = 0;
      while (s.alpha() > s.alphaMin() && n < 2000) { s.tick(); n++; }
      state.simTicks += n; state.fit1 = state.fit2 = true;
      writeNodePositions(); writeLinePositions(); fitCamera(true);
      return n;
    }
    if (qs.has('settle')) settle();
    window.__nm = { state, select: selectNode, fit: fitCamera, refresh: refreshGraph, settle, camera, controls, setSpin }; // console debugging
    setInterval(poll, 1500);
    setInterval(refreshGraph, 30000);
    poll();
    requestAnimationFrame(frame);
  }

  main();
})();
