// Pump.fun Bot Sprint — a momentum bot for the pump.fun bonding-curve replay.
//
// Strategy in one paragraph: watch every fresh curve's tape, buy only mature curves whose
// recent tape shows accelerating buy pressure from several distinct wallets with the price
// sitting near its window high, start small and pyramid into strength, and exit whole on a
// stop loss, a take profit, a trailing stop once armed, a fade in flow, a single big sell,
// or a time limit. Tiny probe round trips guarantee the 20-coin guardrail even on a quiet
// tape. Everything is deterministic: no clock, no environment, no unseeded randomness, so
// two runs of the replay produce byte-identical action logs.
//
// Wire: the harness speaks agent-fun/replay/v2 over stdin/stdout as newline-delimited JSON.
// It sends one hello line, then one batch per slot, then done. This bot answers every batch
// with exactly one reply line carrying the orders decided on that slot. Diagnostics go to
// stderr only; stdout carries replies and nothing else.

const PROTOCOL = "agent-fun/replay/v2";
const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;
const MAX_BOT_LINE_BYTES = 65_536;
const MAX_HARNESS_LINE_BYTES = 1_048_576;
const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;
const U64_MAX = 18_446_744_073_709_551_615n;

// ---------------------------------------------------------------- tuning

const P = {
  // Entry window, in slots (a slot is ~0.4 s of chain time).
  window: 30,
  // Net SOL flowing in (buys minus sells) over the entry window.
  minNetSol: 0.5,
  // Buy trades inside the window.
  minBuys: 3,
  // Distinct wallets buying inside the window.
  minBuyers: 4,
  // Price now vs price at the window start: at least +4%, at most +120%.
  minUp: 0.04,
  maxUp: 1.2,
  // Net inflow in the newer half of the window must be at least this multiple of the
  // older half's: the flow is still accelerating, not stalling.
  accel: 0.8,
  // Price now must sit at least this close to the window high.
  nearHigh: 0.88,
  // No single wallet may supply more than this share of the window's buy SOL.
  maxBuyerShare: 0.7,
  // Real SOL reserve bounds at entry: liquid enough to trade, far from migration.
  minRqSol: 0.5,
  maxRqSol: 60,
  // Slots since the CreateEvent before an entry is allowed: skip bundled launches.
  minAge: 40,
  // Sizing, in SOL.
  firstBuySol: 0.06,
  addSol: 0.06,
  maxStakeSol: 0.24,
  // Add only once the price is this far above the last buy's decision price.
  addStep: 0.02,
  // Add only while the position is not underwater.
  addIfUp: 0.0,
  // Exits, as multiples of cost.
  stopLoss: 0.88,
  takeProfit: 1.35,
  // Trailing stop: arms at +20%, then exits when value falls 10% below its peak.
  trailArm: 1.2,
  trail: 0.9,
  // Fade exit: net SOL over the fade window below this.
  fadeWindow: 20,
  fadeNetSol: -0.3,
  // Exit on any single recorded sell of at least this many SOL.
  bigSellSol: 1.0,
  // Time limit in slots; waived while the position is up at least holdIfUp.
  maxHold: 1500,
  holdIfUp: 1.1,
  // Slots to wait after an exit before the same curve may be bought again.
  cooldown: 600,
  // Most entries per curve over the run.
  maxEntries: 2,
  // Most momentum positions open at once (the rest of the cap is for probes).
  maxMain: 4,
  // Slippage guardrails, in bps.
  buySlipBps: 800,
  sellSlipBps: 5000,
  // Guardrail probes: tiny round trips that keep the distinct-coins count on pace.
  probeSol: 0.02,
  probeGapSlots: 600,
  // Drawdown circuit breakers, as a share of the equity peak.
  pauseDrawdown: 0.35,
  flattenDrawdown: 0.45,
};

// ---------------------------------------------------------------- wire types

type U64 = string;
type Pubkey = string;

