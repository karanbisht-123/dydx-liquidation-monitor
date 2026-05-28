/**
 * Standalone dYdX position inspector — no DB, no Redis, no NestJS bootstrap.
 * Calls the dYdX Indexer directly using native fetch.
 *
 * Usage:
 *   npx ts-node src/trigger-mock-alert.ts [address]
 *
 * Default address:
 *   dydx1w6fj9876n6fx260twv8hrqpagylgwn0zm5p5ek
 */

const DYDX_BASE_URL = 'https://indexer.dydx.trade/v4';
const TIMEOUT_MS    = 10_000;
const MAX_RETRIES   = 3;

const TEST_ADDRESS =
  process.argv[2] ?? 'dydx1w6fj9876n6fx260twv8hrqpagylgwn0zm5p5ek';

// ── helpers ──────────────────────────────────────────────────────────────────

async function httpGet<T>(url: string): Promise<T> {
  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(tid);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_RETRIES) {
          const wait = 2 ** attempt * 1000;
          console.warn(`HTTP ${res.status} — retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms`);
          await sleep(wait);
          attempt++;
          continue;
        }
        throw new Error(`HTTP ${res.status} after ${MAX_RETRIES} retries`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(tid);
      const msg = (err as Error).message;
      if (attempt < MAX_RETRIES && !msg.startsWith('HTTP')) {
        console.warn(`Fetch error — retry ${attempt + 1}/${MAX_RETRIES}: ${msg}`);
        await sleep(2 ** attempt * 1000);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── liq price formulas ───────────────────────────────────────────────────────

interface PositionRow {
  market: string;
  subaccountNumber: number;
  marginType: 'CROSS' | 'ISOLATED';
  side: 'LONG' | 'SHORT';
  signedSize: number;
  entryPrice: number;
  equity: number;
  mmf: number;
  oraclePrice: number;
  liqPrice: number | null;
  distancePct: number | null;
}

function calcLiqPrice(pos: PositionRow, group: PositionRow[]): number | null {
  const { signedSize: s, entryPrice: p, equity: e, mmf, oraclePrice, marginType, market } = pos;
  if (!s || !p || e <= 0) return null;
  const absS = Math.abs(s);
  const denom = absS * mmf - s;
  if (denom === 0) return null;

  let liq: number;
  if (marginType === 'ISOLATED') {
    liq = (e - s * p) / denom;
  } else {
    const mmrOther = group
      .filter((x) => x.market !== market)
      .reduce((sum, x) => sum + Math.abs(x.signedSize) * x.oraclePrice * x.mmf, 0);
    liq = (e - s * p - mmrOther) / denom;
  }

  return liq > 0 ? liq : null;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log(`\n🔍 Fetching ALL subaccounts for: ${TEST_ADDRESS}\n`);

  // 1. Fetch all subaccounts
  const addrData = await httpGet<{
    subaccounts: Array<{
      subaccountNumber: number;
      equity: string;
      openPerpetualPositions: Record<
        string,
        { market: string; side: 'LONG' | 'SHORT'; status: string; size: string; entryPrice: string }
      >;
    }>;
  }>(`${DYDX_BASE_URL}/addresses/${TEST_ADDRESS}`);

  if (!addrData.subaccounts?.length) {
    console.log('⚠️  No subaccounts found for this address.');
    return;
  }

  // 2. Fetch all market params (single call)
  const marketsData = await httpGet<{
    markets: Record<
      string,
      { oraclePrice: string; maintenanceMarginFraction: string; initialMarginFraction: string }
    >;
  }>(`${DYDX_BASE_URL}/perpetualMarkets`);

  // 3. Build flat position list
  const positions: PositionRow[] = [];

  for (const sub of addrData.subaccounts) {
    const equity = parseFloat(sub.equity);
    const marginType = sub.subaccountNumber >= 128 ? 'ISOLATED' : 'CROSS';

    for (const [, pos] of Object.entries(sub.openPerpetualPositions ?? {})) {
      if (pos.status !== 'OPEN') continue;
      const size = parseFloat(pos.size);
      const entryPrice = parseFloat(pos.entryPrice);
      if (!size || !entryPrice || isNaN(size) || isNaN(entryPrice)) {
        console.warn(`  ⚠️  Skipping ${pos.market} — invalid size/entryPrice`);
        continue;
      }
      const market = marketsData.markets[pos.market];
      if (!market) {
        console.warn(`  ⚠️  Market ${pos.market} not in perpetualMarkets — skipping`);
        continue;
      }
      positions.push({
        market: pos.market,
        subaccountNumber: sub.subaccountNumber,
        marginType,
        side: pos.side,
        signedSize: pos.side === 'LONG' ? size : -size,
        entryPrice,
        equity,
        mmf: parseFloat(market.maintenanceMarginFraction),
        oraclePrice: parseFloat(market.oraclePrice),
        liqPrice: null,
        distancePct: null,
      });
    }
  }

  if (!positions.length) {
    console.log('📭  No OPEN positions found for this address.\n');
    return;
  }

  // 4. Enrich with liq prices (group by subaccount)
  const groups = new Map<number, PositionRow[]>();
  for (const p of positions) {
    const g = groups.get(p.subaccountNumber) ?? [];
    g.push(p);
    groups.set(p.subaccountNumber, g);
  }

  const enriched: PositionRow[] = [];
  for (const group of groups.values()) {
    for (const pos of group) {
      const liqPrice = calcLiqPrice(pos, group);
      const distancePct =
        liqPrice !== null ? ((liqPrice - pos.oraclePrice) / pos.oraclePrice) * 100 : null;
      enriched.push({ ...pos, liqPrice, distancePct });
    }
  }

  // 5. Print table
  console.log(`Found ${enriched.length} open position(s)\n`);
  console.log('┌─ POSITION DETAILS ─────────────────────────────────────────────────────┐');

  for (const pos of enriched) {
    const dist  = pos.distancePct !== null ? `${pos.distancePct.toFixed(2)}%` : 'N/A';
    const liq   = pos.liqPrice   !== null ? `$${pos.liqPrice.toFixed(2)}`    : 'N/A';
    const absDist = pos.distancePct !== null ? Math.abs(pos.distancePct) : Infinity;
    const risk  =
      absDist <= 5  ? '🔴 CRITICAL' :
      absDist <= 15 ? '🟡 WARNING'  :
                      '🟢 SAFE';

    console.log(`│  Market:        ${pos.market}`);
    console.log(`│  Sub#:          ${pos.subaccountNumber}  (${pos.marginType})`);
    console.log(`│  Side:          ${pos.side}`);
    console.log(`│  Signed Size:   ${pos.signedSize}`);
    console.log(`│  Entry Price:   $${pos.entryPrice.toFixed(4)}`);
    console.log(`│  Oracle Price:  $${pos.oraclePrice.toFixed(4)}`);
    console.log(`│  Equity:        $${pos.equity.toFixed(4)}`);
    console.log(`│  MMF:           ${(pos.mmf * 100).toFixed(3)}%`);
    console.log(`│  Liq Price:     ${liq}`);
    console.log(`│  Distance:      ${dist}  ${risk}`);
    console.log('│');
  }

  console.log('└─────────────────────────────────────────────────────────────────────────┘\n');
}

run().catch((err) => {
  console.error('\n❌ Test script failed:', (err as Error).message);
  process.exit(1);
});
