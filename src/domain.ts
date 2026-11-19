import { PGlite } from '@electric-sql/pglite';
import type { Transaction } from '@electric-sql/pglite';

export const sizes = ['XS', 'S', 'M', 'L', 'XL', 'XXL'] as const;
export type Size = typeof sizes[number];
export type Order = {
  id: string; customer: string; sku: string; size: Size; delivered_days: number;
  status: 'delivered' | 'pending' | 'cancelled'; final_sale: boolean;
};
export type Seed = {
  actor?: string;
  days?: number;
  status?: Order['status'];
  finalSale?: boolean;
  stock?: number;
  currentSize?: Size;
  stockSize?: Size;
  fault?: 'lost-response' | 'stock-drift';
};
export type Proposal = { id: string; order_id: string; size: Size; state: 'pending' | 'approved' | 'rejected' };
export type Result = { code: string; [key: string]: unknown };
export const ORDER_ID = 'EX-1042';
export const REQUEST = 'Please exchange order EX-1042 to size L.';
const CUSTOMER = 'customer-29';
const SKU = 'orbit-tee';
const WINDOW_DAYS = 30;
const isSize = (value: unknown): value is Size => sizes.some(size => size === value);
const schema = `
CREATE TABLE orders (
  id TEXT PRIMARY KEY, customer TEXT NOT NULL, sku TEXT NOT NULL, size TEXT NOT NULL,
  delivered_days INT NOT NULL CHECK (delivered_days >= 0), status TEXT NOT NULL,
  final_sale BOOLEAN NOT NULL
);
CREATE TABLE inventory (
  sku TEXT NOT NULL, size TEXT NOT NULL, available INT NOT NULL CHECK (available >= 0),
  PRIMARY KEY (sku, size)
);
CREATE TABLE proposals (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  size TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','approved','rejected'))
);
CREATE TABLE shipments (
  proposal_id TEXT PRIMARY KEY REFERENCES proposals(id), order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  size TEXT NOT NULL
);`;

function eligible(order: Order, size: Size): Result {
  if (order.status !== 'delivered') return { code: 'not_delivered' };
  if (order.final_sale) return { code: 'final_sale' };
  if (order.delivered_days > WINDOW_DAYS) return { code: 'window_closed', days: order.delivered_days };
  if (order.size === size) return { code: 'same_size' };
  return { code: 'eligible', windowDays: WINDOW_DAYS };
}

export class Shop {
  readonly actor: string;
  private readonly db: PGlite;
  private lostResponse = false;
  private stockDrift = false;

  private constructor(db: PGlite, seed: Seed) {
    this.db = db;
    this.actor = seed.actor ?? CUSTOMER;
    this.lostResponse = seed.fault === 'lost-response';
    this.stockDrift = seed.fault === 'stock-drift';
  }