interface Hello {
  type: "hello";
  protocol: string;
  seed: U64;
  universe: unknown;
  capital: { lamports: U64 };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: false;
    leverage: false;
  };
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: U64;
    priority_fee_lamports: U64;
    failed_tx_bps: number;
  };
}

interface ChainEvent {
  event: "TradeEvent" | "CreateEvent" | "CompleteEvent";
  mint: Pubkey;
  slot: number;
  [k: string]: unknown;
}

interface Mark {
  mint: Pubkey;
  slot: number;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
}

interface Fill {
  client_id: string;
  mint: Pubkey;
  side: "buy" | "sell";
  status: "filled" | "rejected" | "failed";
  reason: string | null;
  decided_slot: number;
  slot: number;
  quote_lamports: U64;
  token_amount: U64;
  fee_lamports: U64;
  tx_fee_lamports: U64;
  fee_fallback: boolean;
}

interface Position {
  mint: Pubkey;
  token_amount: U64;
  cost_lamports: U64;
}

interface Batch {
  type: "batch";
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: Mark[];
  fills: Fill[];
  account: { cash_lamports: U64; positions: Position[] };
}

interface Done {
  type: "done";
  seq: number;
  reason: "end_of_data" | "aborted";
  account: { cash_lamports: U64; positions: Position[] };
}

type Order =
  | { side: "buy"; client_id: string; mint: Pubkey; quote_lamports: U64; max_slippage_bps: number }
  | { side: "sell"; client_id: string; mint: Pubkey; token_amount: U64; max_slippage_bps: number };

// ---------------------------------------------------------------- errors

class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

class OrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderError";
  }
}

// ---------------------------------------------------------------- per-curve tape

interface TapeTrade {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: string;
}

interface PricePoint {
  slot: number;
  price: number; // virtual quote per virtual token, as a plain number
}

interface Curve {
  mint: Pubkey;
  createdSlot: number | null;
  vToken: bigint;
  vQuote: bigint;
  realToken: bigint;
  realQuote: bigint;
  reservesSlot: number;
  trades: number;
  complete: boolean;
  tape: TapeTrade[];
  prices: PricePoint[];
}

interface HeldMeta {
  firstBuySlot: number;
  peakValue: bigint;
  lastBuyPrice: number;
  entries: number;
  probe: boolean;
}

function sol(n: number): bigint {
  return BigInt(Math.round(n * 1e9));
}

// ---------------------------------------------------------------- the bot

class Bot {
  hello!: Hello;
  cash = 0n;
  positions = new Map<Pubkey, { tokens: bigint; cost: bigint }>();
  curves = new Map<Pubkey, Curve>();
  pending = new Map<string, { order: Order; decidedSlot: number }>();
  meta = new Map<Pubkey, HeldMeta>();
  cooldownUntil = new Map<Pubkey, number>();
  entriesUsed = new Map<Pubkey, number>();
  coinsRoundTripped = new Set<Pubkey>();
  boughtCoins = new Set<Pubkey>();
  soldCoins = new Set<Pubkey>();
  nextClient = 1;
  usedIds = new Set<string>();
  seq = -1;
  slot = -1;
  firstSlot = -1;
  equityPeak = 0n;
  lastProbeSlot = -1_000_000;
  buysSent = 0;
  sellsSent = 0;
  batches = 0;

  clientId(): string {
    for (;;) {
      const id = `o${this.nextClient++}`;
      if (!this.usedIds.has(id)) {
        this.usedIds.add(id);
        return id;
      }
    }
  }

  txFee(): bigint {
    return BigInt(this.hello.fees.base_fee_lamports) + BigInt(this.hello.fees.priority_fee_lamports);
  }

  maxBuy(mint: Pubkey): bigint {
    const c = this.curves.get(mint);
    if (!c || c.complete) return 0n;
    return (c.realQuote * BigInt(this.hello.caps.max_order_bps_of_real_reserve)) / BPS;
  }

  freeCash(): bigint {
    let free = this.cash;
    const tx = this.txFee();
    for (const p of this.pending.values()) {
      free -= tx;
      if (p.order.side === "buy") free -= BigInt(p.order.quote_lamports);
    }
    return free;
  }

