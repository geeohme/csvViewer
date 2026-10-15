// Generates a synthetic multi-table "database dump" CSV for testing.
// Usage: node scripts/gen-sample.js [outfile]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let seed = 42;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pad = (n) => String(n).padStart(2, '0');
const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

const FIRST = ['Ana', 'Ben', 'Chloe', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivan', 'Jo', 'Kai', 'Lena'];
const LAST = ['Smith', 'Ng', "O'Brien", 'Garcia', 'Kowalski', 'Patel', 'Lee', 'Brown', 'Diaz'];
const CITY = ['Denver', 'Boulder', 'Austin', 'Portland', 'Salt Lake City', 'Phoenix'];
const ST = ['CO', 'TX', 'OR', 'UT', 'AZ'];

const out = [];
const iso = () => `20${pad(int(18, 25))}-${pad(int(1, 12))}-${pad(int(1, 28))} ${pad(int(0, 23))}:${pad(int(0, 59))}:${pad(int(0, 59))}`;
const mdy = () => `${int(1, 12)}/${int(1, 28)}/20${pad(int(19, 25))}`;

const counts = {};
function table(name, header, n, row) {
  counts[name] = { headerLine: out.length + 1, rows: n };
  out.push(header.join(','));
  for (let i = 1; i <= n; i++) out.push(row(i).join(','));
}

table('customers', ['customer_id', 'first_name', 'last_name', 'email', 'phone', 'city', 'state', 'created_at', 'is_active'], 40000, (i) => {
  const f = pick(FIRST), l = pick(LAST);
  return [i, f, q(l), `${f}.${l}${i}@example.com`.toLowerCase().replace("'", ''), `555-${int(100, 999)}-${int(1000, 9999)}`, q(pick(CITY)), pick(ST), iso(), pick(['Y', 'N'])];
});
table('orders', ['order_id', 'customer_id', 'order_date', 'status', 'total_amount', 'item_count'], 90000, (i) => [
  100000 + i, int(1, 40000), mdy(), pick(['NEW', 'SHIPPED', 'CANCELLED', 'RETURNED']),
  rnd() < 0.1 ? 'NULL' : q(`$${(rnd() * 3000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`),
  int(1, 12),
]);
// An all-text lookup table: the hardest kind to tell apart from a header.
table('products', ['product_code', 'product_name', 'category'], 300, (i) => [`SKU-${String(i).padStart(4, '0')}`, `Widget ${i}`, pick(['Hardware', 'Software', 'Service'])]);
table('payments', ['payment_id', 'order_id', 'paid_on', 'amount', 'method'], 49000, (i) => [i, 100000 + int(1, 90000), iso().slice(0, 10), (rnd() * 3000).toFixed(2), pick(['card', 'ach', 'check'])]);
out.push('');
table('notes', ['note_id', 'customer_id', 'note_text', 'created'], 6000, (i) => [
  i, int(1, 40000),
  q(i % 50 === 0 ? `Called customer, left "voicemail".\nFollow-up needed` : `Note ${i}, routine`),
  iso(),
]);
out.push('AUDIT LOG');
counts.audit_log = { titleLine: out.length };
table('audit_log', ['event_id', 'event_type', 'occurred_at', 'actor'], 1200, (i) => [i, pick(['LOGIN', 'EXPORT', 'UPDATE']), iso(), pick(FIRST)]);

const file = process.argv[2] || 'sample-data/customer-dump.csv';
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, out.join('\n') + '\n');
console.log(`Wrote ${file}: ${out.length} lines`);
console.log(JSON.stringify(counts, null, 1));
