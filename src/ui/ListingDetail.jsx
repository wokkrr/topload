import { useEffect, useState } from 'react';
import { tokens } from '../tokens.js';
import { fmtUsd, fmtPct, PLATFORM_LABELS } from '../data/client.js';
import { listingUrl, listingLanguage, imgFallback, isSealed } from './tables.jsx';
import { CardResearch, headingStyle } from './CardDetail.jsx';

/**
 * In-app listing page — the user stays on Topload for everything except the
 * final buy click. Hero (photos + ask vs comp + buy), then marketplace-style
 * accordion sections (Kaleb, modeled on Collector Crypt's listing page):
 * Price history & comps (the embedded research module), More details, and
 * Similar listings. Native in-app buying is the pinned execution-layer phase.
 */
export function ListingDetail({ listing: l, listings, navListings, onBack, onOpenListing, onSelectCard }) {
  const [side, setSide] = useState('front');
  const [inspect, setInspect] = useState(false);   // full-screen image inspector
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

  // Grading company parsed off the normalized grade ('CGC10' → CGC / 10;
  // 'CGCAuth' → CGC / Authentic — an authenticated-but-ungraded slab).
  const gm = /^([A-Z]+)(?:([\d.]+)|Auth)$/.exec(l.grade ?? '');

  // Certification number — shown ONLY when confidently present: the adapter's
  // cert field (Courtyard 'Serial' attr, MNSTR serialNumber), MNSTR's vault
  // serial (which IS the slab cert — covers rows ingested before the cert
  // column existed), or an explicit "Cert #12345678" in the title. Never
  // guessed (a wrong cert link on someone's slab is worse than none).
  const cert = l.cert
    ?? (l.platform === 'mnstr' && /^\d{6,12}$/.test(l.nft_address ?? '') ? l.nft_address : null)
    ?? (/(?:cert(?:ification)?\.?\s*(?:number|no\.?|#)?\s*[:#]?\s*)(\d{6,10})/i.exec(l.item_name ?? '')?.[1] ?? null);
  const certUrl = cert && gm ? ({
    PSA: `https://www.psacard.com/cert/${cert}`,
    CGC: `https://www.cgccards.com/certlookup/${cert}/`,
    BGS: 'https://www.beckett.com/grading/card-lookup',      // no stable deep link — number shown alongside
    BECKETT: 'https://www.beckett.com/grading/card-lookup',
    TAG: 'https://my.taggrading.com/',
    SGC: 'https://gosgc.com/cert-code-lookup',
  })[gm[1]] ?? null : null;

  // Prev/next walk the FILTERED desk list the user came from (Kaleb,
  // 2026-07-20), not the whole collection. Similar-listings keeps the full set.
  const nav = navListings ?? listings ?? [];
  const idx = nav.findIndex(s => s.platform === l.platform && s.external_id === l.external_id);
  const prev = idx > 0 ? nav[idx - 1] : null;
  const next = idx >= 0 && idx < nav.length - 1 ? nav[idx + 1] : null;

  // Styled to match the header's theme toggle (Kaleb, 2026-07-20).
  const navBtn = (enabled) => ({
    background: 'none', border: `1px solid ${tokens.color.border}`,
    color: enabled ? tokens.color.inkSecondary : tokens.color.inkMuted,
    cursor: enabled ? 'pointer' : 'default',
    borderRadius: 4, padding: '4px 10px', font: `12px ${tokens.font.body}`, lineHeight: 1,
  });

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={onBack} className="tl-back" style={{
          background: 'none', border: 'none', color: tokens.color.inkSecondary,
          font: `12px ${tokens.font.body}`, cursor: 'pointer', padding: 0,
        }}>← Back</button>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {idx >= 0 && (
            <span style={{ color: tokens.color.inkMuted, font: `10px ${tokens.font.mono}`, marginRight: 4 }}>
              {idx + 1} / {nav.length}
            </span>
          )}
          <button onClick={prev ? () => onOpenListing?.(prev) : undefined} title={prev ? prev.item_name : undefined}
                  style={navBtn(!!prev)}>←</button>
          <button onClick={next ? () => onOpenListing?.(next) : undefined} title={next ? next.item_name : undefined}
                  style={navBtn(!!next)}>→</button>
        </span>
      </div>

      {/* ── Hero, card-page treatment (Kaleb, 2026-07-21: "clean it up similar
          to the card lookup card page"): the slab leads at card-page scale,
          identity + numbers in a tight column beside it. ── */}
      <div style={{ display: 'flex', gap: 32, marginTop: 16, flexWrap: 'wrap' }}>
        {/* ── Photos ── */}
        <div style={{ flex: '0 0 400px', maxWidth: '100%' }}>
          <div style={{
            position: 'relative', aspectRatio: '3/4',
            border: `1px solid ${tokens.color.border}`, background: tokens.color.surfaceRaised,
            overflow: 'hidden',
          }}>
            {img
              ? <img src={img} alt={l.item_name} onError={imgFallback}
                     onClick={() => setInspect(true)}
                     style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', cursor: 'zoom-in' }} />
              : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: tokens.color.inkMuted, font: `11px ${tokens.font.body}` }}>no photo</div>}
            {img && (
              <span onClick={() => setInspect(true)} style={{
                position: 'absolute', top: 8, right: 8, cursor: 'zoom-in',
                font: `10px ${tokens.font.mono}`, color: tokens.color.ink,
                background: tokens.color.overlay, borderRadius: 4, padding: '3px 8px',
              }}>⊕ INSPECT</span>
            )}
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
        </div>

        {/* ── Facts + comp analysis + actions ── */}
        <div style={{ flex: 1, minWidth: 280 }}>
          <h2 style={{ font: `22px ${tokens.font.display}`, margin: '0 0 10px', lineHeight: 1.3 }}>{l.item_name}</h2>

          {/* Identity as a chip row (card-page language), not a text run. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 18 }}>
            {/* A factory-sealed pack is not an ungraded CARD — 'Raw' is the
                wrong condition class entirely (Kaleb, 2026-07-23). */}
            <MetaChip strong>{isSealed(l) ? 'Sealed' : l.grade === 'raw' ? 'Raw' : l.grade}</MetaChip>
            {listingLanguage(l) === 'Japanese' && <MetaChip>Japanese</MetaChip>}
            {l.category && <MetaChip>{l.category}</MetaChip>}
            <MetaChip>{platform}</MetaChip>
            {l.listing_type === 'inquiry' && <MetaChip>Inquiry · 24h</MetaChip>}
            {l.listed_at && (
              <span style={{ font: `11px ${tokens.font.mono}`, color: tokens.color.inkMuted, marginLeft: 4, textTransform: 'uppercase' }}>
                listed {String(l.listed_at).slice(0, 10)}
              </span>
            )}
          </div>

          {/* INQUIRY PRICING (2026-07-23): intake-stage MNSTR items publish
              only an ESTIMATED VALUE on their own page — the feed's list
              price is a pre-negotiation placeholder their site doesn't show.
              We display their public number, labeled as an estimate; the
              vs-mark chip (computed off the placeholder ask) comes off. */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
            <span style={{ font: `34px ${tokens.font.mono}`, color: tokens.color.ink }}>
              {fmtUsd(l.listing_type === 'inquiry' && l.fmv_usd ? Math.round(l.fmv_usd * 100) : l.price_cents)}
            </span>
            {l.listing_type === 'inquiry' && (
              <span style={{ font: `13px ${tokens.font.mono}`, color: tokens.color.inkSecondary, textTransform: 'uppercase' }}>
                {platform} est. value · price set by inquiry
              </span>
            )}
            {l.delta_pct != null && l.listing_type !== 'inquiry' && (
              <span style={{
                font: `600 13px ${tokens.font.mono}`, borderRadius: 4, padding: '3px 9px', textTransform: 'uppercase',
                color: l.delta_pct <= 0 ? tokens.color.up : tokens.color.down,
                border: `1px solid ${tokens.color.border}`,
              }}>{fmtPct(l.delta_pct)} vs Oracle</span>
            )}
            {hasComp && (
              <span style={{ font: `13px ${tokens.font.mono}`, color: tokens.color.inkSecondary, textTransform: 'uppercase' }}>
                Oracle price {fmtUsd(l.comp_cents)}
              </span>
            )}
          </div>

          <div style={{ color: tokens.color.inkMuted, font: `11px ${tokens.font.body}`, marginTop: 10, lineHeight: 1.6, maxWidth: 460 }}>
            {l.listing_type === 'inquiry'
              ? `New ${platform} inventory in intake — no firm ask yet. The number above is ${platform}'s own value estimate; the final price is settled through their inquiry desk.`
              : hasComp
                ? l.delta_pct <= 0
                  ? `Asking ${fmtPct(Math.abs(l.delta_pct)).replace('+', '')} below our Oracle price for this grade.`
                  : `Asking ${fmtPct(l.delta_pct)} above our Oracle price for this grade.`
                : l.comp_suspect
                  ? 'A comp exists but is wildly out of line with this ask — we don’t show numbers we don’t trust.'
                  : 'No grade-matched oracle comp for this card yet — comps appear as our sales history deepens.'}
            {' '}Asking prices never feed the oracle.
          </div>

          {/* ── Purchase block, native-checkout shape (Kaleb, 2026-07-21):
              price ON the button, full-width primary, quiet provenance line.
              When in-app buying ships, only the caption changes — the button
              already looks like ours. ── */}
          {url && (
            <div style={{ marginTop: 22, maxWidth: 380 }}>
              <style>{`
                .tl-buy-now { transition: transform .12s ease, box-shadow .12s ease, filter .12s ease; }
                .tl-buy-now:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(0,0,0,0.18); filter: brightness(1.05); }
                .tl-buy-now:active { transform: translateY(0); box-shadow: none; }
              `}</style>
              {/* INQUIRY LANE (2026-07-23): MNSTR intake-stage inventory is
                  negotiate-only (24h response), not instant checkout. A Buy
                  Now that lands on an inquiry form is a lie against the North
                  Star — the button says what actually happens. */}
              <a href={url} target="_blank" rel="noopener noreferrer" className="tl-buy-now" style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                background: l.listing_type === 'inquiry' ? tokens.color.ink : tokens.color.brass,
                color: tokens.color.bg, textDecoration: 'none',
                borderRadius: 8, padding: '13px 20px',
              }}>
                <span style={{ font: `600 14px ${tokens.font.body}`, letterSpacing: '0.02em' }}>
                  {l.listing_type === 'inquiry' ? `Inquire on ${platform}` : 'Buy Now'}
                </span>
                <span style={{ font: `600 15px ${tokens.font.mono}` }}>
                  {l.listing_type === 'inquiry'
                    ? `EST ${fmtUsd(l.fmv_usd ? Math.round(l.fmv_usd * 100) : l.price_cents)}`
                    : fmtUsd(l.price_cents)}
                </span>
              </a>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 7 }}>
                <span style={{ font: `10px ${tokens.font.body}`, color: tokens.color.inkMuted }}>
                  {l.listing_type === 'inquiry'
                    ? `Not instant checkout — ${platform} responds to inquiries within 24h`
                    : `Checkout completes on ${platform} for now`}
                </span>
                <a href={url} target="_blank" rel="noopener noreferrer"
                   style={{ font: `10px ${tokens.font.body}`, color: tokens.color.inkSecondary, textDecoration: 'none' }}>
                  view on {platform} ↗
                </a>
              </div>
            </div>
          )}

          {/* ── Listing details fill the hero's dead space (Kaleb, 2026-07-21:
              the right half under the buy button was wasted) — two quiet
              columns of receipts beside the slab, no accordion click needed. ── */}
          <div style={{ borderTop: `1px solid ${tokens.color.border}`, marginTop: 24, paddingTop: 14 }}>
            <div style={{ ...headingStyle, marginBottom: 8 }}>Listing Details</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '4px 40px', maxWidth: 760 }}>
              {gm && <Row k="Grading company" v={gm[1]} />}
              {gm && <Row k="Grade" v={gm[2] ?? 'Authentic (ungraded)'} />}
              {cert && (
                <Row k="Certification #" v={certUrl
                  ? <a href={certUrl} target="_blank" rel="noopener noreferrer"
                       style={{ color: tokens.color.brass, textDecoration: 'underline' }}
                       title="Verify this cert on the grader's site">{cert} ↗</a>
                  : cert} />
              )}
              {!gm && <Row k="Condition" v={isSealed(l) ? 'Sealed / factory product' : 'Raw / ungraded'} />}
              {l.pop_count != null && (
                <Row k="PSA population" v={`${Number(l.pop_count).toLocaleString()} at this grade${l.pop_higher != null ? ` · ${Number(l.pop_higher).toLocaleString()} higher` : ''}`} />
              )}
              <Row k="Language" v={listingLanguage(l)} />
              <Row k="Listed" v={l.listed_at ? String(l.listed_at).slice(0, 10) : '—'} />
              <Row k="Currency" v={/^usd/i.test(l.currency ?? '') ? 'USD' : (l.currency ?? '—')} />
              {l.card_id
                ? <Row k="Tracked card" v={l.card_name ?? l.card_id} />
                : <Row k="Tracked card" v="not matched yet" />}
              <Row k="Photo" v={l.image_kind === 'art' ? 'reference art (not the item)' : l.image ? 'actual item' : '—'} />
              {l.nft_address && <Row k="Vault ID" v={`${l.nft_address.slice(0, 6)}…${l.nft_address.slice(-4)}`} />}
            </div>
          </div>
        </div>
      </div>

      {/* ── Research + similar, open panels (details moved into the hero;
          the collapsed accordion hid the chart — freshened 2026-07-21). ── */}
      <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {l.card_id && (
          <Panel title="Price History & Comps"
                 hint="the tracked card behind this listing — Oracle price by grade, verified sales plotted">
            <CardResearch cardId={l.card_id} initialGrade={l.grade} embedded onOpenCard={onSelectCard} />
          </Panel>
        )}

        {similar.length > 0 && (
          <Panel title="Similar Listings">
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {similar.map(s => (
                <div key={`${s.platform}|${s.external_id}`}
                     onClick={() => onOpenListing?.(s)}
                     style={{
                       display: 'flex', alignItems: 'center', gap: 12, padding: '7px 4px',
                       borderBottom: `1px solid ${tokens.color.surface}`, cursor: 'pointer',
                     }}>
                  {s.image
                    ? <img src={s.image} alt="" loading="lazy" onError={imgFallback} style={{ height: 40, width: 30, objectFit: 'contain', background: tokens.color.surfaceRaised, flexShrink: 0 }} />
                    : <span style={{ height: 40, width: 30, background: tokens.color.surfaceRaised, flexShrink: 0 }} />}
                  <span style={{ font: `12px ${tokens.font.body}`, color: tokens.color.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {s.item_name}
                  </span>
                  <span style={{ font: `11px ${tokens.font.mono}`, color: tokens.color.inkSecondary, flexShrink: 0, textTransform: 'uppercase' }}>{isSealed(s) ? 'Sealed' : s.grade}</span>
                  <span style={{ font: `12px ${tokens.font.mono}`, color: tokens.color.ink, flexShrink: 0 }}>{fmtUsd(s.price_cents)}</span>
                  {s.delta_pct != null && (
                    <span style={{ font: `11px ${tokens.font.mono}`, color: s.delta_pct <= 0 ? tokens.color.up : tokens.color.down, flexShrink: 0, minWidth: 56, textAlign: 'right' }}>
                      {fmtPct(s.delta_pct)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>
      {inspect && img && (
        <ImageInspector src={img} alt={l.item_name} side={side}
                        hasBack={!!l.image_back} onFlip={() => setSide(s => s === 'front' ? 'back' : 'front')}
                        onClose={() => setInspect(false)} />
      )}
    </section>
  );
}

/**
 * Full-screen image inspector (Kaleb, 2026-07-21: "collectors want to see
 * high quality images of the corners and edges — the slab is the most
 * important part of this whole terminal"). Click the photo → near-fullscreen
 * view; click again → 3× zoom that FOLLOWS THE CURSOR, so tracing corners
 * and edges is just moving the mouse. Esc / backdrop / ✕ closes; front-back
 * flip stays available inside.
 */
function ImageInspector({ src, alt, side, hasBack, onFlip, onClose }) {
  const [zoomed, setZoomed] = useState(false);
  const [origin, setOrigin] = useState('50% 50%');
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    // Freeze the page behind the overlay while inspecting.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  const track = (e) => {
    if (!zoomed) return;
    const r = e.currentTarget.getBoundingClientRect();
    setOrigin(`${((e.clientX - r.left) / r.width * 100).toFixed(1)}% ${((e.clientY - r.top) / r.height * 100).toFixed(1)}%`);
  };
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(10,10,8,0.9)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{ position: 'relative', overflow: 'hidden', borderRadius: 6, maxWidth: '92vw', maxHeight: '92vh' }}>
        <img src={src} alt={alt} onError={imgFallback}
             onClick={(e) => { track(e); setZoomed(z => !z); }}
             onMouseMove={track}
             style={{
               display: 'block', maxWidth: '92vw', maxHeight: '92vh',
               transform: zoomed ? 'scale(3)' : 'none', transformOrigin: origin,
               transition: zoomed ? 'none' : 'transform .15s ease',
               cursor: zoomed ? 'zoom-out' : 'zoom-in',
             }} />
      </div>
      <div style={{ position: 'fixed', top: 18, right: 22, display: 'flex', gap: 8 }} onClick={e => e.stopPropagation()}>
        {hasBack && (
          <button onClick={onFlip} style={{
            background: 'rgba(255,255,255,0.12)', color: '#fff', border: 'none', borderRadius: 6,
            padding: '8px 16px', font: `12px ${tokens.font.body}`, cursor: 'pointer',
          }}>{side === 'front' ? 'View back' : 'View front'}</button>
        )}
        <button onClick={onClose} style={{
          background: 'rgba(255,255,255,0.12)', color: '#fff', border: 'none', borderRadius: 6,
          padding: '8px 14px', font: `14px ${tokens.font.body}`, cursor: 'pointer',
        }}>✕</button>
      </div>
      <div style={{
        position: 'fixed', bottom: 18, left: '50%', transform: 'translateX(-50%)',
        color: 'rgba(255,255,255,0.55)', font: `11px ${tokens.font.body}`, pointerEvents: 'none',
      }}>
        {zoomed ? 'move to trace corners and edges · click to zoom out' : 'click the image to zoom · Esc to close'}
      </div>
    </div>
  );
}

/** Open full-width section — panel look shared with the Terminal page. */
function Panel({ title, hint, children }) {
  return (
    <div style={{ border: `1px solid ${tokens.color.border}`, background: tokens.color.surface, padding: '14px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ ...headingStyle, color: tokens.color.ink }}>{title}</span>
        {hint && <span style={{ color: tokens.color.inkMuted, font: `11px ${tokens.font.body}` }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', font: `12px ${tokens.font.body}`, borderBottom: `1px solid ${tokens.color.surface}` }}>
      <span style={{ color: tokens.color.inkMuted }}>{k}</span>
      <span style={{ color: tokens.color.ink, font: `12px ${tokens.font.mono}`, textAlign: 'right', textTransform: 'uppercase' }}>{v}</span>
    </div>
  );
}

/** Small identity chip — the card-page meta language on the listing hero. */
function MetaChip({ strong = false, children }) {
  return (
    <span style={{
      font: `11px ${tokens.font.mono}`, borderRadius: 4, padding: '3px 10px', textTransform: 'uppercase',
      border: `1px solid ${tokens.color.border}`,
      color: strong ? tokens.color.ink : tokens.color.inkSecondary,
      background: strong ? tokens.color.surfaceRaised : 'none',
    }}>{children}</span>
  );
}

const labelStyle = { color: tokens.color.inkMuted, font: `10px ${tokens.font.body}`, textTransform: 'uppercase', letterSpacing: '0.08em' };
