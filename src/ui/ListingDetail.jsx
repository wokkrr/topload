import { useState } from 'react';
import { tokens } from '../tokens.js';
import { fmtUsd, fmtPct, PLATFORM_LABELS } from '../data/client.js';
import { listingUrl } from './tables.jsx';
import { CardResearch, headingStyle } from './CardDetail.jsx';

/**
 * In-app listing page — the user stays on Topload for everything except the
 * final buy click. Hero (photos + ask vs comp + buy), then marketplace-style
 * accordion sections (Kaleb, modeled on Collector Crypt's listing page):
 * Price history & comps (the embedded research module), More details, and
 * Similar listings. Native in-app buying is the pinned execution-layer phase.
 */
export function ListingDetail({ listing: l, listings, onBack, onOpenListing }) {
  const [side, setSide] = useState('front');
  const url = listingUrl(l);
  const img = side === 'back' && l.image_back ? l.image_back : l.image;
  const hasComp = l.comp_cents && !l.comp_suspect;
  const platform = PLATFORM_LABELS[l.platform] ?? l.platform;

  // Similar: same tracked card first, then same grade within the franchise.
  const similar = (listings ?? [])
    .filter(s => !(s.platform === l.platform && s.external_id === l.external_id))
    .filter(s => (l.card_id && s.card_id === l.card_id) || (s.category === l.category && s.grade === l.grade))
    .sort((a, b) => (l.card_id && (b.card_id === l.card_id) - (a.card_id === l.card_id)) || a.price_cents - b.price_cents)
    .slice(0, 6);

  // Grading company parsed off the normalized grade ('CGC10' → CGC / 10).
  const gm = /^([A-Z]+)([\d.]+)$/.exec(l.grade ?? '');

  // Certification number — shown ONLY when confidently present: an explicit
  // cert field from the adapter, or an explicit "Cert #12345678" in the title.
  // Never guessed (a wrong cert link on someone's slab is worse than none).
  const cert = l.cert ?? (/(?:cert(?:ification)?\.?\s*(?:number|no\.?|#)?\s*[:#]?\s*)(\d{6,10})/i.exec(l.item_name ?? '')?.[1] ?? null);
  const certUrl = cert && gm ? ({
    PSA: `https://www.psacard.com/cert/${cert}`,
    CGC: `https://www.cgccards.com/certlookup/${cert}/`,
    BGS: 'https://www.beckett.com/grading/card-lookup',      // no stable deep link — number shown alongside
    BECKETT: 'https://www.beckett.com/grading/card-lookup',
    TAG: 'https://my.taggrading.com/',
    SGC: 'https://gosgc.com/cert-code-lookup',
  })[gm[1]] ?? null : null;

  // Prev/next through the desk's listings without going back.
  const idx = (listings ?? []).findIndex(s => s.platform === l.platform && s.external_id === l.external_id);
  const prev = idx > 0 ? listings[idx - 1] : null;
  const next = idx >= 0 && idx < (listings?.length ?? 0) - 1 ? listings[idx + 1] : null;

  const navBtn = (enabled) => ({
    background: 'none', border: `1px solid ${enabled ? tokens.color.inkMuted : tokens.color.border}`,
    color: enabled ? tokens.color.ink : tokens.color.inkMuted, cursor: enabled ? 'pointer' : 'default',
    padding: '4px 12px', font: `13px ${tokens.font.mono}`, lineHeight: 1,
  });

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={onBack} className="tl-back" style={{
          background: 'none', border: 'none', color: tokens.color.inkSecondary,
          font: `12px ${tokens.font.body}`, cursor: 'pointer', padding: 0,
        }}>← back to Gacha Desk</button>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {idx >= 0 && (
            <span style={{ color: tokens.color.inkMuted, font: `10px ${tokens.font.mono}`, marginRight: 4 }}>
              {idx + 1} / {listings.length}
            </span>
          )}
          <button onClick={prev ? () => onOpenListing?.(prev) : undefined} title={prev ? prev.item_name : undefined}
                  style={navBtn(!!prev)}>‹</button>
          <button onClick={next ? () => onOpenListing?.(next) : undefined} title={next ? next.item_name : undefined}
                  style={navBtn(!!next)}>›</button>
        </span>
      </div>

      <div style={{ display: 'flex', gap: 32, marginTop: 16, flexWrap: 'wrap' }}>
        {/* ── Photos ── */}
        <div style={{ flex: '0 0 320px', maxWidth: '100%' }}>
          <div style={{
            position: 'relative', aspectRatio: '3/4',
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
              <div style={labelStyle}>Asking</div>
              <div style={{ font: `30px ${tokens.font.mono}`, color: tokens.color.ink }}>{fmtUsd(l.price_cents)}</div>
            </div>
            {hasComp && (
              <div>
                <div style={labelStyle}>Oracle comp ({l.grade})</div>
                <div style={{ font: `20px ${tokens.font.mono}`, color: tokens.color.inkSecondary }}>{fmtUsd(l.comp_cents)}</div>
              </div>
            )}
            {l.delta_pct != null && (
              <div>
                <div style={labelStyle}>vs comp</div>
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
          </div>
          {url && (
            <div style={{ font: `9px ${tokens.font.body}`, color: tokens.color.inkMuted, marginTop: 8 }}>
              Purchase completes on {platform} — in-app buying is on the roadmap.
            </div>
          )}
        </div>
      </div>

      {/* ── Accordion sections, marketplace-style ── */}
      <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {l.card_id && (
          <Accordion title="Price history & comps" defaultOpen={false}>
            <CardResearch cardId={l.card_id} initialGrade={l.grade} embedded />
          </Accordion>
        )}

        <Accordion title="Listing Details" defaultOpen>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '4px 40px', maxWidth: 760 }}>
            {gm && <Row k="Grading company" v={gm[1]} />}
            {gm && <Row k="Grade" v={gm[2]} />}
            {cert && (
              <Row k="Certification #" v={certUrl
                ? <a href={certUrl} target="_blank" rel="noopener noreferrer"
                     style={{ color: tokens.color.brass, textDecoration: 'underline' }}
                     title="Verify this cert on the grader's site">{cert} ↗</a>
                : cert} />
            )}
            {!gm && <Row k="Condition" v="Raw / ungraded" />}
            <Row k="Category" v={l.category ?? '—'} />
            <Row k="Marketplace" v={platform} />
            <Row k="Listed" v={l.listed_at ? String(l.listed_at).slice(0, 10) : '—'} />
            <Row k="Currency" v={l.currency ?? '—'} />
            {l.card_id
              ? <Row k="Tracked card" v={l.card_name ?? l.card_id} />
              : <Row k="Tracked card" v="not matched yet" />}
            <Row k="Photo" v={l.image_kind === 'art' ? 'reference art (not the item)' : l.image ? 'actual item' : '—'} />
            {l.nft_address && <Row k="Vault token" v={`${l.nft_address.slice(0, 6)}…${l.nft_address.slice(-4)}`} />}
          </div>
        </Accordion>

        {similar.length > 0 && (
          <Accordion title="Similar listings" defaultOpen>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {similar.map(s => (
                <div key={`${s.platform}|${s.external_id}`}
                     onClick={() => onOpenListing?.(s)}
                     style={{
                       display: 'flex', alignItems: 'center', gap: 12, padding: '7px 4px',
                       borderBottom: `1px solid ${tokens.color.surface}`, cursor: 'pointer',
                     }}>
                  {s.image
                    ? <img src={s.image} alt="" loading="lazy" style={{ height: 40, width: 30, objectFit: 'contain', background: tokens.color.surfaceRaised, flexShrink: 0 }} />
                    : <span style={{ height: 40, width: 30, background: tokens.color.surfaceRaised, flexShrink: 0 }} />}
                  <span style={{ font: `12px ${tokens.font.body}`, color: tokens.color.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {s.item_name}
                  </span>
                  <span style={{ font: `11px ${tokens.font.mono}`, color: tokens.color.inkSecondary, flexShrink: 0 }}>{s.grade}</span>
                  <span style={{ font: `12px ${tokens.font.mono}`, color: tokens.color.ink, flexShrink: 0 }}>{fmtUsd(s.price_cents)}</span>
                  {s.delta_pct != null && (
                    <span style={{ font: `11px ${tokens.font.mono}`, color: s.delta_pct <= 0 ? tokens.color.up : tokens.color.down, flexShrink: 0, minWidth: 56, textAlign: 'right' }}>
                      {fmtPct(s.delta_pct)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </Accordion>
        )}
      </div>
    </section>
  );
}

/** Full-width expandable section — the marketplace listing-page pattern. */
function Accordion({ title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border: `1px solid ${tokens.color.border}`, background: tokens.color.surface, overflow: 'hidden' }}>
      <button onClick={() => setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
        background: 'none', border: 'none', cursor: 'pointer', padding: '14px 18px',
        ...headingStyle, color: tokens.color.ink, textAlign: 'left',
      }}>
        {title}
        <span style={{ color: tokens.color.inkSecondary, fontSize: 11, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' }}>▼</span>
      </button>
      {open && <div style={{ padding: '2px 18px 16px' }}>{children}</div>}
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', font: `12px ${tokens.font.body}`, borderBottom: `1px solid ${tokens.color.surface}` }}>
      <span style={{ color: tokens.color.inkMuted }}>{k}</span>
      <span style={{ color: tokens.color.ink, font: `12px ${tokens.font.mono}`, textAlign: 'right' }}>{v}</span>
    </div>
  );
}

const labelStyle = { color: tokens.color.inkMuted, font: `10px ${tokens.font.body}`, textTransform: 'uppercase', letterSpacing: '0.08em' };
