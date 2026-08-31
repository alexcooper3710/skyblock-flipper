'use strict';
const assert = require('assert');
const { decodeItemBytes, readItem, pricingKeys } = require('../src/main/engine/nbt');
const fx = require('./fixtures/real-items.json');

(async () => {
  for (const [label, f] of Object.entries(fx)) {
    const raw = await decodeItemBytes(f.item_bytes);
    const item = readItem(raw);
    const keys = pricingKeys(item);
    console.log(label, JSON.stringify({
      name: item.name, id: item.id, reforge: item.reforge, stars: item.stars,
      recomb: item.recombobulated, hpb: item.hotPotato,
      ench: Object.keys(item.enchantments).length, gems: Object.keys(item.gems).length,
      keys,
    }));
    assert.ok(item.id, `${label}: missing item id`);
    assert.ok(keys.base, `${label}: missing base key`);
    assert.ok(keys.variant, `${label}: missing variant key`);
  }
  console.log('\nPASS: real Hypixel item_bytes decode cleanly');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
