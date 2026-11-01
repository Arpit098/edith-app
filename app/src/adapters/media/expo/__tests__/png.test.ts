// The PNG reader against Node's zlib: stored, fixed and dynamic Huffman blocks, every row filter,
// grey/RGB/RGBA; and base64 against Buffer's. (A wallpaper's colour grid is read with it.)

import { constants, deflateSync } from 'zlib';

import { base64Bytes, decodePng, inflate } from '../png';

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, body: Uint8Array | number[]) => [...u32(body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body, 0, 0, 0, 0]; // CRC unchecked

/** Filter each row with `filter(y)` the way an encoder would. */
function filtered(px: number[][], channels: number, filter: (y: number) => number): Uint8Array {
  const stride = px[0]!.length;
  const out: number[] = [];
  for (let y = 0; y < px.length; y++) {
    const f = filter(y);
    out.push(f);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y]![x - channels]! : 0;
      const b = y > 0 ? px[y - 1]![x]! : 0;
      const c = x >= channels && y > 0 ? px[y - 1]![x - channels]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][f]!;
      out.push((px[y]![x]! - pred + 256) & 255);
    }
  }
  return Uint8Array.from(out);
}

function png(width: number, height: number, colourType: number, rows: number[][], filter: (y: number) => number, options: object = {}): Uint8Array {
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType]!;
  const ihdr = [...u32(width), ...u32(height), 8, colourType, 0, 0, 0];
  const idat = deflateSync(filtered(rows, channels, filter), options);
  const half = Math.floor(idat.length / 2); // two IDAT chunks, as encoders may write
  return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', ihdr), ...chunk('IDAT', idat.subarray(0, half)), ...chunk('IDAT', idat.subarray(half)), ...chunk('IEND', [])]);
}

/** A 12×24 picture with structure (gradients, edges), as rows of channel bytes. */
function picture(channels: number): number[][] {
  return Array.from({ length: 24 }, (_, y) => Array.from({ length: 12 * channels }, (_, i) => {
    const x = Math.floor(i / channels);
    const ch = i % channels;
    return ch === 3 ? 255 : (x * 21 + y * 7 * (ch + 1) + (x > 6 ? 90 : 0)) & 255;
  }));
}

describe('inflate', () => {
  const text = Buffer.from('EDITH '.repeat(400) + Array.from({ length: 3000 }, (_, i) => String.fromCharCode(32 + ((i * 7919) % 90))).join(''));
  it.each([
    ['stored', { level: 0 }],
    ['fixed Huffman', { strategy: constants.Z_FIXED }],
    ['dynamic Huffman', { level: 9 }],
    ['fast', { level: 1 }],
  ])('%s blocks', (_, options) => {
    expect(Buffer.from(inflate(deflateSync(text, options))).equals(text)).toBe(true);
  });
  it('throws on cut-off data instead of hanging', () => {
    const z = deflateSync(text);
    expect(() => inflate(z.subarray(0, z.length / 2))).toThrow(/png:/);
  });
});

describe('decodePng', () => {
  it.each([0, 1, 2, 3, 4])('reads RGB with filter %i on every row', (f) => {
    const rows = picture(3);
    const { width, height, pixels } = decodePng(png(12, 24, 2, rows, () => f));
    expect([width, height, pixels.length]).toEqual([12, 24, 288]);
    pixels.forEach((p, i) => {
      const y = Math.floor(i / 12);
      const x = i % 12;
      expect(p.map((v) => Math.round(v * 255))).toEqual(rows[y]!.slice(x * 3, x * 3 + 3));
    });
  });

  it('reads RGBA (over black), grey and grey+alpha, with the filters mixed and fixed codes', () => {
    const rgba = picture(4);
    rgba[0]![3] = 0; // one transparent pixel
    const a = decodePng(png(12, 24, 6, rgba, (y) => y % 5, { strategy: constants.Z_FIXED }));
    expect(a.pixels[0]).toEqual([0, 0, 0]);
    expect(a.pixels[1]!.map((v) => Math.round(v * 255))).toEqual(rgba[0]!.slice(4, 7));
    const grey = decodePng(png(12, 24, 0, picture(1), (y) => (y * 3) % 5));
    expect(grey.pixels[5]![0]).toBe(grey.pixels[5]![2]);
    expect(Math.round(grey.pixels[5]![0] * 255)).toBe(picture(1)[0]![5]);
    const ga = decodePng(png(2, 1, 4, [[200, 255, 100, 0]], () => 0));
    expect(ga.pixels.map((p) => p.map((v) => Math.round(v * 255)))).toEqual([[200, 200, 200], [0, 0, 0]]);
  });

  it('refuses what it can’t read (the caller then assumes a white photo)', () => {
    expect(() => decodePng(Uint8Array.from([1, 2, 3]))).toThrow(/not a PNG/);
    const sixteen = png(1, 1, 2, [[1, 2, 3]], () => 0);
    sixteen[8 + 8 + 8] = 16; // bit depth 16
    expect(() => decodePng(sixteen)).toThrow(/unsupported/);
  });
});

describe('base64Bytes', () => {
  it('matches Buffer, with and without padding', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100, 257]) {
      const bytes = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255));
      expect(Buffer.from(base64Bytes(bytes.toString('base64'))).equals(bytes)).toBe(true);
      expect(Buffer.from(base64Bytes(bytes.toString('base64').replace(/=+$/, ''))).equals(bytes)).toBe(true);
    }
    expect(Buffer.from(base64Bytes('SGVs\nbG8=')).toString()).toBe('Hello'); // line breaks ignored
  });
});
