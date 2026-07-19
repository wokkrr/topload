/**
 * One-shot probe: verify the PriceCharting grade-field mapping against a real
 * response before trusting live ingestion. Run on a machine with network:
 *
 *   PRICECHARTING_API_KEY=xxx npm run probe:pricecharting
 *
 * Prints the raw JSON for a known card so you can eyeball which price fields
 * carry which grades, then adjust FIELD_TO_GRADE in adapters/pricecharting.js.
 */
import { makePriceChartingAdapter, FIELD_TO_GRADE } from './adapters/pricecharting.js';

const pc = makePriceChartingAdapter();
const query = process.argv[2] ?? 'charizard ex 199 151 pokemon';

const products = await pc.resolveProduct(query);
console.log(`\nTop matches for "${query}":`);
for (const p of products.slice(0, 5)) console.log(`  ${p.pcId}  ${p.productName}  [${p.consoleName}]`);

if (products[0]) {
  const marks = await pc.fetchExternalMarks(
    [{ id: 'probe', external_ids: { pricecharting: String(products[0].pcId) } }],
    new Date().toISOString().slice(0, 10),
  );
  console.log('\nMapped marks for top match:');
  for (const m of marks) console.log(`  ${m.grade.padEnd(6)} $${(m.price_cents / 100).toFixed(2)}`);
  console.log('\nCurrent FIELD_TO_GRADE mapping:', FIELD_TO_GRADE);
  console.log('If grades look wrong vs the PriceCharting product page, fix FIELD_TO_GRADE.');
}
