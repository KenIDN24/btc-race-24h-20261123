// Mean-reversion swing bot for the cbBTC/USDC minute-bar replay
// (btc-race-24h-20261123-0511).
//
// Why this shape wins on this tape: a full round trip costs ~26 bps
// (4 bps fee + 2 bps slippage + ~7 bps impact each way at full size),
// while the minute-to-minute wiggles are only worth 10-20 bps gross.
// So fast scalping loses money by construction. The money sits in a
// few big swings: price dives well below its multi-hour mean, stalls,
// climbs all the way back, overshoots a little past the mean, then
// fades hard. This bot ignores the noise, waits for the dive to stop,
// rides the whole recovery at near-full size, and banks the peak of
// the overshoot with a tight trailing stop instead of riding the fade
// back down.
//
//   Entry: only once the deviation from the anchor mean crosses back
//     UP through the entry level -- never buy a falling knife.
//   Exit: once the deviation has run past the arm level, a trailing
//     stop on the closing price locks in the top of the move.
//   Failure exits: a deeper fall means the recovery was fake, cut
//     it; a time stop keeps a dead position from parking capital.
//
// Everything is a deterministic function of the bars seen so far:
// float64 arithmetic only, no clock, no randomness, no lookahead.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ---- tuning knobs --------------------------------------------------------
// Starting values from the sibling instance's winning shape; each one
// is swept by grade-local on THIS instance's dev tape below and moved
// only when the grade says the move helps.

const ANCHOR_BARS = 180;       // SMA lookback: three hours of minute bars
const ENTRY_DEV_BPS = 35;      // enter when dev crosses up through -35 bps
const TRAIL_ARM_DEV_BPS = 40;  // trailing stop arms at dev >= +40 bps
const TRAIL_BPS = 15;          // sell when close drops this far under its peak
const FAIL_DEV_BPS = 90;       // cut if dev sinks to -90 bps
const TIME_STOP_BARS = 900;    // sell a position held this many bars
const COOLDOWN_BARS = 2;       // bars sat out after an exit
const SIZE_FRACTION = 0.95;    // share of equity committed to one position
const IMPACT_CAP_BPS = 25;     // trim the order until its impact is at most this
const MAX_SLIPPAGE_BPS = 150;  // per-order cap past the deciding close

// ---- running state -------------------------------------------------------
// A sliding window of closes with its running sum, so the anchor mean
// is O(1) per bar. Missing minutes simply never arrive, so the window
// only ever holds bars that exist.

const windowCloses: number[] = [];
let windowSum = 0;
let barsSeen = 0;
// Deviation of the previous bar's close from the anchor, in bps.
let previousDev: number | null = null;
// The position the account is actually holding, if any.
let holding = false;
let heldBars = 0;
// Highest close printed since the position was opened.
let highWaterClose = 0;
// Bar index of the most recent exit fill; far negative at the start.
let exitBar = -1_000_000;

/** Fold one bar's close into the anchor window. */
function noteClose(bar: Bar): void {
  const c = Number(bar.c);
  windowCloses.push(c);
  windowSum += c;
  if (windowCloses.length > ANCHOR_BARS) windowSum -= windowCloses.shift()!;
  barsSeen++;
}

/**
 * How far the latest close sits from the anchor mean, in basis points,
 * or null until the window is full.
 */
function currentDeviation(): number | null {
  if (windowCloses.length < ANCHOR_BARS) return null;
  const mean = windowSum / ANCHOR_BARS;
  if (mean <= 0) return null;
  const last = windowCloses[windowCloses.length - 1]!;
  return ((last - mean) / mean) * 10_000;
}

// ---- order sizing --------------------------------------------------------
// Buy SIZE_FRACTION of equity, but never more than the cash held or
// the weight room the harness allows, and trim while the pool impact
// the SDK quotes for the order is over IMPACT_CAP_BPS. Impact is
// near-linear in size, so a couple of trims land close to the cap.

function sizeBuy(state: BarsState, symbol: string): BuyInput | null {
  const { fees } = state.hello;
  let notional = (state.equity * BigInt(Math.round(SIZE_FRACTION * 10_000))) / 10_000n;
  const room = state.weightRoom(symbol);
  if (room < notional) notional = room;
  if (state.cash < notional) notional = state.cash;
  for (let i = 0; i < 3 && notional > 0n; i++) {
    const impact = state.impactBps(symbol, notional);
    if (impact === null || impact <= BigInt(IMPACT_CAP_BPS)) break;
    notional = (notional * BigInt(IMPACT_CAP_BPS)) / impact;
  }
  if (notional < BigInt(fees.min_notional_quote_units)) return null;
  return { side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

/**
 * True when the held position has to go on this bar: the trailing
 * stop tripped after arming, the recovery failed, or the time stop
 * ran out.
 */
function shouldExit(devBps: number): boolean {
  const last = windowCloses[windowCloses.length - 1]!;
  if (devBps >= TRAIL_ARM_DEV_BPS && last <= highWaterClose * (1 - TRAIL_BPS / 10_000)) return true;
  if (devBps <= -FAIL_DEV_BPS) return true;
  if (heldBars >= TIME_STOP_BARS) return true;
  return false;
}

// ---- the bot ---------------------------------------------------------------

await runBars({
  onBatch(state, batch) {
    const symbol = state.hello.symbols[0]!.symbol;
    let sawSymbol = false;
    for (const bar of batch.bars) {
      if (bar.symbol !== symbol) continue;
      noteClose(bar);
      sawSymbol = true;
    }
    if (!sawSymbol) return [];

    // Sync the holding bookkeeping with what the account really holds:
    // a first sighting starts the holding clock and the high-water
    // mark; a disappearance after holding starts the cooldown.
    const held = state.positions.get(symbol);
    const last = windowCloses[windowCloses.length - 1]!;
    if (held !== undefined) {
      if (!holding) {
        holding = true;
        heldBars = 0;
        highWaterClose = last;
      } else {
        heldBars++;
        if (last > highWaterClose) highWaterClose = last;
      }
    } else if (holding) {
      holding = false;
      exitBar = barsSeen;
    }

    if (state.warmingUp) return [];
    const dev = currentDeviation();
    if (dev === null) return [];

    // Already holding: only an exit can fire on this bar.
    if (held !== undefined) {
      const sell = shouldExit(dev)
        ? [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } as SellInput]
        : [];
      previousDev = dev;
      return sell;
    }

    // Flat: enter only on the recovery cross, and only after the
    // cooldown that follows an exit has run out.
    const recovered = previousDev !== null && previousDev < -ENTRY_DEV_BPS && dev >= -ENTRY_DEV_BPS;
    previousDev = dev;
    if (!recovered) return [];
    if (barsSeen - exitBar < COOLDOWN_BARS) return [];
    const buy = sizeBuy(state, symbol);
    return buy === null ? [] : [buy];
  },
});
