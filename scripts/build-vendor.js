// Bundles three.js (+ the addons the map uses) and d3-force-3d into two browser scripts in
// public/vendor, so the server needs no runtime dependencies and the page loads nothing from a CDN.
// Run after `npm install`:  npm run build:vendor
'use strict';
const path = require('path');
const esbuild = require('esbuild');

const out = path.join(__dirname, '..', 'public', 'vendor');
const common = { bundle: true, minify: true, format: 'iife', target: 'es2020', legalComments: 'none', logLevel: 'info' };

Promise.all([
  esbuild.build(Object.assign({}, common, {
    stdin: {
      contents: `
        import * as THREE from 'three';
        import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
        import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
        import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
        import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
        import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
        self.VNM3 = { THREE, OrbitControls, EffectComposer, RenderPass, UnrealBloomPass, OutputPass };`,
      resolveDir: path.join(__dirname, '..'),
    },
    banner: { js: '/* three.js r170 (MIT) — https://threejs.org — bundled for vps-neural-map */' },
    outfile: path.join(out, 'three.min.js'),
  })),
  esbuild.build(Object.assign({}, common, {
    stdin: { contents: "import * as f from 'd3-force-3d'; self.d3 = f;", resolveDir: path.join(__dirname, '..') },
    banner: { js: '/* d3-force-3d (MIT) — https://github.com/vasturiano/d3-force-3d — bundled for vps-neural-map */' },
    outfile: path.join(out, 'd3-force-3d.min.js'),
  })),
]).catch((e) => { console.error(e); process.exit(1); });
