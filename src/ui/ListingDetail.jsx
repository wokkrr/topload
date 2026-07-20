import { useState } from 'react';
import { tokens } from '../tokens.js';
import { fmtUsd, fmtPct, PLATFORM_LABELS } from '../data/client.js';
import { listingUrl } from './tables.jsx';

/**
 * In-app listing page — the user stays on Topload for everything except the
 * final buy click. Renders entirely from the /api/gacha row we already hold
 * client-side: photos (front/back when the marketplace provides them), ask
 * vs oracle comp, and the bridge to the matched card's research page.
 * Native in-app buying (wallet-connect) is the pinned execution-layer phase;
 * until then the buy button is the one outbound step.
 */
export function ListingDetail({ listing: l, onBack, onSelectCard }) {
  const [side, setSide] = useState('front');
  const url = listingUrl(l);
  const img = side === 'back' && l.image_back ? l.image_back : l.image;
  const hasComp = l.comp_cents && !l.comp_suspect;
  const platform = PLATFORM_LABELS[l.platform] ?? l.platform;

  return (
    <section>
      <button onClick={onBack} className="tl-back" style={{
        background: 'none', border: 'none', color: tokens.color.inkSecondary,
        font: `12px ${tokens.font.body}`, cursor: 'pointer', padding: 0,
      }}>← back to Gacha Desk</button>

      <div style={{ display: 'flex', gap: 32, marginTop: 16, flexWrap: 'wrap' }}>
        {/* ── Photos ── */}
        <div style={{ flex: '0 0 320px', maxWidth: '100%' }}>
          <div style={{
            position: 'relative', aspectRatio: '3/4', borderRadius: 10,
            border: `1px solid ${tokens.color.border}`, background: tokens.color.surfaceRaised,
            overflow: 'hidden',
          }}>
            {img
              ? <img src={img} alt={l.item_name} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
              : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: tokens.color.inkMuted, font: `11px ${tokens.font.body}` }}>no photo</div>}
            {img && l.image_kind === 'art' && (
              <span style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, textAlign: 'center',
                font: `600 9px ${tokens.font.body}`, letterSpacing: '0.06em',
                color: tokens.color.ink, background: tokens.color.overlay, padding: '3px 0',
              }}>NOT ITEM · REFERENCE ART</span>
            )}
          </div>
          {l.image_back && (
            <div style={{ display: 'flex', gap: 4, marginTop: 8, justifyContent: 'center' }}>
              {['front', 'back'].map(s => (
                <button key={s} onClick={() => setSide(s)} style={{
                  background: side === s ? tokens.color.surfaceRaised : 'none',
                  border: `1px solid ${side === s ? tokens.color.inkMuted : tokens.color.border}`,
                  color: side === s ? tokens.color.ink : tokens.color.inkSecondary,
                  borderRadius: 4, padding: '3px 14px', font: `11px ${tokens.font.body}`, cursor: 'pointer',
                }}>{s === 'front' ? 'Front' : 'Back'}</button>
              ))}
            </div>
          )}
          {img && l.image_kind !== 'art' && (
            <div style={{ font: `9px ${tokens.font.body}`, color: tokens.color.inkMuted, textAlign: 'center', marginTop: 6 }}>
              photo of the actual item, from the marketplace vault
            </div>
          )}
        </div>

        {/* ── Facts + comp analysis + actions ── */}
        <div style={{ flex: 1, minWidth: 280 }}>
          <h2 style={{ font: `20px ${tokens.font.display}`, margin: '0 0 4px', lineHeight: 1.3 }}>{l.item_name}</h2>
          <div style={{ color: tokens.color.inkSecondary, font: `12px ${tokens.font.body}`, marginBottom: 16 }}>
            {l.grade !== 'raw' ? `${l.grade} · ` : ''}{l.category ?? ''} · listed on {platform}
            {l.listed_at ? ` · ${String(l.listed_at).slice(0, 10)}` : ''}
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div style={{ color: tokens.color.inkMuted, font: `10px ${tokens.font.body}`, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Asking</div>
              <div style={{ font: `30px ${tokens.font.mono}`, color: tokens.color.ink }}>{fmtUsd(l.price_cents)}</div>
            </div>
            {hasComp && (
              <div>
                <div style={{ color: tokens.color.inkMuted, font: `10px ${tokens.font.body}`, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Oracle comp ({l.grade})</div>
                <div style={{ font: `20px ${tokens.font.mono}`, color: tokens.color.inkSecondary }}>{fmtUsd(l.comp_cents)}</div>
              </div>
            )}
            {l.delta_pct != null && (
              <div>
                <div style={{ color: tokens.color.inkMuted, font: `10px ${tokens.font.body}`, textTransform: 'uppercase', letterSpacing: '0.08em' }}>vs comp</div>
                <div style={{ font: `20px ${tokens.font.mono}`, color: l.delta_pct <= 0 ? tokens.color.up : tokens.color.down }}>{fmtPct(l.delta_pct)}</div>
              </div>
            )}
          </div>

          <div style={{ color: tokens.color.inkMuted, font: `11px ${tokens.font.body}`, marginTop: 10, lineHeight: 1.6, maxWidth: 460 }}>
            {hasComp
              ? l.delta_pct <= 0
                ? `Asking ${fmtPct(Math.abs(l.delta_pct)).replace('+', '')} below our latest grade-matched oracle mark.`
                : `Asking ${fmtPct(l.delta_pct)} above our latest grade-matched oracle mark.`
              : l.comp_suspect
                ? 'A comp exists but is wildly out of line with this ask — we don’t show numbers we don’t trust.'
                : 'No grade-matched oracle comp for this card yet — comps appear as our sales history deepens.'}
            {' '}Asking prices never feed the oracle.
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 22, flexWrap: 'wrap' }}>
            {url && (
              <a href={url} target="_blank" rel="noopener noreferrer" style={{
                background: tokens.color.brass, color: tokens.color.bg, textDecoration: 'none',
                borderRadius: 6, padding: '10px 22px', font: `600 13px ${tokens.font.body}`,
              }}>Buy on {platform} ↗</a>
            )}
            {l.card_id && (
              <button onClick={() => onSelectCard?.(l.card_id)} style={{
                background: 'none', border: `1px solid ${tokens.color.inkMuted}`, color: tokens.color.ink,
                borderRadius: 6, padding: '10px 18px', font: `13px ${tokens.font.body}`, cursor: 'pointer',
              }}>Price history & comps →</button>
            )}
          </div>
          {url && (
            <div style={{ font: `9px ${tokens.font.body}`, color: tokens.color.inkMuted, marginTop: 8 }}>
              Purchase completes on {platform} — in-app buying is on the roadmap.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
