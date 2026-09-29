// Sanity check of the demo graph: unique ids, every link and parent resolves, pulse keys match links.
'use strict';
const assert = require('assert');
const demo = require('../public/demo.js');

const g = demo.graph();
const ids = new Set();
for (const n of g.nodes) { assert(!ids.has(n.id), 'duplicate node ' + n.id); ids.add(n.id); }
for (const n of g.nodes) if (n.id !== 'host') assert(ids.has(n.p), 'dangling parent ' + n.p + ' of ' + n.id);
const linkKeys = new Set();
for (const l of g.links) { assert(ids.has(l.a) && ids.has(l.b), 'dangling link ' + l.a + '>' + l.b); linkKeys.add(l.a + '>' + l.b); }
demo.pulse();
const p = demo.pulse();
for (const k of Object.keys(p.traffic)) assert(linkKeys.has(k), 'pulse traffic on unknown link ' + k);
for (const k of Object.keys(p.act)) assert(ids.has(k), 'pulse activity on unknown node ' + k);
console.log(`demo ok: ${g.nodes.length} nodes, ${g.links.length} links, layers ${Object.keys(g.layers).join(' ')}`);
