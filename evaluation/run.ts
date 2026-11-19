import assert from 'node:assert/strict';
import { ollamaPlanner, rulesPlanner, runAgent } from '../src/agent.ts';
import type { Planner } from '../src/agent.ts';
import { ORDER_ID, REQUEST, Shop } from '../src/domain.ts';
import type { Seed, Size } from '../src/domain.ts';

const provider = process.argv.includes('--model');
const planner = provider ? ollamaPlanner('http://127.0.0.1:11434/api/chat', process.env.OLLAMA_MODEL || 'qwen3:4b') : rulesPlanner;
const tests: { name: string; seed: Seed; run: (shop: Shop) => Promise<void> }[] = [];
const test = (name: string, seed: Seed, run: (shop: Shop) => Promise<void>) => tests.push({ name, seed, run });
async function plan(shop: Shop, expected = 'prepared', request = REQUEST, engine = planner) {
  const run = await runAgent(shop, request, engine);
  assert.equal(run.code, expected, run.trace.at(-1)?.label + ' ' + JSON.stringify(run.trace.at(-1)?.detail));
}
async function inventory(shop: Shop, size: Size) {
  return (await shop.snapshot()).inventory.find(item => item.size === size)!.available;
}
const proposal = 'change-' + ORDER_ID;

for (const [name, seed, result, request] of [
  ['Prepare eligible request', {}, 'prepared'],
  ['Exactly 30 days', { days: 30 }, 'prepared'],
  ['Past the exchange window', { days: 31 }, 'window_closed'],
  ['Final sale', { finalSale: true }, 'final_sale'],
  ['Order pending', { status: 'pending' }, 'not_delivered'],
  ['Order cancelled', { status: 'cancelled' }, 'not_delivered'],
  ['Already the requested size', { currentSize: 'L' }, 'same_size'],
  ['No stock at planning', { stock: 0 }, 'out_of_stock'],
  ['Last unit available', { stock: 1 }, 'prepared'],
  ['Order owned by another customer', { actor: 'customer-99' }, 'order_not_found'],
  ['Order does not exist', {}, 'order_not_found', 'Exchange EX-9999 to size L.'],
  ['Missing order number', {}, 'needs_details', 'Can I change to size L?'],
  ['Missing target size', {}, 'needs_details', 'Please exchange EX-1042.'],
  ['Unsupported size', {}, 'needs_details', 'Please exchange EX-1042 to size XXXL.'],
  ['Spanish request', {}, 'prepared', 'Quiero cambiar el pedido EX-1042 a la talla XL.'],
] as const) {
  test(name, seed, async shop => {
    await plan(shop, result, request);
    const snap = await shop.snapshot();
    assert.equal(snap.shipments.length, 0);
    assert.equal(snap.proposals.length, result === 'prepared' ? 1 : 0);
    if (request?.includes('XL') && snap.proposals.length) assert.equal(snap.proposals[0].size, 'XL');
    assert.equal(await inventory(shop, 'L'), seed && 'stock' in seed ? seed.stock : 4);
  });
}

test('Human approval creates one shipment', {}, async shop => {
  await plan(shop);
  assert.equal((await shop.approve(proposal)).code, 'committed');
  assert.equal((await shop.snapshot()).shipments.length, 1);
  assert.equal(await inventory(shop, 'L'), 3);
});
test('Reject then attempt approval', {}, async shop => {
  await plan(shop);
  assert.equal((await shop.reject(proposal)).code, 'rejected');
  assert.equal((await shop.approve(proposal)).code, 'rejected');
  assert.equal((await shop.snapshot()).shipments.length, 0);
});
test('Stock changes before approval', { stock: 1, fault: 'stock-drift' }, async shop => {
  await plan(shop);
  assert.equal((await shop.approve(proposal)).code, 'out_of_stock');
  assert.equal((await shop.snapshot()).shipments.length, 0);
});
test('Lost response and retry after commit', { fault: 'lost-response' }, async shop => {
  await plan(shop);
  assert.equal((await shop.approve(proposal)).code, 'response_lost');
  assert.equal((await shop.approve(proposal)).code, 'already_committed');
  assert.equal((await shop.snapshot()).shipments.length, 1);
  assert.equal(await inventory(shop, 'L'), 3);
});
test('Concurrent approval requests', {}, async shop => {
  await plan(shop);
  const results = await Promise.all([shop.approve(proposal), shop.approve(proposal)]);
  assert.deepEqual(results.map(result => result.code).sort(), ['already_committed', 'committed']);
  assert.equal((await shop.snapshot()).shipments.length, 1);
  assert.equal(await inventory(shop, 'L'), 3);
});
test('Repeated preparation is idempotent', {}, async shop => {
  await plan(shop);
  await plan(shop, 'already_prepared');
  assert.equal((await shop.snapshot()).proposals.length, 1);
});
test('Unrecognised approval ID', {}, async shop => {
  assert.equal((await shop.approve('unknown')).code, 'proposal_not_found');
  assert.equal((await shop.snapshot()).shipments.length, 0);
});
test('Planner tries to bypass review', {}, async shop => {
  const bad: Planner = async () => ({ role: 'assistant', content: '', tool_calls: [
    { function: { name: 'approve', arguments: { order_id: ORDER_ID, size: 'L' } } },
  ] });
  await plan(shop, 'unexpected_tool', REQUEST, bad);
  assert.equal((await shop.snapshot()).shipments.length, 0);
});
test('Planner requests a different order', {}, async shop => {
  const bad: Planner = async () => ({ role: 'assistant', content: '', tool_calls: [
    { function: { name: 'get_order', arguments: { order_id: 'EX-9999' } } },
  ] });
  await plan(shop, 'request_mismatch', REQUEST, bad);
  assert.equal((await shop.snapshot()).proposals.length, 0);
});
test('Planner API is unavailable', {}, async shop => {
  await plan(shop, 'planner_error', REQUEST, async () => { throw new Error('Demo timeout'); });
  assert.equal((await shop.snapshot()).proposals.length, 0);
});

const rows = [];
for (const entry of tests) {
  const shop = await Shop.create(entry.seed);
  const start = performance.now();
  try {
    await entry.run(shop);
    rows.push({ case: entry.name, passed: true, ms: Math.round(performance.now() - start) });
  } catch (error) {
    rows.push({ case: entry.name, passed: false, ms: Math.round(performance.now() - start) });
    console.error(entry.name, error);
  } finally {
    await shop.close();
  }
}
console.table(rows);
const passed = rows.filter(row => row.passed).length;
const times = rows.map(row => row.ms).sort((left, right) => left - right);
console.log(`${passed}/${rows.length} checks passed (${provider ? 'Ollama + injected failure cases' : 'rule-based planner'}).`);
console.log(`p95 per check (excluding DB setup): ${times[Math.ceil(times.length * .95) - 1]} ms.`);
if (passed !== rows.length) process.exitCode = 1;
