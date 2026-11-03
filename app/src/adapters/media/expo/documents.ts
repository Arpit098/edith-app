// The documents the file picker offers (contracts/attachments.md): what the server accepts. Android's
// picker filters by these MIME types; the server decides the real type from the file's bytes.

export const DOCUMENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/msword', // .doc
  'application/vnd.ms-excel', // .xls
  'application/vnd.ms-powerpoint', // .ppt
  'text/*', // .txt, .csv, .md (providers name CSV and Markdown several ways)
  'application/json',
  'application/zip',
  'application/x-zip-compressed',
] as const;

const BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
};

/** The upload's Content-Type hint: the picker's type, else one from the name (the server only sniffs). */
export function documentMime(name: string, picked: string | null | undefined): string {
  if (picked && picked !== 'application/octet-stream') return picked;
  const m = /\.[A-Za-z0-9]{1,8}$/.exec(name);
  return (m && BY_EXT[m[0].toLowerCase()]) || 'application/octet-stream';
}
