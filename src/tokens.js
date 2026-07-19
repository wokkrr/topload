/**
 * Topload design tokens — the single source of truth for the terminal look.
 * Locked (handoff): graphite surface, brass = Pokémon, slate blue = One Piece;
 * Libre Caslon display, IBM Plex Mono data, Inter body.
 *
 * `series.*.data` are chart-mark variants of the brand hues, nudged into the
 * dark-mode OKLCH lightness band and chroma floor and validated (CVD ΔE 20+,
 * contrast ≥3:1 on graphite) with the dataviz palette validator. UI chrome
 * keeps the original brand tokens.
 */
export const tokens = {
  color: {
    bg: '#101214',        // graphite
    surface: '#16191C',
    surfaceRaised: '#1C2024',
    border: '#262B30',
    ink: '#E8E4DC',
    inkSecondary: '#9AA0A6',
    inkMuted: '#5F666D',
    up: '#6FBF8E',
    down: '#C97A6A',
    brass: '#C9A96A',     // Pokémon brand
    slate: '#7FA6C9',     // One Piece brand
  },
  series: {
    PKMN: { label: 'Pokémon', brand: '#C9A96A', data: '#B98A2B' },
    OP:   { label: 'One Piece', brand: '#7FA6C9', data: '#4689C2' },
    YGO:  { label: 'Yu-Gi-Oh', brand: '#C77FB4', data: '#B25F9E' }, // validated triple w/ brass+slate on graphite
  },
  font: {
    display: `'Libre Caslon Text', Georgia, serif`,
    // VCR OSD Mono: retro CRT data font (placeholder per Kaleb, self-hosted
    // in public/fonts, freeware). IBM Plex Mono as fallback.
    mono: `'VCR OSD Mono', 'IBM Plex Mono', ui-monospace, monospace`,
    body: `'Inter', system-ui, sans-serif`,
  },
  radius: { sm: '4px', md: '8px' },
};
