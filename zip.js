import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n >>> 0, 0);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

export function createZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = String(file.name || "file").replace(/\\/g, "/");
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || "");
    const crc = crc32(data);
    const header = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      data,
    ]);
    const central = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);
    locals.push(header);
    centrals.push(central);
    offset += header.length;
  }

  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralDir, eocd]);
}

function readU16(buf, i) {
  return buf.readUInt16LE(i);
}

function readU32(buf, i) {
  return buf.readUInt32LE(i);
}

export function readZip(buf) {
  const zip = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x05 && zip[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("invalid zip");
  const count = readU16(zip, eocd + 10);
  let offset = readU32(zip, eocd + 16);
  const entries = new Map();

  for (let n = 0; n < count; n += 1) {
    if (readU32(zip, offset) !== 0x02014b50) throw new Error("invalid zip directory");
    const method = readU16(zip, offset + 10);
    const compressed = readU32(zip, offset + 20);
    const uncompressed = readU32(zip, offset + 24);
    const nameLen = readU16(zip, offset + 28);
    const extraLen = readU16(zip, offset + 30);
    const commentLen = readU16(zip, offset + 32);
    const localOff = readU32(zip, offset + 42);
    const name = zip.slice(offset + 46, offset + 46 + nameLen).toString("utf8");
    offset += 46 + nameLen + extraLen + commentLen;

    if (readU32(zip, localOff) !== 0x04034b50) throw new Error("invalid zip local header");
    const localNameLen = readU16(zip, localOff + 26);
    const localExtra = readU16(zip, localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtra;
    const payload = zip.slice(dataStart, dataStart + compressed);
    let data;
    if (method === 0) data = payload;
    else if (method === 8) data = zlib.inflateRawSync(payload);
    else throw new Error(`unsupported zip method ${method}`);
    if (uncompressed && data.length !== uncompressed) {
      data = data.subarray(0, uncompressed);
    }
    if (name.endsWith("/")) continue;
    entries.set(name.replace(/\\/g, "/"), Buffer.from(data));
  }
  return entries;
}
