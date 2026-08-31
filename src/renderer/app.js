'use strict';
const $ = (id) => document.getElementById(id);

const fmt = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'b';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'm';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
};

let flips = [];
let cfg = null;

// --- tabs -------------------------------------------------------------------
document.querySelectorAll('nav button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('nav button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    ['flips', 'bazaar', 'settings', 'log'].forEach(t => {
      $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab);
    });
  };
});

// --- flip feed --------------------------------------------------------------
function renderFlips() {
  const host = $('flips');
  $('flips-empty').classList.toggle('hidden', flips.length > 0);
  host.innerHTML = '';
  flips.slice(0, 60).forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="key">${i < 5 ? i + 1 : ''}</div>
      <div><div class="nm"></div><div class="sub"></div></div>
      <div class="num">${fmt(f.price)}</div>
      <div class="num">${fmt(f.value)}</div>
      <div class="num profit">+${fmt(f.profit)}<div class="sub">${f.marginPct}%</div></div>
      <div><span class="badge ${f.strategy}">${f.strategy}</span></div>`;
    // textContent, not innerHTML - item names come off the wire
    row.querySelector('.nm').textContent = f.name;
    row.querySelector('.sub').textContent = `${f.basis} · ${f.samples} samples`;
    row.onclick = async () => {
      await window.flipper.copy(f.command);
      row.classList.add('copied');
    };
    host.appendChild(row);
  });
}

window.flipper.on('flips', (batch) => {
  flips = [...batch, ...flips].slice(0, 200);
  renderFlips();
  if (cfg && cfg.sound && batch.length) beep();
});

// --- bazaar -----------------------------------------------------------------
window.flipper.on('bazaar', (b) => {
  const rows = [...b.orders, ...b.crafts].sort((x, y) => y.profit - x.profit).slice(0, 60);
  $('bazaar-empty').classList.toggle('hidden', rows.length > 0);
  const host = $('bazaar');
  host.innerHTML = '';
  rows.forEach(r => {
    const el = document.createElement('div');
    el.className = 'row';
    const isCraft = r.kind === 'bazaar-craft';
    el.innerHTML = `
      <div class="key"></div>
      <div><div class="nm"></div><div class="sub"></div></div>
      <div class="num">${fmt(isCraft ? r.costPerCraft : r.buyAt)}</div>
      <div class="num">${fmt(isCraft ? r.revenuePerCraft : r.sellAt)}</div>
      <div class="num profit">+${fmt(r.profit)}<div class="sub">${isCraft ? r.marginPct : r.spreadPct}%</div></div>
      <div><span class="badge ${isCraft ? 'attribute' : 'lowest-bin'}">${isCraft ? 'craft' : 'order'}</span></div>`;
    el.querySelector('.nm').textContent = r.id;
    el.querySelector('.sub').textContent = isCraft
      ? `${r.qty}x ${r.input} -> 1  ·  ${r.crafts} crafts/hr`
      : `${r.units} units/hr  ·  ${fmt(r.weeklyVolume)} weekly vol`;
    el.onclick = () => window.flipper.copy(r.id);
    host.appendChild(el);
  });
});

// --- stats / logs -----------------------------------------------------------
window.flipper.on('stats', (s) => {
  $('dot').classList.add('live');
  $('s-snap').textContent = s.snapshots;
  $('s-auc').textContent = fmt(s.totalAuctions);
  $('s-cycle').textContent = (s.lastCycleMs / 1000).toFixed(1) + 's';
  $('s-sold').textContent = fmt(s.book.soldSamples);
  $('warmup').classList.toggle('hidden', !!s.warmedUp);
});

window.flipper.on('log', (l) => {
  const d = document.createElement('div');
  d.textContent = `[${new Date(l.at).toLocaleTimeString()}] ${l.level.toUpperCase()} ${l.msg}` +
    (l.extra ? ' ' + JSON.stringify(l.extra) : '');
  $('logs').prepend(d);
  while ($('logs').childNodes.length > 300) $('logs').lastChild.remove();
});

window.flipper.on('copied', ({ index }) => {
  const row = $('flips').children[index];
  if (row) row.classList.add('copied');
});

// --- settings ---------------------------------------------------------------
function fillSettings(c) {
  cfg = c;
  $('c-apiKey').value = c.apiKey || '';
  for (const k of ['maxBudget', 'minProfit', 'minMarginPct', 'minSampleSize', 'soldWindowMinutes', 'pageConcurrency']) {
    $('c-' + k).value = c[k];
  }
  $('c-bzVolume').value = c.bazaar.minWeeklyVolume;
  $('c-bzSpread').value = c.bazaar.minSpreadPct;
  $('c-bzProfit').value = c.bazaar.minProfitPerFlip;
  for (const k of ['lowestBinSnipe', 'soldMedian', 'attributeAware', 'bazaarAndCraft']) {
    $('c-' + k).checked = !!c.strategies[k];
  }
  $('c-sound').checked = !!c.sound;
}

window.flipper.on('config', fillSettings);
window.flipper.getConfig().then(fillSettings);

$('save').onclick = async () => {
  const patch = {
    apiKey: $('c-apiKey').value.trim(),
    sound: $('c-sound').checked,
    strategies: {
      lowestBinSnipe: $('c-lowestBinSnipe').checked,
      soldMedian: $('c-soldMedian').checked,
      attributeAware: $('c-attributeAware').checked,
      bazaarAndCraft: $('c-bazaarAndCraft').checked,
    },
    bazaar: {
      ...cfg.bazaar,
      minWeeklyVolume: Number($('c-bzVolume').value),
      minSpreadPct: Number($('c-bzSpread').value),
      minProfitPerFlip: Number($('c-bzProfit').value),
    },
  };
  for (const k of ['maxBudget', 'minProfit', 'minMarginPct', 'minSampleSize', 'soldWindowMinutes', 'pageConcurrency']) {
    patch[k] = Number($('c-' + k).value);
  }
  cfg = await window.flipper.setConfig(patch);
  await window.flipper.restart();
  flips = []; renderFlips();
};

// --- a short blip, no asset file needed -------------------------------------
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; o.type = 'sine';
    g.gain.setValueAtTime(0.08, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.18);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.19);
  } catch { /* audio is optional */ }
}
