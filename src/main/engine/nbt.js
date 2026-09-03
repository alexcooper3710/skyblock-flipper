'use strict';
// item_bytes -> a plain JS object describing the item, plus the pricing keys.
// Hypixel ships items as base64(gzip(NBT)). Everything a flip decision needs
// lives in ExtraAttributes.

const zlib = require('zlib');
const { promisify } = require('util');
const nbt = require('prismarine-nbt');
const keys = require('./itemkeys');

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


module.exports = { decodeItemBytes, ...keys };
