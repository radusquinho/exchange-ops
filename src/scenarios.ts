import { REQUEST } from './domain.ts';
import type { Seed } from './domain.ts';

export const scenarios: { id: string; name: string; note: string; request: string; seed: Seed }[] = [
  { id: 'lost', name: 'Response lost after commit', note: 'The database commits the shipment, but the response is dropped. Retry with the same proposal.',
    request: REQUEST, seed: { fault: 'lost-response' } },
  { id: 'normal', name: 'Standard size exchange', note: 'The order arrived 12 days ago. Four units are available in size L.',
    request: REQUEST, seed: {} },
  { id: 'drift', name: 'Stock changes before approval', note: 'Another order takes the remaining stock after the proposal is created.',
    request: REQUEST, seed: { stock: 1, fault: 'stock-drift' } },
  { id: 'expired', name: 'Exchange window closed', note: 'The order was delivered 31 days ago. The store allows exchanges for 30 days.',
    request: REQUEST, seed: { days: 31 } },
  { id: 'unowned', name: 'Order belongs to another customer', note: 'The simulated customer is authenticated as a different account.',
    request: REQUEST, seed: { actor: 'customer-99' } },
];
