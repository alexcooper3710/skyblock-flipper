'use strict';
// The pricing / strategy / bazaar logic must not exist twice. These modules are
// pure (no fs, no net, no node built-ins), so they are mechanically converted
// from CommonJS to ESM into docs/ at build time. One source of truth; the web
// build can never silently drift from the server build.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'main', 'engine');
const OUT = path.join(__dirname, '..', 'docs', 'shared');
const MODULES = ['itemkeys.js', 'pricing.js', 'strategies.js', 'bazaar.js'];

function toEsm(code, file) {
  let out = code.replace(/^'use strict';\n/, '');
  // JSON first: the generic require rule below would otherwise rewrite
  // require('./craft-ratios.json') into an import of './craft-ratios.json.js'.
  out = out.replace(/const (\w+) = require\('\.\/([\w-]+)\.json'\);\n/g, (_, name, mod) => {
    const json = fs.readFileSync(path.join(SRC, mod + '.json'), 'utf8');
    return `const ${name} = ${json};\n`;
  });
  // require('./x') -> import { ... } from './x.js'  (collected, then emitted)
  const imports = [];
  out = out.replace(/const \{([^}]+)\} = require\('\.\/([^']+)'\);\n/g, (_, names, mod) => {
    imports.push(`import {${names}} from './${mod}.js';`);
    return '';
  });
  out = out.replace(/const (\w+) = require\('\.\/([^']+)'\);\n/g, (_, name, mod) => {
    imports.push(`import ${name} from './${mod}.js';`);
    return '';
  });
  out = out.replace(/module\.exports = \{([^}]+)\};?\s*$/m, (_, names) => `export {${names}};`);
  if (/module\.exports/.test(out)) throw new Error(`${file}: unconverted module.exports`);
  if (/require\(/.test(out)) throw new Error(`${file}: unconverted require()`);
  return `// GENERATED from src/main/engine/${file} by scripts/build-web.js - do not edit.\n`
    + imports.join('\n') + (imports.length ? '\n' : '') + out;
}

fs.mkdirSync(OUT, { recursive: true });
for (const m of MODULES) {
  const code = fs.readFileSync(path.join(SRC, m), 'utf8');
  fs.writeFileSync(path.join(OUT, m), toEsm(code, m));
  console.log('built docs/shared/' + m);
}

// The UI now lives in docs/ only - one copy, no fork to drift. The server build
// serves the same files; it just needs an index that does NOT load local-api.js,
// because it has a real server to talk to instead of an engine in the tab.
const DOCS = path.join(__dirname, '..', 'docs');
const index = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
const serverIndex = index.replace(/^.*<script type="module" src="local-(api|extras)\.js"><\/script>\n?/gm, '');
if (serverIndex === index) throw new Error('index.html: expected local-api/local-extras script tags to strip');
fs.writeFileSync(path.join(DOCS, 'index.server.html'),
  serverIndex.replace('<head>', '<head>\n<!-- GENERATED from index.html by scripts/build-web.js - do not edit. -->'));
console.log('built docs/index.server.html');

// --- build stamp -----------------------------------------------------------
// GitHub Pages serves JS and CSS with max-age=600, so for ten minutes after a
// push a plain reload can hand you a MIX: a fresh index.html next to a stale
// panels.js. With ES modules that is worse than being wholly out of date, and
// from the outside it just looks like the deploy did not work.
//
// index.html revalidates, so it is the one file that can be trusted to be
// current. Stamp the build id into it and into app.js: if the two disagree, the
// browser is holding a cached copy of the code and the page says so instead of
// leaving you to wonder.
const crypto = require('crypto');
const stampFiles = fs.readdirSync(DOCS)
  .filter(f => f.endsWith('.js') || f === 'styles.css')
  .sort();
const hash = crypto.createHash('sha256');
for (const f of stampFiles) {
  // The stamp lines themselves are excluded, or the hash could never settle.
  hash.update(f);
  hash.update(fs.readFileSync(path.join(DOCS, f), 'utf8').replace(/^const BUILD = '[^']*';$/m, ''));
}
for (const f of fs.readdirSync(path.join(DOCS, 'shared')).sort()) {
  hash.update(fs.readFileSync(path.join(DOCS, 'shared', f), 'utf8'));
}
const BUILD = hash.digest('hex').slice(0, 8);

const stamp = (file, re, make) => {
  const full = path.join(DOCS, file);
  const before = fs.readFileSync(full, 'utf8');
  const after = re.test(before) ? before.replace(re, make) : null;
  if (after == null) throw new Error(`${file}: no build stamp to replace`);
  if (after !== before) fs.writeFileSync(full, after);
};
stamp('index.html', /<meta name="build" content="[^"]*">/, `<meta name="build" content="${BUILD}">`);
stamp('index.server.html', /<meta name="build" content="[^"]*">/, `<meta name="build" content="${BUILD}">`);
stamp('app.js', /^const BUILD = '[^']*';$/m, `const BUILD = '${BUILD}';`);
console.log('stamped build ' + BUILD);
