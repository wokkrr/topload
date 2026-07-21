import { useEffect, useRef, useState } from 'react';
import { tokens } from '../tokens.js';
import { api } from '../data/client.js';
import { CardsTable, Chip } from './tables.jsx';

const IPS = [['', 'All'], ['PKMN', 'Pokémon'], ['OP', 'One Piece'], ['YGO', 'Yu-Gi-Oh']];
const GRADES = ['', 'raw', 'PSA9', 'PSA10', 'BGS10', 'CGC10'];
const SORTS = [['price', 'Price'], ['change', 'Δ1D'], ['volume', 'Volume']];

/** Cards screener: search + franchise/grade filters over the full universe. */
export function Screener({ onSelect }) {
  const [q, setQ] = useState('');
  const [ip, setIp] = useState('');
  const [grade, setGrade] = useState('');
  const [sort, setSort] = useState('price');
  const [cards, setCards] = useState(null);
  const [err, setErr] = useState(null);
  const debounce = useRef(null);

  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      api.cards({ q, ip, grade, sort, limit: 100 })
        .then(setCards)
        .catch(e => setErr(String(e)));
    }, q ? 250 : 0);
    return () => clearTimeout(debounce.current);
  }, [q, ip, grade, sort]);

  return (
    <section>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search cards, sets, numbers…"
          style={{
            background: tokens.color.surface, border: `1px solid ${tokens.color.border}`,
            color: tokens.color.ink, borderRadius: 6, padding: '7px 12px', width: 280,
            font: `13px ${tokens.font.body}`, outline: 'none',
          }}
          onFocus={e => e.target.style.borderColor = tokens.color.inkMuted}
          onBlur={e => e.target.style.borderColor = tokens.color.border}
        />
        <span style={{ display: 'flex', gap: 4 }}>
          {IPS.map(([val, label]) => (
            <Chip key={val} active={ip === val} onClick={() => setIp(val)}
                  color={val ? tokens.series[val]?.data : undefined}>{label}</Chip>
          ))}
        </span>
        <span style={{ display: 'flex', gap: 4 }}>
          {GRADES.map(g => (
            <Chip key={g || 'any'} active={grade === g} onClick={() => setGrade(g)}>{g || 'Any grade'}</Chip>
          ))}
        </span>
        <span style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {SORTS.map(([val, label]) => (
            <Chip key={val} active={sort === val} onClick={() => setSort(val)}>{label}</Chip>
          ))}
        </span>
      </div>

      {err && <div style={{ color: tokens.color.down, font: `12px ${tokens.font.mono}`, marginBottom: 8, textTransform: 'uppercase' }}>{err}</div>}
      {cards && (
        <div style={{ color: tokens.color.inkMuted, font: `11px ${tokens.font.body}`, marginBottom: 8 }}>
          {cards.length === 100 ? 'top 100 results — refine to narrow' : `${cards.length} result${cards.length === 1 ? '' : 's'}`}
        </div>
      )}
      <CardsTable cards={cards} onSelect={onSelect} />
    </section>
  );
}
