'use strict';
// item_bytes -> a plain JS object describing the item, plus the pricing keys.
// Hypixel ships items as base64(gzip(NBT)). Everything a flip decision needs
// lives in ExtraAttributes.

const zlib = require('zlib');
const { promisify } = require('util');
const nbt = require('prismarine-nbt');

const gunzip = promisify(zlib.gunzip);

// prismarine-nbt returns tagged values; simplify() strips the tags.
async function decodeItemBytes(itemBytes) {
  if (!itemBytes) return null;
  const raw = Buffer.from(itemBytes, 'base64');
  const plain = await gunzip(raw);
  const { parsed } = await nbt.parse(plain);
  const simple = nbt.simplify(parsed);
  const list = simple.i || simple[''] || [];
  return Array.isArray(list) ? list[0] : list;
}

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
  return {
    base: band ? `${base}:lv${band}` : base,
    variant: band ? `${variantKey(item)}:lv${band}` : variantKey(item),
  };
}

module.exports = { decodeItemBytes, readItem, baseKey, variantKey, pricingKeys, petLevelBand, stripColor, ROMAN };
