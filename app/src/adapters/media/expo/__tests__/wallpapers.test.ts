// The wallpaper adapter over fake Expo modules: the gallery only (no permission asked), a JPEG at
// most 1440 px on the long side at 0.8 kept in documents/wallpapers/, the colour grid read back,
// the picker's copy deleted, and deleting/pruning only ever inside wallpapers/.

import { deflateSync } from 'zlib';

const mockDisk = new Set<string>();
const mockDocs = 'file:///data/user/0/app/files';
const mockCache = 'file:///data/user/0/app/cache';

jest.mock('expo-file-system', () => {
  const at = (parent: { uri: string } | string, name?: string) => {
    const base = typeof parent === 'string' ? parent : parent.uri;
    return name ? `${base}/${name}` : base;
  };
  class File {
    uri: string;
    constructor(parent: { uri: string } | string, name?: string) {
      this.uri = at(parent, name);
    }
    get exists() {
      return mockDisk.has(this.uri);
    }
    delete() {
      mockDisk.delete(this.uri);
    }
    moveSync(to: File) {
      mockDisk.delete(this.uri);
      mockDisk.add(to.uri);
    }
  }
  class Directory {
    uri: string;
    constructor(parent: { uri: string } | string, name?: string) {
      this.uri = at(parent, name);
    }
    get exists() {
      return [...mockDisk].some((f) => f.startsWith(`${this.uri}/`));
    }
    create() {
      mockDisk.add(`${this.uri}/`);
    }
    list() {
      return [...mockDisk].filter((f) => f.startsWith(`${this.uri}/`) && f !== `${this.uri}/` && !f.slice(this.uri.length + 1).includes('/')).map((f) => new File(f));
    }
  }
  // Literal paths: jest.mock is hoisted above the constants.
  return { Directory, File, Paths: { document: new Directory('file:///data/user/0/app/files'), cache: new Directory('file:///data/user/0/app/cache') } };
});
jest.mock('expo-document-picker', () => ({})); // the media adapter's, not used here

jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn(), requestMediaLibraryPermissionsAsync: jest.fn(), requestCameraPermissionsAsync: jest.fn(), launchCameraAsync: jest.fn() }));
const mockPicker = jest.requireMock<Record<'launchImageLibraryAsync' | 'requestMediaLibraryPermissionsAsync' | 'requestCameraPermissionsAsync', jest.Mock>>('expo-image-picker');

const mockState = { resize: [] as object[], saves: [] as object[], grid: '', n: 0 };
jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
  ImageManipulator: {
    manipulate: (uri: string) => {
      let size = uri.includes('small') ? { width: 800, height: 600 } : { width: 3000, height: 4000 };
      const ctx = {
        resize(s: { width?: number; height?: number }) {
          mockState.resize.push(s);
          size = { width: s.width ?? Math.round((size.width * s.height!) / size.height), height: s.height ?? Math.round((size.height * s.width!) / size.width) };
          return ctx;
        },
        renderAsync: async () => ({
          ...size,
          release: () => {},
          saveAsync: async (o: { format: string; base64?: boolean }) => {
            mockState.saves.push(o);
            const out = `${mockCache}/ImageManipulator/${++mockState.n}.${o.format === 'png' ? 'png' : 'jpg'}`;
            mockDisk.add(out);
            return { uri: out, ...size, base64: o.base64 ? mockState.grid : undefined };
          },
        }),
        release: () => {},
      };
      return ctx;
    },
  },
}));

import { createExpoWallpapers } from '../wallpapers';

/** A 12×24 PNG, all one colour, as base64. */
function solidPng(rgb: [number, number, number]): string {
  const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const chunk = (type: string, body: number[] | Buffer) => [...u32(body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body, 0, 0, 0, 0];
  const raw = Array.from({ length: 24 }, () => [0, ...Array.from({ length: 12 }, () => rgb).flat()]).flat();
  const bytes = [137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', [...u32(12), ...u32(24), 8, 2, 0, 0, 0]), ...chunk('IDAT', deflateSync(Buffer.from(raw))), ...chunk('IEND', [])];
  return Buffer.from(bytes).toString('base64');
}

const files = () => [...mockDisk].filter((f) => !f.endsWith('/'));

beforeEach(() => {
  mockDisk.clear();
  mockState.resize = [];
  mockState.saves = [];
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('wallpapers', () => {
  it('picks from the gallery with no permission asked, keeps a 1440 px JPEG at 0.8 in documents/wallpapers, reads its colours', async () => {
    const original = `${mockCache}/ImagePicker/pick.jpg`;
    mockDisk.add(original);
    mockPicker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ uri: original, width: 3000, height: 4000 }] });
    mockState.grid = solidPng([255, 128, 0]);
    const got = await createExpoWallpapers()!.pick();
    expect(mockPicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    expect(mockPicker.requestCameraPermissionsAsync).not.toHaveBeenCalled();
    expect(mockPicker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({ mediaTypes: 'images', exif: false }));
    expect(mockState.resize[0]).toEqual({ height: 1440 }); // the long edge
    expect(mockState.saves[0]).toEqual({ format: 'jpeg', compress: 0.8 });
    expect(mockState.resize[1]).toEqual({ width: 12, height: 24 });
    expect(got!.uri.startsWith(`${mockDocs}/wallpapers/`)).toBe(true);
    expect([got!.width, got!.height]).toEqual([1080, 1440]);
    expect(got!.grid).toHaveLength(288);
    expect(got!.grid[0]!.map((v) => Math.round(v * 255))).toEqual([255, 128, 0]);
    // Only the kept JPEG is left: the picker's copy and the grid's PNG are gone.
    expect(files()).toEqual([got!.uri]);
  });

  it('a grid it can’t read comes back empty (the theme then assumes a white photo); the photo is still kept', async () => {
    mockPicker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ uri: `${mockCache}/small.jpg`, width: 800, height: 600 }] });
    mockState.grid = 'bm90IGEgcG5n';
    const got = await createExpoWallpapers()!.pick();
    expect(got!.grid).toEqual([]);
    expect(mockState.resize[0]).toEqual({ width: 12, height: 24 }); // already small: not resized, straight to the grid
    expect(files()).toEqual([got!.uri]);
  });

  it('cancel gives null', async () => {
    mockPicker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });
    expect(await createExpoWallpapers()!.pick()).toBeNull();
  });

  it('removes and prunes only inside wallpapers/, matching kept files by name', () => {
    const w = createExpoWallpapers()!;
    const kept = `${mockDocs}/wallpapers/1.jpg`;
    const stray = `${mockDocs}/wallpapers/2.jpg`;
    const elsewhere = `${mockDocs}/notes.txt`;
    [kept, stray, elsewhere].forEach((f) => mockDisk.add(f));
    w.remove(elsewhere);
    expect(mockDisk.has(elsewhere)).toBe(true);
    w.prune([kept.replace('file:///', 'file:/')]); // spelt differently: still kept
    expect([mockDisk.has(kept), mockDisk.has(stray), mockDisk.has(elsewhere)]).toEqual([true, false, true]);
    expect(w.exists(kept)).toBe(true);
    w.remove(kept);
    expect(w.exists(kept)).toBe(false);
  });
});
