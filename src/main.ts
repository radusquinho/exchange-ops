import './styles.css';
import { Shop } from './domain.ts';
import { runAgent, ollamaPlanner, rulesPlanner } from './agent.ts';
import type { Trace } from './agent.ts';
import { scenarios } from './scenarios.ts';

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const scenario = element<HTMLSelectElement>('scenario');
const request = element<HTMLTextAreaElement>('request');
const run = element<HTMLButtonElement>('run');
const approve = element<HTMLButtonElement>('approve');
const reject = element<HTMLButtonElement>('reject');
const model = element<HTMLInputElement>('model');
const trace = element<HTMLOListElement>('trace');
const reviewNote = element('review-note');
let shop: Shop | undefined;
let proposalId: string | undefined;
let busy = false;
let retry = false;

const labels: Record<string, string> = {
  prepared: 'Proposal ready for review.',
  already_prepared: 'This request already has a proposal.',
  needs_details: 'Enter an order number and a supported size (XS to XXL).',
  order_not_found: 'The order is unavailable for this customer.',
  not_delivered: 'The order must be delivered before a change can be made.',
  window_closed: 'The 30-day exchange window has closed.',
  final_sale: 'This order was marked final sale.',
  same_size: 'The requested size matches the original order.',
  out_of_stock: 'The requested size is out of stock.',
  response_lost: 'The response was lost after approval. Retry to recover the result for this proposal.',
  committed: 'Exchange approved. One shipment was recorded.',
  already_committed: 'Recovered the existing shipment. The retry did not create a duplicate.',
  rejected: 'The proposal was rejected.',
  planner_error: 'The planner is unavailable. Open the trace for details.',
  no_action: 'The planner finished without preparing a proposal.',
};

function updateControls() {
  scenario.disabled = busy;
  run.disabled = busy;
  model.disabled = busy;
  approve.disabled = busy;
  reject.disabled = busy;
}

function showTrace(event: Trace) {
  element('trace-empty').hidden = true;
  const row = document.createElement('li');
  const detail = document.createElement('details');
  const head = document.createElement('summary');
  const title = document.createElement('strong');
  const code = document.createElement('span');
  const duration = document.createElement('time');
  const payload = document.createElement('pre');
  title.textContent = event.label.replaceAll('_', ' ');
  code.className = 'event-code';
  code.textContent = event.code.replaceAll('_', ' ');
  duration.textContent = `${event.ms.toFixed(1)} ms`;
  payload.textContent = JSON.stringify(event.detail, null, 2);
  head.append(title, code, duration);
  detail.append(head, payload);
  row.append(detail);
  trace.append(row);
}

async function refreshState() {
  if (!shop) return;
  const current = await shop.snapshot();
  const proposal = current.proposals[0];
  proposalId = proposal?.id;
  const size = proposal?.size ?? 'L';
  element('stock-label').textContent = `Stock · ${size}`;
  element('kpi-proposals').textContent = String(current.proposals.length);
  element('kpi-shipments').textContent = String(current.shipments.length);
  element('kpi-stock').textContent = String(current.inventory.find(entry => entry.size === size)?.available ?? 0);
  const status = element('proposal-state');
  status.textContent = retry ? 'Retry required' : proposal?.state ?? 'No proposal';
  status.dataset.state = retry ? 'retry' : proposal?.state ?? '';
  element('review-actions').hidden = !retry && proposal?.state !== 'pending';
  approve.textContent = retry ? 'Retry approval' : 'Approve exchange';
  reject.hidden = retry;
}

async function exclusive(operation: () => Promise<void>) {
  if (busy) return;
  busy = true;
  updateControls();
  try {
    await operation();
  } catch (error) {
    reviewNote.textContent = 'The workflow could not finish. The trace has details.';
    showTrace({ label: 'workflow', code: 'error', ms: 0, detail: String(error) });
  } finally {
    busy = false;
    updateControls();
  }
}

async function loadScenario() {
  const chosen = scenarios.find(entry => entry.id === scenario.value)!;
  request.value = chosen.request;
  element('scenario-note').textContent = chosen.note;
  trace.replaceChildren();
  element('trace-empty').hidden = false;
  retry = false;
  reviewNote.textContent = 'Loading the scenario database…';
  if (shop) await shop.close();
  shop = undefined;
  shop = await Shop.create(chosen.seed);
  await refreshState();
  reviewNote.textContent = 'Run the workflow to prepare a proposal.';
}

for (const entry of scenarios) scenario.add(new Option(entry.name, entry.id));
scenario.addEventListener('change', () => void exclusive(loadScenario));

element<HTMLFormElement>('request-form').addEventListener('submit', event => {
  event.preventDefault();
  void exclusive(async () => {
    if (!shop) return;
    const local = import.meta.env.DEV ? model.value.trim() : '';
    const planner = local ? ollamaPlanner('/api/local-model', local) : rulesPlanner;
    element('mode-label').textContent = local ? 'Ollama planner' : 'Rule-based planner';
    reviewNote.textContent = 'Running the workflow…';
    const result = await runAgent(shop, request.value, planner, showTrace);
    reviewNote.textContent = labels[result.code] ?? 'The workflow stopped. Open the trace for details.';
    await refreshState();
  });
});

function decision(accept: boolean) {
  void exclusive(async () => {
    if (!shop || !proposalId) return;
    const start = performance.now();
    const result = accept ? await shop.approve(proposalId) : await shop.reject(proposalId);
    showTrace({ label: accept ? 'human approval' : 'human rejection', code: result.code, ms: performance.now() - start, detail: result });
    retry = result.code === 'response_lost';
    reviewNote.textContent = labels[result.code] ?? 'The operation stopped. Open the trace for details.';
    await refreshState();
  });
}
approve.addEventListener('click', () => decision(true));
reject.addEventListener('click', () => decision(false));

element('model-settings').hidden = !import.meta.env.DEV;
void exclusive(loadScenario);
