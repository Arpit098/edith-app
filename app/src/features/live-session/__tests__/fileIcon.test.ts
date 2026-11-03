// Attachment kinds from saved names, and the chip icons (all real MaterialCommunityIcons glyphs).

import { DOCUMENT_TYPES, documentMime } from '../../../adapters/media/expo/documents';
import { isIcon } from '../../../ui/Icon';
import { attachmentIcon, kindOfName } from '../fileIcon';

describe('attachment kinds and icons', () => {
  it('tells audio, images and documents apart by name', () => {
    expect(['a.ogg', 'b.MP3', 'c.m4a'].map(kindOfName)).toEqual(['audio', 'audio', 'audio']);
    expect(['p.jpg', 'q.JPEG', 'r.heic', 's.webp', 't.png'].map(kindOfName)).toEqual(Array(5).fill('image'));
    expect(['x.pdf', 'y.docx', 'z.csv', 'noext'].map(kindOfName)).toEqual(Array(4).fill('document'));
  });

  it.each([
    ['Bill.PDF', 'file-pdf-box'],
    ['CV.docx', 'file-word-outline'],
    ['old.doc', 'file-word-outline'],
    ['q3.xlsx', 'file-excel-outline'],
    ['deck.pptx', 'file-powerpoint-outline'],
    ['bill.csv', 'file-delimited-outline'],
    ['notes.md', 'language-markdown-outline'],
    ['data.json', 'code-json'],
    ['trip.zip', 'folder-zip-outline'],
    ['notes.txt', 'file-document-outline'],
  ])('%s shows %s', (name, icon) => {
    expect(attachmentIcon('document', name)).toBe(icon);
    expect(isIcon(icon)).toBe(true);
  });

  it('audio and image chips keep their icons', () => {
    expect(attachmentIcon('audio', 'a.m4a')).toBe('music-note-outline');
    expect(attachmentIcon('image', 'p.jpg')).toBe('image-outline');
    expect(isIcon('file-document-outline')).toBe(true);
  });
});

describe('the document picker types', () => {
  it('offers PDF, Office, text, JSON and zip', () => {
    expect(DOCUMENT_TYPES).toEqual(expect.arrayContaining(['application/pdf', 'text/*', 'application/json', 'application/zip', 'application/msword']));
    expect(DOCUMENT_TYPES.some((t) => t.startsWith('image/') || t.startsWith('audio/'))).toBe(false);
  });

  it("hints a type from the name when the picker can't", () => {
    expect(documentMime('a.pdf', 'application/pdf')).toBe('application/pdf');
    expect(documentMime('notes.MD', 'application/octet-stream')).toBe('text/markdown');
    expect(documentMime('x.xlsx', undefined)).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(documentMime('noext', null)).toBe('application/octet-stream');
  });
});
