// Files EDITH sends (contracts/attachments.md §4): parsed from events, shown on its bubbles,
// downloaded once with progress, then shown or saved.

import type { EdithEvent, SentFileData } from '../../../core/events';
import type { ReceivedFiles } from '../../../core/ports';
import { ev, FakeTransport, flush } from '../../../testing/fakes';
import { initialLive, reduce, type Item, type LiveState } from '../model';
import {
  createReceivedModel,
  downloadError,
  EXPIRED,
  isNoViewer,
  launchError,
  noViewerMessage,
  OFFLINE,
  ROW_MAX_CHARS,
  SERVER_TOO_OLD,
  sentFilesOf,
  VIEW_MAX_CHARS,
  viewerMime,
  viewOf,
  viewRows,
  type SentFile,
} from '../received';

const ID = 'a'.repeat(32);
const ID2 = 'b'.repeat(32);
const PDF: SentFile = { id: ID, name: 'Plan v2.pdf', size: 2048, mime: 'application/pdf', error: null };
const offered = (f: SentFile): SentFileData => (f.id ? { id: f.id, name: f.name, size: f.size ?? 0, mime: f.mime } : { name: f.name, error: f.error ?? '' });

function run(events: EdithEvent[], from: LiveState = initialLive): LiveState {
  return events.reduce(reduce, from);
}
const assistants = (s: LiveState) => s.items.filter((x): x is Extract<Item, { kind: 'assistant' }> => x.kind === 'assistant').reverse();

describe('sentFilesOf', () => {
  it('reads sent_files, and marks refused or malformed ones as not available', () => {
    expect(
      sentFilesOf({
        files: ['/x/Plan v2.pdf', '/home/u/.ssh/id_rsa', '/y'],
        sent_files: [offered(PDF), { name: 'id_rsa', error: 'in a private folder' }, { id: '../etc', name: 'y', size: -1 }, 'junk'],
      }),
    ).toEqual([
      PDF,
      { id: null, name: 'id_rsa', size: null, mime: 'application/octet-stream', error: 'in a private folder' },
      { id: null, name: 'y', size: null, mime: 'application/octet-stream', error: 'not available' },
    ]);
  });

  it('shows the bare paths of an older server, without a download', () => {
    expect(sentFilesOf({ files: ['/home/ubuntu/edith/out/r.html'] })).toEqual([
      { id: null, name: 'r.html', size: null, mime: 'application/octet-stream', error: SERVER_TOO_OLD },
    ]);
    expect(sentFilesOf({ files: [] })).toEqual([]);
    expect(sentFilesOf({})).toEqual([]);
  });

  it('picks how each opens', () => {
    expect(viewOf({ name: 'a.png', mime: 'image/png', size: 10 })).toBe('image');
    expect(viewOf({ name: 'a.heic', mime: 'image/heic', size: 10 })).toBe('external'); // the phone's gallery draws it
    expect(viewOf({ name: 'notes.md', mime: 'text/markdown', size: 10 })).toBe('text');
    expect(viewOf({ name: 'run.log', mime: 'application/octet-stream', size: 10 })).toBe('text');
    expect(viewOf({ name: 'huge.txt', mime: 'text/plain', size: 5_000_000 })).toBe('external');
    expect(viewOf(PDF)).toBe('external');
  });
});

