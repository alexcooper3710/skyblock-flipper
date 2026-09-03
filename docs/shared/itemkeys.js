// GENERATED from src/main/engine/itemkeys.js by scripts/build-web.js - do not edit.
// Pure item -> pricing-key logic. No zlib, no NBT library, no node built-ins,
// so scripts/build-web.js can hand the identical code to the browser build.

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const stripColor = (s) => String(s || '').replace(/§./g, '');

function readItem(raw) {
  if (!raw) return null;
  const tag = raw.tag || {};
  const ea = tag.ExtraAttributes || {};
  const display = tag.display || {};

  let petInfo = null;
  if (ea.petInfo) {
    try { petInfo = typeof ea.petInfo === 'string' ? JSON.parse(ea.petInfo) : ea.petInfo; } catch { petInfo = null; }
  }

  const enchantments = ea.enchantments && typeof ea.enchantments === 'object' ? ea.enchantments : {};
  const attributes = ea.attributes && typeof ea.attributes === 'object' ? ea.attributes : {};
  const gems = ea.gems && typeof ea.gems === 'object' ? ea.gems : {};

  return {
    id: ea.id || null,
    name: stripColor(display.Name),
    lore: (display.Lore || []).map(stripColor),
    count: raw.Count || 1,
    reforge: ea.modifier || null,
    recombobulated: Number(ea.rarity_upgrades || 0) > 0,
    hotPotato: Number(ea.hot_potato_count || 0),
    stars: Number(ea.upgrade_level ?? ea.dungeon_item_level ?? 0),
    enchantments,
    attributes,
    gems,
    runes: ea.runes || null,
    skin: ea.skin || null,
    abilityScroll: Array.isArray(ea.ability_scroll) ? [...ea.ability_scroll].sort() : null,
    artOfWar: Number(ea.art_of_war_count || 0),
    artOfPeace: Number(ea.artOfPeaceApplied || 0),
    woodSingularity: Number(ea.wood_singularity_count || 0),
    tunedTransmission: Number(ea.tuned_transmission || 0),
    enrichment: ea.talisman_enrichment || null,
    petInfo,
    // A drill/pickaxe part or a dye changes value a lot; keep the raw bag around.
    extra: ea,
  };
}

// --- pricing keys -----------------------------------------------------------
// baseKey  = "what item is this" (coarse, always has samples)
// variantKey = baseKey + everything that moves the price (sparse but accurate)

function baseKey(item) {
  if (!item || !item.id) return null;
  if (item.id === 'PET' && item.petInfo) {
    return `PET:${item.petInfo.type}:${item.petInfo.tier}`;
  }
  if (item.id === 'ENCHANTED_BOOK') {
    const names = Object.keys(item.enchantments);
    if (names.length === 1) {
      const n = names[0];
      return `BOOK:${n.toUpperCase()}:${item.enchantments[n]}`;
    }
    if (names.length > 1) return 'ENCHANTED_BOOK_MULTI';
    return 'ENCHANTED_BOOK';
  }
  if (item.id === 'RUNE' || item.id === 'UNIQUE_RUNE') {
    const runes = item.runes || {};
    const n = Object.keys(runes)[0];
    if (n) return `RUNE:${n}:${runes[n]}`;
  }
  if (item.id === 'ATTRIBUTE_SHARD') {
    const n = Object.keys(item.attributes)[0];
    if (n) return `SHARD:${n}:${item.attributes[n]}`;
  }
  return item.id;
}

// The two highest attributes are what the Kuudra/equipment market actually
// prices on; a god-roll pair is worth many times a single.
function attributePart(item) {
  const entries = Object.entries(item.attributes || {});
  if (!entries.length) return '';
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ':' + entries.slice(0, 2).map(([k, v]) => `${k}${v}`).join('+');
}

// Enchantments are the single biggest thing this used to miss. A clean
// Terminator and one with Snipe V / Ultimate Wise V are different items with
// very different prices, and pooling them made every clean copy look like a
// flip against the enchanted wall. Full sorted signature: it is only ever a
// Map key, so length costs nothing, and being exact is the entire point.
function enchantPart(item) {
  const e = Object.entries(item.enchantments || {});
  if (!e.length) return '';
  e.sort((a, b) => a[0].localeCompare(b[0]));
  return 'e:' + e.map(([k, v]) => `${k}${v}`).join(',');
}

