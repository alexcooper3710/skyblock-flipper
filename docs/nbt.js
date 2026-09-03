// Minimal NBT reader. No dependencies, no Node built-ins - the same file runs in
// the browser and under node, so the parser can be tested where prismarine-nbt
// runs and then shipped where it cannot.
const TAG = { END:0, BYTE:1, SHORT:2, INT:3, LONG:4, FLOAT:5, DOUBLE:6,
  BYTE_ARRAY:7, STRING:8, LIST:9, COMPOUND:10, INT_ARRAY:11, LONG_ARRAY:12 };

export function parseNBT(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const u8 = () => dv.getUint8(o++);
  const i8 = () => dv.getInt8(o++);
  const i16 = () => { const v = dv.getInt16(o); o += 2; return v; };
  const i32 = () => { const v = dv.getInt32(o); o += 4; return v; };
  const i64 = () => { const v = dv.getBigInt64(o); o += 8; return Number(v); };
  const f32 = () => { const v = dv.getFloat32(o); o += 4; return v; };
  const f64 = () => { const v = dv.getFloat64(o); o += 8; return v; };
  const str = () => {
    const len = dv.getUint16(o); o += 2;
    // Minecraft writes modified UTF-8; latin1 is wrong for exotic names but
    // ExtraAttributes ids and enchant keys are ASCII, which is what we read.
    const s = new TextDecoder('utf-8').decode(new Uint8Array(bytes.buffer, bytes.byteOffset + o, len));
    o += len; return s;
  };

  function payload(type) {
    switch (type) {
      case TAG.BYTE: return i8();
      case TAG.SHORT: return i16();
      case TAG.INT: return i32();
      case TAG.LONG: return i64();
      case TAG.FLOAT: return f32();
      case TAG.DOUBLE: return f64();
      case TAG.BYTE_ARRAY: { const n = i32(); const a = new Int8Array(bytes.buffer, bytes.byteOffset + o, n); o += n; return a; }
      case TAG.STRING: return str();
      case TAG.LIST: {
        const t = u8(); const n = i32(); const a = [];
        for (let k = 0; k < n; k++) a.push(payload(t));
        return a;
      }
      case TAG.COMPOUND: {
        const obj = {};
        for (;;) {
          const t = u8();
          if (t === TAG.END) break;
          obj[str()] = payload(t);
        }
        return obj;
      }
      case TAG.INT_ARRAY: { const n = i32(); const a = []; for (let k = 0; k < n; k++) a.push(i32()); return a; }
      case TAG.LONG_ARRAY: { const n = i32(); const a = []; for (let k = 0; k < n; k++) a.push(i64()); return a; }
      default: throw new Error('unknown NBT tag ' + type);
    }
  }

  const rootType = u8();
  if (rootType !== TAG.COMPOUND) throw new Error('expected a compound root, got ' + rootType);
  str();                        // root name, always empty in practice
  return payload(TAG.COMPOUND);
}

const b64 = (s) => {
  const bin = typeof atob === 'function'
    ? atob(s)
    : Buffer.from(s, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function gunzip(u8) {
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const zlib = await import('node:zlib');
  return new Uint8Array(zlib.gunzipSync(u8));
}

export async function decodeItemBytes(itemBytes) {
  if (!itemBytes) return null;
  const raw = await gunzip(b64(itemBytes));
  const root = parseNBT(raw);
  const list = root.i || root[''] || [];
  return Array.isArray(list) ? list[0] : list;
}