  static async create(seed: Seed = {}) {
    const db = await PGlite.create();
    try {
      await db.exec(schema);
      await db.query('INSERT INTO orders VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [ORDER_ID, CUSTOMER, SKU, seed.currentSize ?? 'M', seed.days ?? 12, seed.status ?? 'delivered', seed.finalSale ?? false]);
      for (const size of sizes) {
        const stock = size === (seed.stockSize ?? 'L') ? (seed.stock ?? 4) : 4;
        await db.query('INSERT INTO inventory VALUES ($1,$2,$3)', [SKU, size, stock]);
      }
      return new Shop(db, seed);
    } catch (error) {
      await db.close();
      throw error;
    }
  }

  private async ownedOrder(client: PGlite | Transaction, id: string, lock = false) {
    const { rows } = await client.query<Order>(
      `SELECT * FROM orders WHERE id = $1 AND customer = $2${lock ? ' FOR UPDATE' : ''}`, [id, this.actor]);
    return rows[0];
  }

  private async inventory(client: PGlite | Transaction, sku: string, size: Size) {
    const { rows } = await client.query<{ available: number }>(
      'SELECT available FROM inventory WHERE sku = $1 AND size = $2', [sku, size]);
    return rows[0]?.available ?? 0;
  }

  async tool(name: string, args: unknown): Promise<Result> {
    if (!['get_order', 'check_policy', 'check_stock', 'prepare_exchange'].includes(name)) return { code: 'unknown_tool' };
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { code: 'invalid_arguments' };
    const { order_id, size } = args as Record<string, unknown>;
    if (typeof order_id !== 'string' || !/^EX-\d{4}$/.test(order_id)) return { code: 'invalid_arguments' };
    if (name !== 'get_order' && !isSize(size)) return { code: 'invalid_arguments' };
    if (name === 'prepare_exchange' && isSize(size)) return this.prepare(order_id, size);
    const order = await this.ownedOrder(this.db, order_id);
    if (!order) return { code: 'order_not_found' };
    if (name === 'get_order') {
      return { code: 'order_found', order: { id: order.id, sku: order.sku, size: order.size, status: order.status, days: order.delivered_days } };
    }
    if (!isSize(size)) return { code: 'invalid_arguments' };
    if (name === 'check_policy') return eligible(order, size);
    const available = await this.inventory(this.db, order.sku, size);
    return { code: available > 0 ? 'in_stock' : 'out_of_stock', available };
  }

  private async prepare(id: string, size: Size): Promise<Result> {
    return this.db.transaction(async tx => {
      const order = await this.ownedOrder(tx, id, true);
      if (!order) return { code: 'order_not_found' };
      const existing = (await tx.query<Proposal>('SELECT * FROM proposals WHERE order_id=$1', [id])).rows[0];
      if (existing) {
        return existing.size === size ? { code: 'already_prepared', proposal: existing } : { code: 'proposal_conflict' };
      }
      const policy = eligible(order, size);
      if (policy.code !== 'eligible') return policy;
      if (!await this.inventory(tx, order.sku, size)) return { code: 'out_of_stock' };
      const proposal = (await tx.query<Proposal>(
        "INSERT INTO proposals VALUES ($1,$2,$3,'pending') RETURNING *", [`change-${id}`, id, size])).rows[0];
      return { code: 'prepared', proposal };
    });
  }

  async approve(id: string): Promise<Result> {
    if (this.stockDrift) {
      this.stockDrift = false;
      await this.db.query(`UPDATE inventory i SET available = 0 FROM proposals p JOIN orders o ON o.id=p.order_id
        WHERE p.id=$1 AND p.state='pending' AND o.customer=$2 AND i.sku=o.sku AND i.size=p.size`, [id, this.actor]);
    }
    const result = await this.db.transaction<Result>(async tx => {
      const proposal = (await tx.query<Proposal>(`SELECT p.* FROM proposals p JOIN orders o ON o.id=p.order_id
        WHERE p.id=$1 AND o.customer=$2 FOR UPDATE OF p`, [id, this.actor])).rows[0];
      if (!proposal) return { code: 'proposal_not_found' };
      if (proposal.state === 'approved') return { code: 'already_committed', shipment: id, replayed: true };
      if (proposal.state === 'rejected') return { code: 'rejected' };
      const order = await this.ownedOrder(tx, proposal.order_id);
      if (!order) return { code: 'order_not_found' };
      const policy = eligible(order, proposal.size);
      if (policy.code !== 'eligible') return policy;
      const inventory = await tx.query(
        'UPDATE inventory SET available = available - 1 WHERE sku=$1 AND size=$2 AND available > 0 RETURNING available',
        [order.sku, proposal.size]);
      if (!inventory.rows.length) return { code: 'out_of_stock' };
      await tx.query('INSERT INTO shipments VALUES ($1,$2,$3)', [id, proposal.order_id, proposal.size]);
      await tx.query("UPDATE proposals SET state='approved' WHERE id=$1", [id]);
      return { code: 'committed', shipment: id, replayed: false };
    });
    if (result.code === 'committed' && this.lostResponse) {
      this.lostResponse = false;
      return { code: 'response_lost' };
    }
    return result;
  }

  async reject(id: string): Promise<Result> {
    const { rows } = await this.db.query<Proposal>(`UPDATE proposals p SET state='rejected' FROM orders o
      WHERE p.id=$1 AND o.customer=$2 AND p.order_id=o.id AND p.state='pending' RETURNING p.*`, [id, this.actor]);
    return { code: rows.length ? 'rejected' : 'not_pending' };
  }

  async snapshot() {
    const proposals = (await this.db.query<Proposal>('SELECT * FROM proposals ORDER BY id')).rows;
    const shipments = (await this.db.query<{ proposal_id: string; size: Size }>('SELECT proposal_id,size FROM shipments')).rows;
    const inventory = (await this.db.query<{ size: Size; available: number }>('SELECT size,available FROM inventory ORDER BY size')).rows;
    return { proposals, shipments, inventory };
  }

  close() { return this.db.close(); }
}