  committedCount(): number {
    const mints = new Set<Pubkey>(this.positions.keys());
    for (const p of this.pending.values()) {
      if (p.order.side === "buy") mints.add(p.order.mint);
    }
    return mints.size;
  }

  curve(mint: Pubkey, slot: number): Curve {
    let c = this.curves.get(mint);
    if (!c) {
      c = {
        mint,
        createdSlot: null,
        vToken: 0n,
        vQuote: 0n,
        realToken: 0n,
        realQuote: 0n,
        reservesSlot: slot,
        trades: 0,
        complete: false,
        tape: [],
        prices: [],
      };
      this.curves.set(mint, c);
    }
    return c;
  }

  priceOf(c: Curve): number {
    if (c.vToken === 0n) return 0;
    return Number(c.vQuote) / Number(c.vToken);
  }

  valueOf(mint: Pubkey): bigint {
    const c = this.curves.get(mint);
    const pos = this.positions.get(mint);
    if (!c || !pos || c.vToken === 0n) return 0n;
    return (pos.tokens * c.vQuote) / c.vToken;
  }

  equity(): bigint {
    let total = this.cash;
    for (const mint of this.positions.keys()) total += this.valueOf(mint);
    return total;
  }

  applyBatch(batch: Batch): void {
    this.seq = batch.seq;
    this.slot = batch.slot;
    if (this.firstSlot < 0) this.firstSlot = batch.slot;
    for (const f of batch.fills) {
      this.pending.delete(f.client_id);
      if (f.status === "filled") {
        if (f.side === "buy") this.boughtCoins.add(f.mint);
        if (f.side === "sell") this.soldCoins.add(f.mint);
        if (this.boughtCoins.has(f.mint) && this.soldCoins.has(f.mint)) {
          this.coinsRoundTripped.add(f.mint);
        }
      }
    }
    this.cash = BigInt(batch.account.cash_lamports);
    const held = new Set<Pubkey>();
    this.positions.clear();
    for (const p of batch.account.positions) {
      const tokens = BigInt(p.token_amount);
      if (tokens > 0n) {
        this.positions.set(p.mint, { tokens, cost: BigInt(p.cost_lamports) });
        held.add(p.mint);
      }
    }
    // A position that vanished was sold, flattened or completed: drop its metadata
    // and cool the mint down so we do not chase it straight back.
    for (const mint of [...this.meta.keys()]) {
      if (!held.has(mint)) {
        this.meta.delete(mint);
        this.cooldownUntil.set(mint, this.slot + P.cooldown);
      }
    }
    for (const m of batch.marks) {
      const c = this.curves.get(m.mint);
      if (!c || m.slot < c.reservesSlot) continue;
      c.vToken = BigInt(m.virtual_token_reserves);
      c.vQuote = BigInt(m.virtual_quote_reserves);
      c.realToken = BigInt(m.real_token_reserves);
      c.realQuote = BigInt(m.real_quote_reserves);
      c.reservesSlot = m.slot;
    }
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        const c = this.curve(e.mint, e.slot);
        c.createdSlot = e.slot;
        c.vToken = BigInt(e.virtual_token_reserves as string);
        c.vQuote = BigInt(e.virtual_quote_reserves as string);
        c.realToken = BigInt(e.real_token_reserves as string);
        c.realQuote = 0n;
        c.reservesSlot = e.slot;
        c.prices.push({ slot: e.slot, price: this.priceOf(c) });
      } else if (e.event === "TradeEvent") {
        const c = this.curve(e.mint, e.slot);
        c.vToken = BigInt(e.virtual_token_reserves as string);
        c.vQuote = BigInt(e.virtual_quote_reserves as string);
        c.realToken = BigInt(e.real_token_reserves as string);
        c.realQuote = BigInt(e.real_quote_reserves as string);
        c.reservesSlot = e.slot;
        c.trades += 1;
        c.tape.push({
          slot: e.slot,
          isBuy: e.is_buy as boolean,
          sol: BigInt(e.sol_amount as string),
          user: e.user as string,
        });
        c.prices.push({ slot: e.slot, price: this.priceOf(c) });
        const cutoff = e.slot - P.window - 10;
        while (c.tape.length > 0 && c.tape[0].slot < cutoff) c.tape.shift();
        while (c.prices.length > 0 && c.prices[0].slot < cutoff) c.prices.shift();
      } else {
        const c = this.curve(e.mint, e.slot);
        c.complete = true;
      }
    }
    const eq = this.equity();
    if (eq > this.equityPeak) this.equityPeak = eq;
  }

  // Window statistics for one curve at the current slot. Returns null when the
  // tape is too thin to judge.
  windowStats(c: Curve): {
    netSol: bigint;
    buys: number;
    buyers: Set<string>;
    startPrice: number;
    high: number;
    newNet: bigint;
    oldNet: bigint;
    buySol: bigint;
    topBuyer: bigint;
    bigSell: boolean;
  } | null {
    const from = this.slot - P.window;
    const tape = c.tape.filter((t) => t.slot >= from);
    if (tape.length < P.minBuys) return null;
    let netSol = 0n;
    let buySol = 0n;
    let buys = 0;
    const buyers = new Set<string>();
    const perBuyer = new Map<string, bigint>();
    let bigSell = false;
    const mid = this.slot - Math.floor(P.window / 2);
    let newNet = 0n;
    let oldNet = 0n;
    for (const t of tape) {
      const signed = t.isBuy ? t.sol : -t.sol;
      netSol += signed;
      if (t.slot >= mid) newNet += signed;
      else oldNet += signed;
      if (t.isBuy) {
        buys += 1;
        buySol += t.sol;
        buyers.add(t.user);
        perBuyer.set(t.user, (perBuyer.get(t.user) ?? 0n) + t.sol);
      } else if (t.sol >= sol(P.bigSellSol)) {
        bigSell = true;
      }
    }
    let topBuyer = 0n;
    for (const v of perBuyer.values()) if (v > topBuyer) topBuyer = v;
    const prices = c.prices.filter((p) => p.slot >= from);
    if (prices.length === 0) return null;
    let high = 0;
    for (const p of prices) if (p.price > high) high = p.price;
    return {
      netSol,
      buys,
      buyers,
      startPrice: prices[0].price,
      high,
      newNet,
      oldNet,
      buySol,
      topBuyer,
      bigSell,
    };
  }

  entrySignal(c: Curve): boolean {
    if (c.complete) return false;
    if (c.createdSlot === null || this.slot - c.createdSlot < P.minAge) return false;
    if (this.positions.has(c.mint)) return false;
    if ((this.entriesUsed.get(c.mint) ?? 0) >= P.maxEntries) return false;
    const cool = this.cooldownUntil.get(c.mint) ?? -1;
    if (this.slot < cool) return false;
    if (c.realQuote < sol(P.minRqSol) || c.realQuote > sol(P.maxRqSol)) return false;
    const s = this.windowStats(c);
    if (!s) return false;
    if (s.netSol < sol(P.minNetSol)) return false;
    if (s.buys < P.minBuys) return false;
    if (s.buyers.size < P.minBuyers) return false;
    if (s.startPrice <= 0) return false;
    const now = this.priceOf(c);
    const up = now / s.startPrice - 1;
    if (up < P.minUp || up > P.maxUp) return false;
    if (s.high <= 0 || now < s.high * P.nearHigh) return false;
    if (s.oldNet > 0n && s.newNet < (s.oldNet * BigInt(Math.round(P.accel * 100))) / 100n) return false;
    if (s.oldNet <= 0n && s.newNet <= 0n) return false;
    if (s.buySol > 0n && s.topBuyer * 100n > s.buySol * BigInt(Math.round(P.maxBuyerShare * 100))) return false;
    return true;
  }

  decide(batch: Batch): Order[] {
    const orders: Order[] = [];
    const cap = this.hello.caps.max_orders_per_batch;

    // Circuit breakers on drawdown, measured against the equity peak.
    const eq = this.equity();
    let drawdown = 0;
    if (this.equityPeak > 0n) {
      drawdown = Number(this.equityPeak - eq) / Number(this.equityPeak);
    }
    const mayEnter = drawdown < P.pauseDrawdown;

    // 1. Exits first: every held position is re-judged on this batch.
    for (const [mint, pos] of [...this.positions.entries()]) {
      const c = this.curves.get(mint);
      if (!c) continue;
      const value = this.valueOf(mint);
      const meta = this.meta.get(mint);
      let reason = "";
      if (drawdown >= P.flattenDrawdown) {
        reason = "flatten";
      } else if (meta?.probe) {
        reason = "probe";
      } else if (value <= (pos.cost * BigInt(Math.round(P.stopLoss * 100))) / 100n) {
        reason = "stop";
      } else if (value >= (pos.cost * BigInt(Math.round(P.takeProfit * 100))) / 100n) {
        reason = "take-profit";
      } else if (meta && value >= (pos.cost * BigInt(Math.round(P.trailArm * 100))) / 100n) {
        if (value > meta.peakValue) meta.peakValue = value;
        if (value <= (meta.peakValue * BigInt(Math.round(P.trail * 100))) / 100n) reason = "trail";
      } else if (meta && value > meta.peakValue) {
        meta.peakValue = value;
      }
      if (!reason && meta && !meta.probe) {
        const s = this.windowStats(c);
        if (s) {
          const fadeFrom = this.slot - P.fadeWindow;
          let fadeNet = 0n;
          for (const t of c.tape) {
            if (t.slot < fadeFrom) continue;
            fadeNet += t.isBuy ? t.sol : -t.sol;
          }
          if (fadeNet < sol(P.fadeNetSol)) reason = "fade";
          else if (s.bigSell) reason = "big-sell";
        }
        if (!reason && this.slot - meta.firstBuySlot > P.maxHold) {
          if (value < (pos.cost * BigInt(Math.round(P.holdIfUp * 100))) / 100n) reason = "time";
        }
      }
      if (reason) {
        orders.push({
          side: "sell",
          client_id: this.clientId(),
          mint,
          token_amount: pos.tokens.toString(),
          max_slippage_bps: P.sellSlipBps,
        });
      }
    }

    // 2. Pyramid adds into strength on positions that are still open.
    if (mayEnter) {
      for (const [mint, pos] of [...this.positions.entries()]) {
        if (orders.length >= cap) break;
        const c = this.curves.get(mint);
        const meta = this.meta.get(mint);
        if (!c || !meta || meta.probe) continue;
        if (orders.some((o) => o.mint === mint && o.side === "sell")) continue;
        if (pos.cost >= sol(P.maxStakeSol)) continue;
        if (this.priceOf(c) < meta.lastBuyPrice * (1 + P.addStep)) continue;
        const value = this.valueOf(mint);
        if (value < (pos.cost * BigInt(Math.round((1 + P.addIfUp) * 100))) / 100n) continue;
        const s = this.windowStats(c);
        if (!s || s.netSol < sol(P.minNetSol)) continue;
        const room = sol(P.maxStakeSol) - pos.cost;
        const want = room < sol(P.addSol) ? room : sol(P.addSol);
        const size = this.sizeBuy(mint, want);
        if (size >= sol(0.012)) {
          orders.push({
            side: "buy",
            client_id: this.clientId(),
            mint,
            quote_lamports: size.toString(),
            max_slippage_bps: P.buySlipBps,
          });
          meta.lastBuyPrice = this.priceOf(c);
        }
      }
    }

    // 3. Fresh entries: only curves that traded in this batch, strongest first.
    if (mayEnter && this.committedCount() < this.hello.caps.max_open_positions) {
      const touched = new Map<Pubkey, Curve>();
      for (const e of batch.events) {
        if (e.event === "TradeEvent") {
          const c = this.curves.get(e.mint);
          if (c) touched.set(e.mint, c);
        }
      }
      const candidates: { c: Curve; score: bigint }[] = [];
      for (const c of touched.values()) {
        if (this.positions.has(c.mint)) continue;
        if (this.pendingHasBuy(c.mint)) continue;
        if (!this.entrySignal(c)) continue;
        const s = this.windowStats(c);
        candidates.push({ c, score: s ? s.netSol : 0n });
      }
      candidates.sort((a, b) => (a.score > b.score ? -1 : a.score < b.score ? 1 : 0));
      for (const { c } of candidates) {
        if (orders.length >= cap) break;
        if (this.committedCount() + orders.filter((o) => o.side === "buy").length >= this.hello.caps.max_open_positions) break;
        if (this.positions.size + orders.filter((o) => o.side === "buy").length >= P.maxMain + 1) break;
        const size = this.sizeBuy(c.mint, sol(P.firstBuySol));
        if (size < sol(0.012)) continue;
        orders.push({
          side: "buy",
          client_id: this.clientId(),
          mint: c.mint,
          quote_lamports: size.toString(),
          max_slippage_bps: P.buySlipBps,
        });
        this.entriesUsed.set(c.mint, (this.entriesUsed.get(c.mint) ?? 0) + 1);
        this.meta.set(c.mint, {
          firstBuySlot: this.slot,
          peakValue: 0n,
          lastBuyPrice: this.priceOf(c),
          entries: this.entriesUsed.get(c.mint) ?? 1,
          probe: false,
        });
      }
    }

    // 4. Guardrail probes: if the distinct-coins count lags, open a tiny round trip
    // on the most liquid mature curve we have not traded yet.
    if (
      mayEnter &&
      this.coinsRoundTripped.size < 20 &&
      this.slot - this.lastProbeSlot >= P.probeGapSlots &&
      this.committedCount() < this.hello.caps.max_open_positions &&
      orders.length < cap
    ) {
      let best: Curve | null = null;
      for (const c of this.curves.values()) {
        if (c.complete || this.positions.has(c.mint) || this.pendingHasBuy(c.mint)) continue;
        if (this.boughtCoins.has(c.mint)) continue;
        if (c.createdSlot === null || this.slot - c.createdSlot < P.minAge) continue;
        if (c.realQuote < sol(2)) continue;
        if (!best || c.realQuote > best.realQuote) best = c;
      }
      if (best) {
        const size = this.sizeBuy(best.mint, sol(P.probeSol));
        if (size >= sol(0.012)) {
          orders.push({
            side: "buy",
            client_id: this.clientId(),
            mint: best.mint,
            quote_lamports: size.toString(),
            max_slippage_bps: P.buySlipBps,
          });
          this.meta.set(best.mint, {
            firstBuySlot: this.slot,
            peakValue: 0n,
            lastBuyPrice: this.priceOf(best),
            entries: 1,
            probe: true,
          });
          this.lastProbeSlot = this.slot;
        }
      }
    }

    return orders;
  }

  pendingHasBuy(mint: Pubkey): boolean {
    for (const p of this.pending.values()) {
      if (p.order.side === "buy" && p.order.mint === mint) return true;
    }
    return false;
  }

  // Size a buy against the per-mint reserve cap and free cash. Never returns an
  // amount under 0.012 SOL unless the cap itself is smaller, in which case 0.
  sizeBuy(mint: Pubkey, want: bigint): bigint {
    const cap = this.maxBuy(mint);
    let size = want < cap ? want : cap;
    const free = this.freeCash() - this.txFee();
    if (size > free) size = free;
    if (size < sol(0.012)) return 0n;
    return size;
  }

  recordOrders(orders: readonly Order[]): void {
    for (const o of orders) {
      this.pending.set(o.client_id, { order: o, decidedSlot: this.slot });
      if (o.side === "buy") this.buysSent += 1;
      else this.sellsSent += 1;
    }
  }
}

