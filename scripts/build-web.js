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

// The UI is identical in both builds; copy rather than fork it.
const WEB = path.join(__dirname, '..', 'src', 'web');
const DOCS = path.join(__dirname, '..', 'docs');
for (const f of ['styles.css', 'app.js']) {
  fs.copyFileSync(path.join(WEB, f), path.join(DOCS, f));
  console.log('copied docs/' + f);
}