describe('viewerMime', () => {
  it('keeps the server’s specific type, without parameters', () => {
    expect(viewerMime('Plan v2.pdf', 'application/pdf')).toBe('application/pdf');
    expect(viewerMime('CV.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(viewerMime('a.zip', 'Application/ZIP; charset=binary')).toBe('application/zip');
    expect(viewerMime('clip.mp4', 'video/mp4')).toBe('video/mp4');
  });

  it('makes a generic or missing type specific from the extension', () => {
    expect(viewerMime('report.PDF', 'application/octet-stream')).toBe('application/pdf');
    expect(viewerMime('sheet.xlsx', '')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(viewerMime('deck.pptx', 'nonsense')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(viewerMime('old.doc', 'application/octet-stream')).toBe('application/msword');
    expect(viewerMime('book.epub', 'application/octet-stream')).toBe('application/epub+zip');
    expect(viewerMime('blob.bin', 'application/octet-stream')).toBe('application/octet-stream');
    expect(viewerMime('noext', 'application/octet-stream')).toBe('application/octet-stream');
  });

  it('sends big text as text/plain, but keeps CSV, TSV and HTML', () => {
    expect(viewerMime('notes.md', 'text/markdown')).toBe('text/plain');
    expect(viewerMime('dump.json', 'application/json')).toBe('text/plain');
    expect(viewerMime('run.log', 'application/octet-stream')).toBe('text/plain');
    expect(viewerMime('a.yaml', 'application/octet-stream')).toBe('text/plain');
    expect(viewerMime('data.csv', 'text/csv')).toBe('text/csv');
    expect(viewerMime('data.tsv', 'application/octet-stream')).toBe('text/tab-separated-values');
    expect(viewerMime('page.html', 'text/html; charset=utf-8')).toBe('text/html');
  });
});

describe('messages', () => {
  it('says plainly when no app opens a type', () => {
    expect(noViewerMessage('a.xyz')).toBe('No app on this phone opens .xyz files. Share it to another app, or save it to a folder.');
    expect(noViewerMessage('README')).toMatch(/^No app on this phone opens this file\./);
  });

  it('words download errors: expired, offline, token, cancelled, other', () => {
    expect(downloadError(new Error('UnableToDownloadException: response has status: 404'))).toBe(EXPIRED);
    expect(EXPIRED).toMatch(/^This file has expired \(files are kept 7 days\)/);
    expect(downloadError(new Error('java.net.UnknownHostException: Unable to resolve host "edith"'))).toBe(OFFLINE);
    expect(downloadError(new Error('java.net.ConnectException: Failed to connect to /100.1.2.3:8787'))).toBe(OFFLINE);
    expect(downloadError(new Error('java.net.SocketTimeoutException: timeout'))).toBe(OFFLINE);
    expect(downloadError(new Error('Network request failed'))).toBe(OFFLINE);
    expect(downloadError(new Error('response has status: 401'))).toMatch(/token/);
    expect(downloadError(new Error('AbortError: aborted'))).toBe('Download cancelled.');
    expect(downloadError(new Error('disk full'))).toMatch(/Couldn't download it/);
  });

  it('words launch errors', () => {
    expect(launchError('open', 'a.pdf', new Error('ActivityAlreadyStartedException: already started'))).toMatch(/still opening/);
    expect(launchError('share', 'a.pdf', new Error('boom'))).toBe("Couldn't share a.pdf: boom");
  });
});

describe('viewRows', () => {
  it('splits long lines and caps the text, so one huge line never freezes the reader', () => {
    expect(viewRows('a\nb')).toEqual({ rows: ['a', 'b'], cut: false });
    const one = viewRows('x'.repeat(5_000));
    expect(one.rows.map((r) => r.length)).toEqual([ROW_MAX_CHARS, ROW_MAX_CHARS, 1_000]);
    const big = viewRows('y'.repeat(1_000_000));
    expect(big.cut).toBe(true);
    expect(big.rows.join('').length).toBe(VIEW_MAX_CHARS);
    expect(big.rows.length).toBe(VIEW_MAX_CHARS / ROW_MAX_CHARS);
  });
});

describe('reduce: files on EDITH bubbles', () => {
  it('puts a reply’s files on its bubble, and a files-only reply gets a bubble', () => {
    const s = run([
      ev('message.user', { text: 'make the plan', cursor: 's1:1' }),
      ev('message.assistant', { text: 'Here it is.', files: ['/p'], sent_files: [offered(PDF)], cursor: 's1:2' }),
      ev('message.assistant', { text: '', files: ['/q'], sent_files: [{ id: ID2, name: 'q.png', size: 5, mime: 'image/png' }], cursor: 's1:3' }),
      ev('message.assistant', { text: '', files: [], cursor: 's1:4' }), // nothing at all: no bubble
    ]);
    expect(assistants(s).map((x) => [x.text, x.files?.map((f) => f.name)])).toEqual([
      ['Here it is.', ['Plan v2.pdf']],
      ['', ['q.png']],
    ]);
  });

  it('drops the server’s “📎 name” stand-in of a files-only reply: the chips show the files', () => {
    const s = run([
      ev('message.user', { text: 'go', cursor: 's1:1' }),
      ev('message.assistant', { text: '📎 Plan v2.pdf', files: ['/p'], sent_files: [offered(PDF)], cursor: 's1:2' }),
    ]);
    expect(assistants(s).map((x) => [x.text, x.files?.length])).toEqual([['', 1]]);
    // Without sent_files (an older server) the paths still give the names, so the same holds.
    const old = run([ev('message.assistant', { text: '📎 r.html', files: ['/x/r.html'], cursor: 's1:3' })]);
    expect(assistants(old)[0]!.text).toBe('');
  });

  it('turn.done adds only the files message.assistant didn’t show, on the turn’s last reply', () => {
    const s = run([
      ev('message.user', { text: 'go', cursor: 's1:1' }),
      ev('message.assistant', { text: 'Done.', files: ['/p'], sent_files: [offered(PDF)], cursor: 's1:2' }),
      ev('turn.done', { ref: 'r', lane: 'main', text: 'Done.', display_text: 'Done.', files: ['/p', '/q'], sent_files: [offered(PDF), { id: ID2, name: 'q.csv', size: 3, mime: 'text/csv' }] }),
    ]);
    const [done] = assistants(s);
    expect(done!.files!.map((f) => f.name)).toEqual(['Plan v2.pdf', 'q.csv']);
    // The same file in a later turn shows again.
    const later = run([ev('message.user', { text: 'again', cursor: 's1:3' }), ev('message.assistant', { text: 'Again.', files: ['/p'], sent_files: [offered(PDF)], cursor: 's1:4' })], s);
    expect(assistants(later).at(-1)!.files!.map((f) => f.name)).toEqual(['Plan v2.pdf']);
  });

  it('a side lane’s files come with its answer, from turn.done or message.assistant', () => {
    const s = run([
      ev('turn.done', { ref: 'r9', lane: 'side', text: 'SEND_FILE: /p', display_text: '', files: ['/p'], sent_files: [offered(PDF)] }),
      ev('message.assistant', { text: '', lane: 'side', ref: 'r9', files: ['/p'], sent_files: [offered(PDF)] }),
    ]);
    const side = assistants(s);
    expect(side).toHaveLength(1);
    expect(side[0]).toMatchObject({ lane: 'side', ref: 'r9', text: '' });
    expect(side[0]!.files).toEqual([PDF]);
  });
});

/** A ReceivedFiles that downloads on demand: `finish()` completes the pending one. */
function fakeFiles() {
  const cache = new Map<string, string>();
  let pending: { resolve: (uri: string) => void; reject: (e: Error) => void; progress: (w: number, t: number) => void; id: string } | null = null;
  const saved: string[] = [];
  const viewed: [string, string][] = [];
  const shared: [string, string, string][] = [];
  const port: ReceivedFiles & { downloads: { url: string; headers: Record<string, string> }[] } = {
    downloads: [],
    view: async (uri, mime) => {
      viewed.push([uri, mime]);
      return 'opened';
    },
    share: async (uri, name, mime) => {
      shared.push([uri, name, mime]);
    },
    cached: ({ id }) => cache.get(id) ?? null,
    download(request, file, onProgress) {
      port.downloads.push(request);
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, progress: onProgress, id: file.id };
      });
    },
    readText: async () => '# Notes\nline 2',
    save: async (_uri, name) => {
      saved.push(name);
      return 'EDITH';
    },
    prune: () => {},
  };
  return {
    port,
    saved,
    viewed,
    shared,
    progress: (w: number, t: number) => pending!.progress(w, t),
    finish(uri = 'file:///cache/received/x') {
      cache.set(pending!.id, uri);
      pending!.resolve(uri);
    },
    fail(msg: string) {
      pending!.reject(new Error(msg));
    },
  };
}

describe('createReceivedModel', () => {
  function setup() {
    const transport = new FakeTransport();
    transport.configure({ baseUrl: 'http://100.1.2.3:8787', token: 'tok' });
    const f = fakeFiles();
    const m = createReceivedModel({ transport, files: f.port });
    return { m, f };
  }

  it('downloads once with the token, shows progress, then opens a PDF in the phone’s viewer', async () => {
    const { m, f } = setup();
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(10_000);
    const opened = m.open(PDF);
    const again = m.open(PDF); // a second tap while it downloads: the same download
    await flush();
    expect(f.port.downloads).toEqual([{ url: `http://100.1.2.3:8787/v1/files/${ID}`, headers: { Authorization: 'Bearer tok' } }]);
    expect(m.store.get().files[ID]).toMatchObject({ status: 'downloading', written: 0, total: 2048 });
    f.progress(1024, 2048);
    expect(m.store.get().files[ID]).toMatchObject({ written: 1024 });
    f.finish();
    expect(await opened).toBeNull();
    expect(await again).toBeNull();
    expect(f.viewed).toEqual([
      ['file:///cache/received/x', 'application/pdf'],
      ['file:///cache/received/x', 'application/pdf'],
    ]);
    expect(m.store.get().files[ID]).toMatchObject({ status: 'ready', uri: 'file:///cache/received/x' });
    expect(await m.save(PDF)).toBe('Saved Plan v2.pdf to EDITH'); // cached: no new download
    expect(await m.share(PDF)).toBeNull();
    expect(f.shared).toEqual([['file:///cache/received/x', 'Plan v2.pdf', 'application/pdf']]);
    expect(await m.open(PDF)).toBeNull();
    expect(f.port.downloads).toHaveLength(1);
    now.mockRestore();
  });

  it('downloads again when the cached copy was pruned before saving', async () => {
    const { m, f } = setup();
    const first = m.open(PDF);
    await flush();
    f.finish();
    await first;
    let calls = 0;
    f.port.save = async () => {
      calls++;
      if (calls === 1) {
        f.port.cached = () => null; // pruned
        throw new Error('File not found');
      }
      return 'EDITH';
    };
    const saved = m.save(PDF);
    await flush();
    f.port.cached = () => null;
    f.finish();
    expect(await saved).toBe('Saved Plan v2.pdf to EDITH');
    expect(f.port.downloads).toHaveLength(2);
  });

  it('shows images and text in the viewer', async () => {
    const { m, f } = setup();
    const md: SentFile = { id: ID2, name: 'notes.md', size: 15, mime: 'text/markdown', error: null };
    const opened = m.open(md);
    await flush();
    f.finish('file:///c/notes.md');
    expect(await opened).toBeNull();
    expect(m.store.get().viewing).toEqual({ file: md, uri: 'file:///c/notes.md', view: 'text', text: '# Notes\nline 2' });
    m.close();
    expect(m.store.get().viewing).toBeNull();
  });

  it('says why a download failed, and a tap retries', async () => {
    const { m, f } = setup();
    const opened = m.open(PDF);
    await flush();
    f.fail('UnableToDownload: status 404');
    expect(await opened).toBe(EXPIRED);
    expect(m.store.get().files[ID]).toMatchObject({ status: 'failed', error: EXPIRED });
    const retry = m.open(PDF);
    await flush();
    expect(f.port.downloads).toHaveLength(2);
    f.finish();
    expect(await retry).toBeNull();
    expect(f.viewed).toHaveLength(1);
  });

  it('offers Share and Save when no app opens the type', async () => {
    const { m, f } = setup();
    f.port.view = async () => 'no-app';
    const zip: SentFile = { id: ID2, name: 'logs.zip', size: 5, mime: 'application/zip', error: null };
    const opened = m.open(zip);
    await flush();
    f.finish();
    const o = await opened;
    expect(isNoViewer(o) && o.noViewer).toBe(noViewerMessage('logs.zip'));
  });

  it('never opens an APK from the chat, and an APK without a viewer offers Share and Save', async () => {
    const { m, f } = setup();
    const apk: SentFile = { id: ID2, name: 'edith.apk', size: 5, mime: 'application/vnd.android.package-archive', error: null };
    const opened = m.open(apk);
    await flush();
    f.finish();
    const o = await opened;
    expect(isNoViewer(o) && o.noViewer).toMatch(/isn't opened from the chat/);
    expect(f.viewed).toEqual([]);
    // Without the viewer module (an older APK) any document offers Share/Save too.
    f.port.view = undefined;
    const pdf = m.open(PDF);
    await flush();
    f.finish();
    const o2 = await pdf;
    expect(isNoViewer(o2) && o2.noViewer).toBe(noViewerMessage('Plan v2.pdf'));
  });

  it('downloads again when the cached copy was pruned before opening', async () => {
    const { m, f } = setup();
    const first = m.open(PDF);
    await flush();
    f.finish();
    await first;
    let calls = 0;
    f.port.view = async () => {
      calls++;
      if (calls === 1) {
        f.port.cached = () => null; // pruned
        throw new Error('the downloaded copy is gone');
      }
      return 'opened';
    };
    const opened = m.open(PDF);
    await flush();
    f.finish();
    expect(await opened).toBeNull();
    expect(f.port.downloads).toHaveLength(2);
    expect(calls).toBe(2);
  });

  it('a pruned copy that has expired on edith says so', async () => {
    const { m, f } = setup();
    const first = m.open(PDF);
    await flush();
    f.finish();
    await first;
    f.port.view = async () => {
      f.port.cached = () => null;
      throw new Error('the downloaded copy is gone');
    };
    const opened = m.open(PDF);
    await flush();
    f.fail('response has status: 404');
    expect(await opened).toBe(EXPIRED);
  });

  it('says when sharing isn’t in this APK', async () => {
    expect(setup().m.canShare).toBe(true);
    const f = fakeFiles();
    f.port.share = undefined;
    const m = createReceivedModel({ transport: new FakeTransport(), files: f.port });
    expect(m.canShare).toBe(false);
    expect(await m.share(PDF)).toBe('Sharing needs the latest app update.');
    expect(f.port.downloads).toHaveLength(0);
  });

  it('never downloads a file the server didn’t offer, or without a connection', async () => {
    const { m, f } = setup();
    expect(await m.open({ id: null, name: 'id_rsa', size: null, mime: 'x', error: 'in a private folder' })).toBe('in a private folder');
    const offline = createReceivedModel({ transport: new FakeTransport(), files: f.port });
    expect(await offline.open(PDF)).toBe('Not connected to edith.');
    expect(await createReceivedModel({ transport: new FakeTransport() }).open(PDF)).toBe('Files open only in the Android app.');
    expect(f.port.downloads).toHaveLength(0);
  });

  it('prefetches only small images, for their thumbnails', async () => {
    const { m, f } = setup();
    m.prefetch({ ...PDF, size: 10 * 1024 * 1024, mime: 'image/png' });
    expect(f.port.downloads).toHaveLength(0);
    m.prefetch({ ...PDF, mime: 'image/png', name: 'a.png' });
    await flush();
    expect(f.port.downloads).toHaveLength(1);
  });

});
