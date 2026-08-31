'use strict';
const fs = require('fs');
const path = require('path');

function configPath(userDataDir) {
  return path.join(userDataDir, 'config.json');
}

function defaults() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config.example.json'), 'utf8'));
}

function load(userDataDir) {
  const p = configPath(userDataDir);
  const base = defaults();
  // A local config.json next to the app wins - handy while developing.
  const local = path.join(__dirname, '..', '..', 'config.json');
  for (const candidate of [local, p]) {
    try {
      if (fs.existsSync(candidate)) {
        return { ...base, ...JSON.parse(fs.readFileSync(candidate, 'utf8')), _path: candidate };
      }
    } catch { /* fall through to defaults */ }
  }
  return { ...base, _path: p };
}

function save(userDataDir, cfg) {
  const p = cfg._path || configPath(userDataDir);
  const { _path, ...rest } = cfg;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(rest, null, 2));
  return p;
}

module.exports = { load, save, defaults, configPath };
