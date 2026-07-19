/**
 * Adapter contract. Every data source (PriceCharting, eBay solds, demo, …)
 * implements this shape so ingest.js can treat them uniformly.
 *
 * @typedef {Object} CardRecord
 * @property {string} id          stable slug, e.g. 'pkmn-151-charizard-ex-199'
 * @property {string} ip          'PKMN' | 'OP'
 * @property {string} name
 * @property {string} [set_name]
 * @property {string} [number]
 * @property {string} [variant]
 * @property {Object} [external_ids]
 *
 * @typedef {Object} SaleRecord   a completed sale — never an asking price
 * @property {string} card_id
 * @property {string} grade       'raw' | 'PSA10' | ...
 * @property {number} price_cents
 * @property {string} sold_at     ISO 8601
 * @property {string} source
 * @property {string} external_id unique within source (dedupe key)
 *
 * @typedef {Object} Adapter
 * @property {string} name
 * @property {() => Promise<CardRecord[]>} listCards
 * @property {(cardIds: string[], sinceISO: string) => Promise<SaleRecord[]>} fetchSales
 */

export {};