// ---------------------------------------------------------------- order validation

function toU64(value: unknown, what: string): U64 {
  let n: bigint | null = null;
  if (typeof value === "bigint") n = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === "string" && U64_RE.test(value)) n = BigInt(value);
  if (n === null || n < 0n || n > U64_MAX) {
    throw new OrderError(`${what} must be a u64, got ${String(value)}`);
  }
  return n.toString();
}

function checkOrders(result: unknown, bot: Bot): Order[] {
  if (result === undefined || result === null) return [];
  if (!Array.isArray(result)) throw new OrderError("onBatch must return an array of orders");
  const cap = bot.hello.caps.max_orders_per_batch;
  if (result.length > cap) {
    throw new OrderError(`returned ${result.length} orders, over max_orders_per_batch (${cap})`);
  }
  const taken = new Set<string>();
  const checked: Order[] = [];
  for (let i = 0; i < result.length; i++) {
    const o = result[i] as Record<string, unknown>;
    if (typeof o !== "object" || o === null || Array.isArray(o)) {
      throw new OrderError(`order ${i}: expected an order object`);
    }
    if (o.side !== "buy" && o.side !== "sell") {
      throw new OrderError(`order ${i}: side must be "buy" or "sell"`);
    }
    const allowed = o.side === "buy"
      ? ["side", "client_id", "mint", "quote_lamports", "max_slippage_bps"]
      : ["side", "client_id", "mint", "token_amount", "max_slippage_bps"];
    for (const k of Object.keys(o)) {
      if (!allowed.includes(k)) throw new OrderError(`order ${i}: unknown key "${k}"`);
    }
    if (typeof o.mint !== "string" || !PUBKEY_RE.test(o.mint)) {
      throw new OrderError(`order ${i}: mint must be a base58 address`);
    }
    const bps = o.max_slippage_bps;
    if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      throw new OrderError(`order ${i}: max_slippage_bps must be an integer 0..10000`);
    }
    let clientId: string;
    if (o.client_id !== undefined) {
      if (typeof o.client_id !== "string" || !CLIENT_ID_RE.test(o.client_id)) {
        throw new OrderError(`order ${i}: bad client_id`);
      }
      clientId = o.client_id;
      // Ids assigned by Bot.clientId() are already recorded in usedIds by design;
      // a duplicate is only an id repeated inside this one reply.
      if (taken.has(clientId)) {
        throw new OrderError(`order ${i}: duplicate client_id ${clientId}`);
      }
    } else {
      clientId = bot.clientId();
    }
    taken.add(clientId);
    bot.usedIds.add(clientId);
    if (o.side === "buy") {
      checked.push({
        side: "buy",
        client_id: clientId,
        mint: o.mint,
        quote_lamports: toU64(o.quote_lamports, `order ${i} quote_lamports`),
        max_slippage_bps: bps,
      });
    } else {
      checked.push({
        side: "sell",
        client_id: clientId,
        mint: o.mint,
        token_amount: toU64(o.token_amount, `order ${i} token_amount`),
        max_slippage_bps: bps,
      });
    }
  }
  return checked;
}

