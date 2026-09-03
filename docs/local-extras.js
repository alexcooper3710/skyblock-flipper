// Local-mode extras: the API key lives in this browser, and history can be
// written to a real file you choose. Nothing leaves the machine - GitHub Pages
// only ever serves the static files.
document.getElementById('keybtn').onclick = () => {
  const cur = localStorage.getItem('hypixelKey') || '';
  const v = prompt('Hypixel API key (optional - the auction and bazaar endpoints are public).\nStored only in this browser.', cur);
  if (v === null) return;
  localStorage.setItem('hypixelKey', v.trim());
  location.reload();
};

document.getElementById('exportbtn').onclick = async () => {
  const data = await window.__store.exportAll();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `skyblock-terminal-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

document.getElementById('importbtn').onclick = () => document.getElementById('importfile').click();
document.getElementById('importfile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  await window.__store.importAll(JSON.parse(await f.text()));
  location.reload();
};
