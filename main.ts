// btc-race-24h-20261123-0511 — mean-reversion swing bot on cbBTC/USDC.
//
// Strategy, in one paragraph: the bot watches the 180-bar (3-hour) simple
// moving average of the 1-minute closes. It only buys a dip when the
// deviation from that average crosses back UP through -35 bps (the price
// stopped falling and turned), sizing 95% of equity. Once in, it arms a
// trailing stop after the deviation reaches +40 bps and sells when the
// deviation falls 15 bps from its peak since entry; a -90 bps deviation
// or 900 bars held cut the trade, and entries wait 2 bars after an exit.
//
// Everything is deterministic: plain float64 arithmetic over the closes
// seen so far, no clock, no randomness, no lookahead (only bars the
// harness has already sent). Prices are handled in the raw integer units
// the protocol carries; the deviation ratio makes the scale cancel out.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, Order } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Strategy parameters (bps unless noted).
const SMA_BARS = 180; // 3 hours of 1-minute bars
const ENTRY_CROSS_BPS = -35; // buy when deviation crosses back up through this
const ARM_BPS = 40; // trailing stop arms once deviation reaches this
const TRAIL_DROP_BPS = 15; // sell when deviation falls this far from its peak
const CUT_BPS = -90; // fail cut: sell if deviation sinks to this
const TIME_STOP_BARS = 900; // sell after holding this many bars
const COOLDOWN_BARS = 2; // bars to wait after an exit before re-entering
const SIZE_BPS = 9500; // 95% of equity per entry
const IMPACT_CAP_BPS = 25; // never let one buy move its own price more than this
const MAX_SLIPPAGE_BPS = 150;
const MIN_NOTIONAL = 1_000_000n; // 1 USDC in quote units

// Rolling state. All of it is derived only from bars already received.
let barIndex = -1; // counts CBBTC bars seen (increments once per bar)
let closes: number[] = []; // raw closes, oldest first, at most SMA_BARS long
let closesSum = 0; // running sum of `closes`, for the SMA
let prevDevBps = 0; // deviation on the previous bar
let havePrevDev = false;
let inPosition = false; // true once a buy fill is confirmed
let pendingBuy = false; // a buy order is out, awaiting its fill report
let pendingSell = false; // a sell order is out, awaiting its fill report
let pendingBuyBar = -1; // bar index the pending buy was decided on
let pendingSellBar = -1; // bar index the pending sell was decided on
let entryBar = -1; // bar index the current position was entered on
let lastExitBar = -1_000_000; // bar index of the most recent exit decision
let peakDevBps = -Infinity; // highest deviation since entry
let armed = false; // trailing stop armed for the current position

// Fold one close into the rolling window and return the current deviation
// from the 180-bar SMA in bps, or null until the window is full.
function observeClose(closeRaw: bigint): number | null {
  const close = Number(closeRaw);
  closes.push(close);
  closesSum += close;
  if (closes.length > SMA_BARS) {
    closesSum -= closes.shift() as number;
  }
  if (closes.length < SMA_BARS) return null;
  const sma = closesSum / SMA_BARS;
  return ((close - sma) / sma) * 10000;
}

// Size a buy in quote units: 95% of equity, trimmed so the trade's own
// price impact stays under the cap, and never more than the cash on hand.
function sizeBuy(state: BarsState): bigint {
  let notional = (state.equity * BigInt(SIZE_BPS)) / 10000n;
  if (notional > state.cash) notional = state.cash;
  // Impact is only approximately linear in size, so trim, re-measure
  // once, and trim again if still over the cap.
  for (let pass = 0; pass < 2; pass += 1) {
    const impact = state.impactBps(SYMBOL, notional);
    if (impact === null || impact <= BigInt(IMPACT_CAP_BPS)) break;
    notional = (notional * BigInt(IMPACT_CAP_BPS)) / impact;
  }
  if (notional > state.cash) notional = state.cash;
  return notional;
}

function buyOrder(notional: bigint): Order {
  return {
    side: 'buy',
    client_id: 'b' + String(barIndex),
    symbol: SYMBOL,
    notional_quote_units: notional,
    max_slippage_bps: MAX_SLIPPAGE_BPS,
  };
}

function sellOrder(qty: bigint): Order {
  return {
    side: 'sell',
    client_id: 's' + String(barIndex),
    symbol: SYMBOL,
    qty,
    max_slippage_bps: MAX_SLIPPAGE_BPS,
  };
}

await runBars({
  onBatch(state: BarsState, batch: Batch): Order[] {
    // No CBBTC bar in this batch: nothing new to decide on.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (!bar) return [];
    barIndex += 1;

    // Reconcile fills reported on this batch with our pending orders.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL) continue;
      if (fill.client_id.startsWith('b')) {
        if (fill.status === 'filled') {
          inPosition = true;
          pendingBuy = false;
          entryBar = pendingBuyBar;
          peakDevBps = -Infinity;
          armed = false;
        } else {
          pendingBuy = false;
        }
      } else if (fill.client_id.startsWith('s')) {
        if (fill.status === 'filled') {
          inPosition = false;
          pendingSell = false;
          lastExitBar = pendingSellBar;
          peakDevBps = -Infinity;
          armed = false;
        } else {
          pendingSell = false;
        }
      }
    }
    // Safety net: if the account holds the asset but our flags disagree,
    // trust the account.
    const held = state.positions.get(SYMBOL);
    if (held !== undefined && held.qty > 0n && !inPosition && !pendingBuy) {
      inPosition = true;
      if (entryBar < 0) entryBar = barIndex;
    }
    if (held === undefined || held.qty === 0n) {
      if (!pendingBuy) inPosition = false;
    }

    if (state.warmingUp) return [];

    const close = state.close(SYMBOL);
    if (close === null) return [];
    const dev = observeClose(close);
    if (dev === null) return []; // SMA window not full yet

    // Track the previous bar's deviation on EVERY bar, including bars
    // spent inside a position: the entry cross test after an exit must
    // compare against the immediately preceding bar, not a stale value
    // from before the trade. Capture it before the branches below, and
    // only then decide.
    const prev = havePrevDev ? prevDevBps : null;
    prevDevBps = dev;
    havePrevDev = true;

    if (inPosition && !pendingSell) {
      // --- EXIT logic ---
      if (dev >= ARM_BPS) armed = true;
      if (dev > peakDevBps) peakDevBps = dev;
      const barsHeld = barIndex - entryBar;
      const trailingHit = armed && dev <= peakDevBps - TRAIL_DROP_BPS;
      const cutHit = dev <= CUT_BPS;
      const timeHit = barsHeld >= TIME_STOP_BARS;
      if (trailingHit || cutHit || timeHit) {
        const qty = held !== undefined ? held.qty : 0n;
        if (qty > 0n) {
          pendingSell = true;
          pendingSellBar = barIndex;
          return [sellOrder(qty)];
        }
      }
      return [];
    }

    if (!inPosition && !pendingBuy) {
      // --- ENTRY logic: deviation crossing back up through -35 bps ---
      const crossedUp = prev !== null && prev < ENTRY_CROSS_BPS && dev >= ENTRY_CROSS_BPS;
      const cooledDown = barIndex - lastExitBar >= COOLDOWN_BARS;
      if (crossedUp && cooledDown) {
        const notional = sizeBuy(state);
        if (notional >= MIN_NOTIONAL) {
          pendingBuy = true;
          pendingBuyBar = barIndex;
          return [buyOrder(notional)];
        }
      }
    }

    return [];
  },
});
