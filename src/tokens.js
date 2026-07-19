/**
 * Topload design tokens — single source of truth for the terminal look.
 *
 * Colors are CSS custom properties so the theme can switch at runtime:
 * `tokens.color.*` / `tokens.series.*.data` resolve to var(--…) references,
 * and THEMES holds the raw values applyTheme() writes onto <html>.
 *
 * Dark = the terminal (graphite/brass/slate + YGO magenta, all validated).
 * Light = warm paper "gallery" mode; series colors re-validated on #F5F2EB
 * (chart palettes can't just be inverted — CVD/contrast checks are per-surface).
 */

export const THEMES = {
  dark: {
    bg: '#101214', surface: '#16191C', surfaceRaised: '#1C2024', border: '#262B30',
    ink: '#E8E4DC', inkSecondary: '#9AA0A6', inkMuted: '#5F666D',
    up: '#6FBF8E', down: '#C97A6A',
    brass: '#C9A96A', slate: '#7FA6C9',
    seriesPkmn: '#B98A2B', seriesOp: '#4689C2', seriesYgo: '#B25F9E',
    overlay: 'rgba(16,18,20,0.85)',
  },
  light: {
    bg: '#F5F2EB', surface: '#EDE9DF', surfaceRaised: '#E4DFD2', border: '#D5CFC0',
    ink: '#23262A', inkSecondary: '#5A6068', inkMuted: '#8A9098',
    up: '#2E7D4F', down: '#B3492F',
    brass: '#8F6A1E', slate: '#3D6E96',
    seriesPkmn: '#96660A', seriesOp: '#2E71AC', seriesYgo: '#A2417F',
    overlay: 'rgba(245,242,235,0.88)',
  },
};

/** Write a theme's values as CSS variables on <html> and remember the choice. */
export function applyTheme(mode) {
  const theme = THEMES[mode] ?? THEMES.dark;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme)) root.style.setProperty(`--${k}`, v);
  root.dataset.theme = mode;
  try { localStorage.setItem('topload-theme', mode); } catch { /* private mode */ }
}

export function initialTheme() {
  // Light is the default (Kaleb, 2026-07-19); a saved choice still wins.
  try { return localStorage.getItem('topload-theme') ?? 'light'; } catch { return 'light'; }
}

const v = (name) => `var(--${name})`;

export const tokens = {
  color: {
    bg: v('bg'), surface: v('surface'), surfaceRaised: v('surfaceRaised'), border: v('border'),
    ink: v('ink'), inkSecondary: v('inkSecondary'), inkMuted: v('inkMuted'),
    up: v('up'), down: v('down'),
    brass: v('brass'), slate: v('slate'),
    overlay: v('overlay'),
  },
  series: {
    PKMN: { label: 'Pokémon', brand: v('brass'), data: v('seriesPkmn') },
    OP:   { label: 'One Piece', brand: v('slate'), data: v('seriesOp') },
    YGO:  { label: 'Yu-Gi-Oh', brand: v('seriesYgo'), data: v('seriesYgo') },
  },
  font: {
    display: `'Libre Caslon Text', Georgia, serif`,
    // VCR OSD Mono: retro CRT data font (placeholder per Kaleb, self-hosted).
    mono: `'VCR OSD Mono', 'IBM Plex Mono', ui-monospace, monospace`,
    body: `'Inter', system-ui, sans-serif`,
  },
  radius: { sm: '4px', md: '8px' },
};
