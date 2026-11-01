// A small PNG reader: enough to read the pixels of a tiny grid the image manipulator saved (a
// wallpaper's colours, for contrast), with no dependency. 8-bit grey, grey+alpha, RGB and RGBA,
// not interlaced: what Android's encoder writes. Anything else throws, and the caller assumes the
// worst (a white photo, dimmed enough).
//
// Inflate (RFC 1951) after puff.c: stored, fixed and dynamic Huffman blocks, decoded a bit at a time,
// which is plenty for a few kilobytes.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman {
  counts: Uint16Array; // codes of each length
  symbols: Uint16Array; // in canonical order
}

function huffman(lengths: ArrayLike<number>): Huffman {
  const counts = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]!]!++;
  counts[0] = 0;
  const offsets = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offsets[len + 1] = offsets[len]! + counts[len]!;
  const symbols = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offsets[lengths[i]!]!++] = i;
  return { counts, symbols };
}

const FIXED = (() => {
  const lit = new Uint8Array(288);
  lit.fill(8, 0, 144);
  lit.fill(9, 144, 256);
  lit.fill(7, 256, 280);
  lit.fill(8, 280, 288);
  return { lit: huffman(lit), dist: huffman(new Uint8Array(30).fill(5)) };
})();

/** Inflate a zlib stream (the 2-byte header is skipped, the checksum not checked). */
export function inflate(zlib: Uint8Array): Uint8Array {
  let pos = 2;
  let bitBuf = 0;
  let bitCount = 0;
  const out: number[] = [];
  const bits = (n: number): number => {
    while (bitCount < n) {
      if (pos >= zlib.length) throw new Error('png: truncated data');
      bitBuf |= zlib[pos++]! << bitCount;
      bitCount += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCount -= n;
    return v;
  };
  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.counts[len]!;
      if (code - count < first) return h.symbols[index + (code - first)]!;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('png: bad code');
  };
  const codes = (lit: Huffman, dist: Huffman) => {
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) out.push(sym);
      else if (sym === 256) return;
      else {
        const i = sym - 257;
        if (i >= 29) throw new Error('png: bad length');
        const len = LEN_BASE[i]! + bits(LEN_EXTRA[i]!);
        const d = decode(dist);
        if (d >= 30) throw new Error('png: bad distance');
        const back = DIST_BASE[d]! + bits(DIST_EXTRA[d]!);
        if (back > out.length) throw new Error('png: distance too far');
        for (let k = 0; k < len; k++) out.push(out[out.length - back]!);
      }
    }
  };
  for (let last = 0; !last; ) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0;
      bitCount = 0; // to the byte boundary
      if (pos + 4 > zlib.length) throw new Error('png: truncated data');
      const len = zlib[pos]! | (zlib[pos + 1]! << 8);
      pos += 4;
      if (pos + len > zlib.length) throw new Error('png: truncated data');
      for (let k = 0; k < len; k++) out.push(zlib[pos++]!);
    } else if (type === 1) codes(FIXED.lit, FIXED.dist);
    else if (type === 2) {
      const nLit = bits(5) + 257;
      const nDist = bits(5) + 1;
      const nCode = bits(4) + 4;
      const lengths = new Uint8Array(19);
      for (let i = 0; i < nCode; i++) lengths[CODE_ORDER[i]!] = bits(3);
      const lencode = huffman(lengths);
      const all = new Uint8Array(nLit + nDist);
      for (let i = 0; i < nLit + nDist; ) {
        const sym = decode(lencode);
        if (sym < 16) all[i++] = sym;
        else {
          let value = 0;
          let n: number;
          if (sym === 16) {
            if (i === 0) throw new Error('png: repeat with nothing before');
            value = all[i - 1]!;
            n = 3 + bits(2);
          } else n = sym === 17 ? 3 + bits(3) : 11 + bits(7);
          if (i + n > all.length) throw new Error('png: too many lengths');
          all.fill(value, i, i + n);
          i += n;
        }
      }
      codes(huffman(all.subarray(0, nLit)), huffman(all.subarray(nLit)));
    } else throw new Error('png: bad block');
  }
  return Uint8Array.from(out);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** A PNG's pixels as sRGB 0..1 (alpha laid over black, as the app draws a photo on its dark background). */
export function decodePng(png: Uint8Array): { width: number; height: number; pixels: [number, number, number][] } {
  const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 8 || SIGNATURE.some((b, i) => png[i] !== b)) throw new Error('png: not a PNG');
  const u32 = (at: number) => ((png[at]! << 24) | (png[at + 1]! << 16) | (png[at + 2]! << 8) | png[at + 3]!) >>> 0;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const len = u32(at);
    const type = String.fromCharCode(png[at + 4]!, png[at + 5]!, png[at + 6]!, png[at + 7]!);
    const body = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = u32(at + 8);
      height = u32(at + 12);
      const depth = body[8];
      channels = CHANNELS[body[9]!] ?? 0;
      if (depth !== 8 || !channels || body[12] !== 0) throw new Error('png: unsupported format');
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (!width || !height || !data.length) throw new Error('png: no image');
  const joined = new Uint8Array(data.reduce((n, d) => n + d.length, 0));
  data.reduce((o, d) => (joined.set(d, o), o + d.length), 0);
  const raw = inflate(joined);
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error('png: short image');
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rows[row + x - channels]! : 0;
      const b = y > 0 ? rows[row - stride + x]! : 0;
      const c = x >= channels && y > 0 ? rows[row - stride + x - channels]! : 0;
      let v = raw[src + x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error('png: bad filter');
      rows[row + x] = v & 255;
    }
  }
  const pixels: [number, number, number][] = [];
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    const grey = channels <= 2;
    const alpha = channels === 2 ? rows[p + 1]! / 255 : channels === 4 ? rows[p + 3]! / 255 : 1;
    const [r, g, b] = grey ? [rows[p]!, rows[p]!, rows[p]!] : [rows[p]!, rows[p + 1]!, rows[p + 2]!];
    pixels.push([(r / 255) * alpha, (g / 255) * alpha, (b / 255) * alpha]);
  }
  return { width, height, pixels };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 (as the image manipulator returns it) to bytes. */
export function base64Bytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let n = 0;
  let acc = 0;
  let bitsHeld = 0;
  for (const ch of clean) {
    acc = ((acc << 6) | B64.indexOf(ch)) & 0xffff; // only the last few bits are ever needed
    bitsHeld += 6;
    if (bitsHeld >= 8) {
      bitsHeld -= 8;
      out[n++] = (acc >> bitsHeld) & 255;
    }
  }
  return out.subarray(0, n);
}