// ---------------------------------------------------------------- line loop

async function* readLines(input: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buf = new Uint8Array(0);
  let lineNo = 0;
  const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(a.byteLength + b.byteLength);
    out.set(a, 0);
    out.set(b, a.byteLength);
    return out;
  };
  for await (const chunk of input) {
    buf = concat(buf, chunk);
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) break;
      const piece = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
      if (buf.byteLength > MAX_HARNESS_LINE_BYTES) {
        throw new ProtocolError(`input line ${lineNo + 1} is over ${MAX_HARNESS_LINE_BYTES} bytes`);
      }
      lineNo++;
      let line = piece;
      if (line.byteLength > 0 && line[line.byteLength - 1] === 0x0d) {
        line = line.subarray(0, line.byteLength - 1);
      }
      yield decoder.decode(line);
    }
    if (buf.byteLength > MAX_HARNESS_LINE_BYTES) {
      throw new ProtocolError(`input line ${lineNo + 1} is over ${MAX_HARNESS_LINE_BYTES} bytes`);
    }
  }
  if (buf.byteLength > 0) {
    lineNo++;
    let line = buf;
    if (line.byteLength > 0 && line[line.byteLength - 1] === 0x0d) {
      line = line.subarray(0, line.byteLength - 1);
    }
    yield decoder.decode(line);
  }
}

