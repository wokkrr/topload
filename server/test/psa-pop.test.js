import { describe, it, expect } from 'vitest';
import { openDb } from '../db.js';
import { mapCert, pickCerts, runPsaPop } from '../indexer-psa-pop.js';

// Exact shape of the live GetByCertNumber response, probed 2026-07-21.
const LIVE_CERT = {
  CertNumber: '137231088',
  SpecID: 2767497,
  SpecNumber: '92837',
  LabelType: 'with fugitive ink technology',
  ReverseBarCode: true,
  Year: '2019',
  Brand: 'POKEMON JAPANESE SUN & MOON FULL METAL WALL',
  Category: 'TCG Cards',
  CardNumber: '025',
  Subject: 'LUCARIO GX',
  Variety: '',
  IsPSADNA: false,
  IsDualCert: false,
  GradeDescription: 'MINT',
  CardGrade: 'MINT 9',
  TotalPopulation: 141,
  TotalPopulationWithQualifier: 0,
  PopulationHigher: 284,
};

function makeDb() {
  const db = openDb(':memory:');
  const ins = db.prepare(
    `INSERT INTO gacha_listings (platform, external_id, card_id, item_name, grade, price_cents, cert, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '2026-07-21')`
  );
  ins.run('collectorcrypt', 'cc-1', 'pkmn-smp-123', 'Lucario GX PSA 9', 'PSA9', 250000, '137231088');
  ins.run('mnstr', 'mn-1', 'pkmn-base-4', 'Charizard PSA 8', 'PSA8', 900000, '22334455');
  ins.run('courtyard', 'cy-1', null, 'Mystery slab PSA 10', 'PSA10', 50000, '99887766');
  ins.run('mnstr', 'mn-2', 'op-op01-001-ja', 'Luffy raw', 'raw', 10000, null); // no cert → never picked
  ins.run('mnstr', 'mn-3', 'pkmn-x', 'CGC slab', 'CGC9.5', 700000, '555'); // not PSA → never picked
  return db;
}

const okRes = (body) => ({ status: 200, ok: true, json: async () => body });

describe('mapCert', () => {
  it('maps the live PSACert shape', () => {
    const m = mapCert(LIVE_CERT);
    expect(m).toEqual({
      cert: '137231088',
      spec_id: '2767497',
      grade: 'PSA9',
      label: '2019 POKEMON JAPANESE SUN & MOON FULL METAL WALL #025 LUCARIO GX',
      pop: 141,
      pop_higher: 284,
    });
  });

  it('handles GEM MT 10 and half grades', () => {
    expect(mapCert({ ...LIVE_CERT, CardGrade: 'GEM MT 10' }).grade).toBe('PSA10');
    expect(mapCert({ ...LIVE_CERT, CardGrade: 'NM-MT+ 8.5' }).grade).toBe('PSA8.5');
  });

  it('returns null without a cert number, null grade on junk', () => {
    expect(mapCert(null)).toBeNull();
    expect(mapCert({})).toBeNull();
    expect(mapCert({ ...LIVE_CERT, CardGrade: 'AUTHENTIC' }).grade).toBeNull();
  });
});

describe('pickCerts', () => {
  it('picks PSA-graded certs only, most expensive first', () => {
    const db = makeDb();
    const picks = pickCerts(db, 10);
    expect(picks.map(p => p.cert)).toEqual(['22334455', '137231088', '99887766']);
  });

  it('skips certs fetched within 60 days, re-picks stale ones', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO psa_certs (cert, fetched_at) VALUES ('22334455', date('now'))`).run();
    db.prepare(`INSERT INTO psa_certs (cert, fetched_at) VALUES ('99887766', date('now', '-90 days'))`).run();
    expect(pickCerts(db, 10).map(p => p.cert)).toEqual(['137231088', '99887766']);
  });

  it('respects the budget', () => {
    expect(pickCerts(makeDb(), 1).map(p => p.cert)).toEqual(['22334455']);
  });
});

describe('runPsaPop', () => {
  it('stores pop + cert archive for matched listings', async () => {
    const db = makeDb();
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return okRes({ PSACert: { ...LIVE_CERT, CertNumber: url.split('/').pop() } });
    };
    const s = await runPsaPop(db, { budget: 2, fetchImpl, token: 't' });
    expect(s).toMatchObject({ attempted: 2, stored: 2, quotaHit: false, errors: 0 });
    expect(calls[0]).toContain('/cert/GetByCertNumber/22334455');

    const pop = db.prepare(`SELECT * FROM pop_counts WHERE card_id='pkmn-base-4'`).get();
    expect(pop).toMatchObject({ source: 'psa', grade: 'PSA9', count: 141, higher_count: 284 });
    const cert = db.prepare(`SELECT * FROM psa_certs WHERE cert='137231088'`).get();
    expect(cert.card_id).toBe('pkmn-smp-123');
    expect(JSON.parse(cert.raw)).toEqual({ pop: 141, pop_higher: 284 });
  });

  it('archives certs of unmatched listings without writing pop rows', async () => {
    const db = makeDb();
    db.prepare(`DELETE FROM gacha_listings WHERE external_id != 'cy-1'`).run();
    const s = await runPsaPop(db, { budget: 5, fetchImpl: async () => okRes({ PSACert: { ...LIVE_CERT, CertNumber: '99887766' } }), token: 't' });
    expect(s).toMatchObject({ attempted: 1, stored: 0 });
    expect(db.prepare(`SELECT COUNT(*) n FROM pop_counts`).get().n).toBe(0);
    expect(db.prepare(`SELECT cert FROM psa_certs`).get().cert).toBe('99887766');
  });

  it('stops immediately on 429 quota exhaustion', async () => {
    const db = makeDb();
    let n = 0;
    const fetchImpl = async () => (++n === 1
      ? okRes({ PSACert: { ...LIVE_CERT, CertNumber: '22334455' } })
      : { status: 429, ok: false, json: async () => ({}) });
    const s = await runPsaPop(db, { budget: 5, fetchImpl, token: 't' });
    expect(s).toMatchObject({ attempted: 2, stored: 1, quotaHit: true });
    expect(n).toBe(2); // never attempted the third cert
  });

  it('skips cleanly when no token is configured', async () => {
    const s = await runPsaPop(makeDb(), { budget: 5, fetchImpl: async () => { throw new Error('must not fetch'); }, token: undefined });
    expect(s).toMatchObject({ attempted: 0, stored: 0 });
  });

  it('counts non-OK responses as errors and continues', async () => {
    const db = makeDb();
    let n = 0;
    const fetchImpl = async () => (++n === 1
      ? { status: 404, ok: false, json: async () => ({}) }
      : okRes({ PSACert: { ...LIVE_CERT, CertNumber: '137231088' } }));
    const s = await runPsaPop(db, { budget: 2, fetchImpl, token: 't' });
    expect(s).toMatchObject({ attempted: 2, stored: 1, errors: 1 });
  });
});
