// Colours and spacing shared by every screen (one dark theme for now).

export const colors = {
  bg: '#0E1116',
  surface: '#161B22',
  surfaceHigh: '#1F2630',
  border: '#2A323D',
  text: '#E6EDF3',
  textDim: '#8B949E',
  accent: '#4EA1FF',
  accentText: '#04121F',
  ok: '#3FB950',
  warn: '#D29922',
  danger: '#F85149',
  user: '#1F3A5F',
  diffAdd: '#12261A',
  diffAddText: '#7EE787',
  diffDel: '#2D1416',
  diffDelText: '#FFA198',
  diffHunk: '#A5D6FF',
  overlay: 'rgba(14, 17, 22, 0.66)', // over a thumbnail while it uploads
  overlayStrong: 'rgba(14, 17, 22, 0.8)',
} as const;

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24 } as const;

export const radius = { s: 6, m: 10, l: 16 } as const;

export const mono = 'monospace';