function writeLine(text: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const ok = process.stdout.write(text);
    if (ok) resolve();
    else process.stdout.once("drain", resolve);
  });
}

async function main(): Promise<void> {
  const bot = new Bot();
  let lineNo = 0;
  let batches = 0;
  for await (const line of readLines(process.stdin as unknown as AsyncIterable<Uint8Array>)) {
    lineNo++;
    if (line.trim() === "") continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new ProtocolError(`input line ${lineNo} is not JSON`);
    }
    if (msg.type === "hello") {
      if (bot.seq !== -1) throw new ProtocolError(`input line ${lineNo}: a second hello`);
      const hello = msg as unknown as Hello;
      if (hello.protocol !== PROTOCOL) {
        throw new ProtocolError(`the harness speaks ${String(hello.protocol)}; this bot speaks ${PROTOCOL}`);
      }
      bot.hello = hello;
      bot.cash = BigInt(hello.capital.lamports);
      bot.equityPeak = bot.cash;
      console.error(`hello: capital ${hello.capital.lamports} lamports, seed ${hello.seed}`);
    } else if (msg.type === "batch") {
      const batch = msg as unknown as Batch;
      if (!bot.hello) throw new ProtocolError(`input line ${lineNo}: a batch before hello`);
      if (
        !Number.isSafeInteger(batch.seq) ||
        !Number.isSafeInteger(batch.slot) ||
        !Array.isArray(batch.events) ||
        !Array.isArray(batch.marks) ||
        !Array.isArray(batch.fills) ||
        typeof batch.account !== "object" ||
        batch.account === null ||
        !Array.isArray(batch.account.positions)
      ) {
        throw new ProtocolError(`input line ${lineNo}: malformed batch`);
      }
      bot.applyBatch(batch);
      const orders = checkOrders(bot.decide(batch), bot);
      const text = JSON.stringify({ type: "reply", seq: batch.seq, orders });
      if (new TextEncoder().encode(text).byteLength > MAX_BOT_LINE_BYTES) {
        throw new OrderError(`batch ${batch.seq}: reply over ${MAX_BOT_LINE_BYTES} bytes`);
      }
      bot.recordOrders(orders);
      await writeLine(`${text}\n`);
      batches++;
      if (batches % 5000 === 0) {
        console.error(
          `batch ${batch.seq} slot ${batch.slot}: cash ${bot.cash} equity ${bot.equity()} ` +
            `positions ${bot.positions.size} coins ${bot.coinsRoundTripped.size} ` +
            `buys ${bot.buysSent} sells ${bot.sellsSent}`,
        );
      }
    } else if (msg.type === "done") {
      const done = msg as unknown as Done;
      if (!bot.hello) throw new ProtocolError(`input line ${lineNo}: done before hello`);
      bot.cash = BigInt(done.account.cash_lamports);
      const pnl = bot.cash - BigInt(bot.hello.capital.lamports);
      console.error(
        `done (${done.reason}): final cash ${bot.cash} net PnL ${pnl} lamports ` +
          `(${(Number(pnl) / 1e9).toFixed(4)} SOL), batches ${batches}, buys ${bot.buysSent}, ` +
          `sells ${bot.sellsSent}, coins round-tripped ${bot.coinsRoundTripped.size}`,
      );
      return;
    } else {
      throw new ProtocolError(`input line ${lineNo}: unknown message type ${String(msg.type)}`);
    }
  }
  throw new ProtocolError(batches === 0 ? "input ended before hello" : `input ended before done (after ${batches} batches)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
});
