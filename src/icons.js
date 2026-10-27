// Inline SVG icons (stroke, currentColor) used instead of emoji across the UI.
const svg = (body, cls = '') =>
  `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  // SOL delivered into a wallet: arrow dropping into a tray
  payout: svg('<path d="M12 3v11" /><path d="m7.5 9.5 4.5 4.5 4.5-4.5" /><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />'),
  // creator fees: a sugar cube
  claim: svg('<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" /><path d="M4 7.5 12 12l8-4.5" /><path d="M12 12v9" />'),
  // new holder: a cracked egg
  join: svg('<path d="M12 3c3.6 0 6.5 5.2 6.5 9.6A6.5 6.5 0 0 1 12 21a6.5 6.5 0 0 1-6.5-8.4C5.5 8.2 8.4 3 12 3Z" /><path d="m6.2 11.5 2.6 1.6 2.2-2 2.2 2 2.4-1.6 2.2 1.1" />'),
  // holder left: walking out a door
  leave: svg('<path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14" /><path d="M10 16.5 14.5 12 10 7.5" /><path d="M14.5 12H4" />'),
  // whale buy: a sharp move up
  whale: svg('<path d="m3 17 6-6 4 4 8-8" /><path d="M15 7h6v6" />'),
  crown: svg('<path d="M3.5 8 7.5 12 12 5l4.5 7 4-4-1.8 10.5H5.3Z" /><path d="M5.5 21h13" />', 'fill'),
  ant: '<svg class="i" viewBox="0 0 64 64" aria-hidden="true"><use href="#ant-glyph" /></svg>',
};
