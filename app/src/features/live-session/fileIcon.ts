// What an attachment is from its name (paths from the server have only a name), and the icon its
// chip shows: the composer strip and the sent bubble use the same one.

import type { AttachmentKind } from './attachments';

const AUDIO_EXT = /\.(ogg|mp3|m4a|wav|aac)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|gif)$/i;

/** A saved file's kind by its extension (Telegram's names are the senders'; anything else is a document). */
export function kindOfName(name: string): AttachmentKind {
  if (AUDIO_EXT.test(name)) return 'audio';
  if (IMAGE_EXT.test(name)) return 'image';
  return 'document';
}

const DOCUMENT_ICONS: [RegExp, string][] = [
  [/\.pdf$/i, 'file-pdf-box'],
  [/\.docx?$/i, 'file-word-outline'],
  [/\.xlsx?$/i, 'file-excel-outline'],
  [/\.pptx?$/i, 'file-powerpoint-outline'],
  [/\.csv$/i, 'file-delimited-outline'],
  [/\.(md|markdown)$/i, 'language-markdown-outline'],
  [/\.json$/i, 'code-json'],
  [/\.zip$/i, 'folder-zip-outline'],
];

/** A MaterialCommunityIcons name for an attachment's chip. */
export function attachmentIcon(kind: AttachmentKind, name: string): string {
  if (kind === 'audio') return 'music-note-outline';
  if (kind === 'image') return 'image-outline';
  return DOCUMENT_ICONS.find(([re]) => re.test(name))?.[1] ?? 'file-document-outline';
}