// Gemstones: quality is what moves the price, slot position does not.
// ea.gems mixes "JASPER_0": "PERFECT" with "JASPER_0_gem": "JASPER" and an
// unlocked_slots array, so read only the quality entries.
function gemPart(item) {
  const g = item.gems || {};
  const counts = {};
  for (const [k, v] of Object.entries(g)) {
    if (k === 'unlocked_slots' || k.endsWith('_gem')) continue;
    const q = typeof v === 'string' ? v : (v && v.quality) || null;
    if (q) counts[q] = (counts[q] || 0) + 1;
  }
  const keys = Object.keys(counts).sort();
  if (!keys.length) return '';
  return 'g:' + keys.map(q => `${q}${counts[q]}`).join(',');
}

// Does this item carry anything that moves its price away from a stock copy?
// If it does, comparing it to the base-level wall is meaningless: that wall is
// a mix of clean and kitted copies. Strategies use this to refuse to fire
// rather than to fire against a number they cannot justify.
function isPlain(item) {
  if (!item) return false;
  if (Object.keys(item.enchantments || {}).length) return false;
  if (Object.keys(item.attributes || {}).length) return false;
  if (gemPart(item)) return false;
  if (item.stars || item.recombobulated || item.hotPotato) return false;
  if (item.abilityScroll && item.abilityScroll.length) return false;
  if (item.artOfWar || item.artOfPeace || item.woodSingularity || item.tunedTransmission) return false;
  if (item.enrichment || item.skin) return false;
  if (item.petInfo && (item.petInfo.heldItem || item.petInfo.skin)) return false;
  return true;
}

function variantKey(item) {
  const base = baseKey(item);
  if (!base) return null;
  const bits = [base];
  if (item.stars) bits.push(`s${item.stars}`);
  if (item.recombobulated) bits.push('rec');
  if (item.hotPotato) bits.push(`hpb${item.hotPotato}`);
  if (item.abilityScroll && item.abilityScroll.length) bits.push(`sc${item.abilityScroll.length}`);
  if (item.artOfWar) bits.push('aow');
  if (item.artOfPeace) bits.push('aop');
  if (item.woodSingularity) bits.push('wood');
  if (item.tunedTransmission) bits.push(`tt${item.tunedTransmission}`);
  if (item.enrichment) bits.push(`enr`);
  if (item.petInfo && item.petInfo.heldItem) bits.push(`held:${item.petInfo.heldItem}`);
  if (item.petInfo && item.petInfo.skin) bits.push('petskin');
  if (item.skin) bits.push(`skin:${item.skin}`);
  const attr = attributePart(item);
  if (attr) bits.push(attr.slice(1));
  const ench = enchantPart(item);
  if (ench) bits.push(ench);
  const gem = gemPart(item);
  if (gem) bits.push(gem);
  // A stock copy gets its own marker rather than collapsing onto the base key.
  // Otherwise the base bucket - which by design holds every copy, kitted ones
  // included - doubles as the stock bucket, and a plain item ends up priced
  // against a wall of recombobulated and enchanted copies. That reads as a
  // discount that is not there, which is the other half of why the auction
  // numbers were wrong.
  if (bits.length === 1) bits.push('stock');
  return bits.join('|');
}

// Pets are priced in level bands, not by raw exp.
function petLevelBand(item) {
  if (!item || !item.petInfo) return null;
  const exp = Number(item.petInfo.exp || 0);
  if (exp >= 25353230) return '100';
  if (exp >= 5624785) return '80+';
  if (exp >= 887205) return '50+';
  return 'low';
}

function pricingKeys(item) {
  const base = baseKey(item);
  if (!base) return null;
  const band = petLevelBand(item);
  const stock = `${base}|stock`;
  return {
    // base    - every copy of the item, however kitted. Coarse on purpose:
    //           it is what the charts, search and watchlist group by.
    // variant - exactly this configuration. The only honest thing to price
    //           against, and for a stock copy that means `stock`.
    base: band ? `${base}:lv${band}` : base,
    variant: band ? `${variantKey(item)}:lv${band}` : variantKey(item),
    stock: band ? `${stock}:lv${band}` : stock,
    plain: isPlain(item),
  };
}

export { readItem, baseKey, variantKey, pricingKeys, petLevelBand, stripColor, ROMAN, isPlain, enchantPart, gemPart };