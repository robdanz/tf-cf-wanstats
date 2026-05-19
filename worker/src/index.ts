interface Env {
  DB: D1Database;
  WAN_API_TOKEN: string; // Cloudflare API token — Account Analytics: Read
  ACCOUNT_ID: string;    // Cloudflare account ID (non-secret var)
}

// Cloudflare docs are inconsistent: examples show both `datetimeFiveMinute`
// (singular) and `datetimeFiveMinutes` (plural). Accept both so cron writes
// never silently fail if the API returns the singular form.
interface TunnelMetricDimensions {
  tunnelName: string;
  datetimeFiveMinutes?: string;
  datetimeFiveMinute?: string;
}

interface TunnelMetricRow {
  avg: { bitRateFiveMinutes: number };
  dimensions: TunnelMetricDimensions;
}

interface GraphQLResponse {
  data?: {
    viewer: {
      accounts: Array<{
        magicTransitTunnelTrafficAdaptiveGroups: TunnelMetricRow[];
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

// ── GraphQL query ─────────────────────────────────────────────────────────────
const GRAPHQL_QUERY = `
  query GetTunnelBandwidth(
    $accountTag: string,
    $datetimeStart: string,
    $datetimeEnd: string,
    $direction: string
  ) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        magicTransitTunnelTrafficAdaptiveGroups(
          limit: 100,
          filter: {
            datetime_geq: $datetimeStart,
            datetime_lt: $datetimeEnd,
            direction: $direction
          }
        ) {
          avg {
            bitRateFiveMinutes
          }
          dimensions {
            tunnelName
            datetimeFiveMinutes
          }
        }
      }
    }
  }
`;

// ── API polling ───────────────────────────────────────────────────────────────

async function fetchTunnelMetrics(
  accountId: string,
  apiToken: string,
  direction: 'ingress' | 'egress',
  datetimeStart: string,
  datetimeEnd: string,
): Promise<TunnelMetricRow[]> {
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: GRAPHQL_QUERY,
      variables: { accountTag: accountId, direction, datetimeStart, datetimeEnd },
    }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as GraphQLResponse;
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(', ')}`);
  }

  return json.data?.viewer.accounts[0]?.magicTransitTunnelTrafficAdaptiveGroups ?? [];
}

// ── D1 storage ────────────────────────────────────────────────────────────────

async function storeTunnelMetrics(
  db: D1Database,
  rows: TunnelMetricRow[],
  direction: 'ingress' | 'egress',
): Promise<void> {
  if (rows.length === 0) return;
  const BATCH_SIZE = 100;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    await db.batch(
      chunk.map((row) => {
        // Accept both field name variants from the Cloudflare API
        const ts = row.dimensions.datetimeFiveMinutes ?? row.dimensions.datetimeFiveMinute;
        if (!ts) throw new Error(`Missing datetime dimension for tunnel ${row.dimensions.tunnelName}`);
        return db
          .prepare(
            'INSERT OR REPLACE INTO tunnel_metrics (tunnel_name, direction, ts, bit_rate) VALUES (?, ?, ?, ?)',
          )
          .bind(row.dimensions.tunnelName, direction, ts, row.avg.bitRateFiveMinutes);
      }),
    );
  }
}

// ── Cron handler ──────────────────────────────────────────────────────────────

async function handleCron(env: Env): Promise<void> {
  const now = new Date();
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
  const datetimeEnd = now.toISOString();
  const datetimeStart = tenMinutesAgo.toISOString();

  const [ingressRows, egressRows] = await Promise.all([
    fetchTunnelMetrics(env.ACCOUNT_ID, env.WAN_API_TOKEN, 'ingress', datetimeStart, datetimeEnd),
    fetchTunnelMetrics(env.ACCOUNT_ID, env.WAN_API_TOKEN, 'egress', datetimeStart, datetimeEnd),
  ]);

  console.log(`Fetched ${ingressRows.length} ingress rows, ${egressRows.length} egress rows`);

  await Promise.all([
    storeTunnelMetrics(env.DB, ingressRows, 'ingress'),
    storeTunnelMetrics(env.DB, egressRows, 'egress'),
  ]);

  console.log('Metrics stored successfully');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rangeToSince(range: string): string {
  const offsets: Record<string, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  return new Date(Date.now() - (offsets[range] ?? offsets['24h'])).toISOString();
}

// ── SQL constants ─────────────────────────────────────────────────────────────

// Per-tunnel p95 for a single direction and time range.
const P95_PER_TUNNEL_SQL = `
  WITH ranked AS (
    SELECT bit_rate AS val,
           ROW_NUMBER() OVER (ORDER BY bit_rate) AS rn,
           COUNT(*) OVER () AS n
    FROM tunnel_metrics
    WHERE tunnel_name = ? AND direction = ? AND ts >= ?
  )
  SELECT val FROM ranked WHERE rn = CAST(CEIL(0.95 * n) AS INTEGER) LIMIT 1
`;

// Aggregate p95: sum all tunnels per 5-min interval, then p95 of those sums.
// Mirrors Cloudflare's billing methodology.
const P95_AGGREGATE_SQL = `
  WITH totals AS (
    SELECT ts, SUM(bit_rate) AS val
    FROM tunnel_metrics
    WHERE direction = ? AND ts >= ?
    GROUP BY ts
  ),
  ranked AS (
    SELECT val,
           ROW_NUMBER() OVER (ORDER BY val) AS rn,
           COUNT(*) OVER () AS n
    FROM totals
  )
  SELECT val FROM ranked WHERE rn = CAST(CEIL(0.95 * n) AS INTEGER) LIMIT 1
`;

// All tunnels with their individual p95 ingress and egress — single query.
// Used by /api/tunnels so the frontend can sort and paginate without N+1 fetches.
const P95_ALL_TUNNELS_SQL = `
  WITH ranked AS (
    SELECT tunnel_name, direction, bit_rate AS val,
           ROW_NUMBER() OVER (PARTITION BY tunnel_name, direction ORDER BY bit_rate) AS rn,
           COUNT(*) OVER (PARTITION BY tunnel_name, direction) AS n
    FROM tunnel_metrics
    WHERE ts >= ?
  ),
  p95 AS (
    SELECT tunnel_name, direction, val AS p95_bps
    FROM ranked
    WHERE rn = CAST(CEIL(0.95 * n) AS INTEGER)
  )
  SELECT
    tunnel_name,
    MAX(CASE WHEN direction = 'ingress' THEN p95_bps END) AS p95_ingress_bps,
    MAX(CASE WHEN direction = 'egress'  THEN p95_bps END) AS p95_egress_bps
  FROM p95
  GROUP BY tunnel_name
  ORDER BY tunnel_name
`;

// ── HTTP API handlers ─────────────────────────────────────────────────────────

interface TunnelStat {
  tunnel_name: string;
  p95_ingress_bps: number | null;
  p95_egress_bps: number | null;
}

async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const range = url.searchParams.get('range') ?? '24h';
  const since = rangeToSince(range);

  // GET /api/tunnels?range= — all tunnels with per-tunnel p95 values.
  // Returns enough data for the frontend to sort, filter, and paginate
  // without additional requests.
  if (pathname === '/api/tunnels') {
    const { results } = await env.DB.prepare(P95_ALL_TUNNELS_SQL)
      .bind(since)
      .all<TunnelStat>();

    return Response.json({
      total: results.length,
      tunnels: results.map((r) => ({
        name: r.tunnel_name,
        p95_ingress_bps: r.p95_ingress_bps,
        p95_egress_bps: r.p95_egress_bps,
      })),
    });
  }

  // GET /api/summary?range= — aggregate p95 across all tunnels
  if (pathname === '/api/summary') {
    const [p95In, p95Eg] = await Promise.all([
      env.DB.prepare(P95_AGGREGATE_SQL).bind('ingress', since).first<{ val: number }>(),
      env.DB.prepare(P95_AGGREGATE_SQL).bind('egress', since).first<{ val: number }>(),
    ]);

    return Response.json({
      p95_ingress_bps: p95In?.val ?? null,
      p95_egress_bps: p95Eg?.val ?? null,
    });
  }

  // GET /api/metrics?tunnel=X&range= — time series + per-tunnel p95 for one tunnel
  if (pathname === '/api/metrics') {
    const tunnel = url.searchParams.get('tunnel');
    if (!tunnel) return new Response('Missing tunnel parameter', { status: 400 });

    const [ingress, egress, p95In, p95Eg] = await Promise.all([
      env.DB.prepare(
        "SELECT ts, bit_rate FROM tunnel_metrics WHERE tunnel_name = ? AND direction = 'ingress' AND ts >= ? ORDER BY ts",
      )
        .bind(tunnel, since)
        .all<{ ts: string; bit_rate: number }>(),
      env.DB.prepare(
        "SELECT ts, bit_rate FROM tunnel_metrics WHERE tunnel_name = ? AND direction = 'egress' AND ts >= ? ORDER BY ts",
      )
        .bind(tunnel, since)
        .all<{ ts: string; bit_rate: number }>(),
      env.DB.prepare(P95_PER_TUNNEL_SQL).bind(tunnel, 'ingress', since).first<{ val: number }>(),
      env.DB.prepare(P95_PER_TUNNEL_SQL).bind(tunnel, 'egress', since).first<{ val: number }>(),
    ]);

    return Response.json({
      ingress: ingress.results.map((r) => ({ ts: r.ts, bps: r.bit_rate })),
      egress: egress.results.map((r) => ({ ts: r.ts, bps: r.bit_rate })),
      p95_ingress_bps: p95In?.val ?? null,
      p95_egress_bps: p95Eg?.val ?? null,
    });
  }

  return new Response('Not found', { status: 404 });
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────
// Single-page app served directly from the worker.
// All embedded JS uses ES5-style syntax (var, function) to avoid backtick
// conflicts with the TypeScript template literal wrapping this string.

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloudflare WAN Analytics</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f3f4f6; color: #111827; }
    header { background: #f38020; color: white; padding: 1rem 2rem; }
    header h1 { font-size: 1.25rem; font-weight: 600; }
    .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }

    /* Top summary bar */
    .top-bar { display: flex; align-items: flex-start; gap: 1.5rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
    .summary-cards { display: flex; gap: 1rem; flex-wrap: wrap; flex: 1; }
    .summary-card { background: white; border-radius: 8px; padding: 1.1rem 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); flex: 1; min-width: 160px; }
    .summary-card .label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; margin-bottom: 0.3rem; }
    .summary-card .value { font-size: 1.65rem; font-weight: 700; }
    .summary-card .sublabel { font-size: 0.68rem; color: #9ca3af; margin-top: 0.15rem; }
    .card-count .value { color: #374151; }
    .card-ingress .value { color: #3b82f6; }
    .card-egress .value  { color: #f97316; }
    .controls { display: flex; flex-direction: column; gap: .4rem; justify-content: center; white-space: nowrap; }
    .controls label { font-size: 0.78rem; color: #6b7280; }

    /* Toolbar */
    .toolbar { display: flex; gap: .75rem; margin-bottom: 1.25rem; align-items: center; flex-wrap: wrap; }
    .search-input { flex: 1; min-width: 200px; padding: .42rem .85rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.875rem; background: white; }
    .search-input:focus { outline: 2px solid #3b82f6; outline-offset: -1px; }
    select { padding: .42rem .85rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.875rem; background: white; cursor: pointer; }

    /* Pagination */
    .pagination { display: none; align-items: center; gap: 1rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
    .page-btn { padding: .35rem .9rem; border: 1px solid #d1d5db; border-radius: 6px; background: white; cursor: pointer; font-size: 0.85rem; color: #374151; }
    .page-btn:hover:not(:disabled) { background: #f9fafb; }
    .page-btn:disabled { opacity: .4; cursor: default; }
    .page-info { font-size: 0.82rem; color: #6b7280; }

    /* Tunnel cards */
    .tunnel-card { background: white; border-radius: 8px; padding: 1.25rem 1.5rem; margin-bottom: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .tunnel-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1rem; gap: 1rem; }
    .tunnel-meta { display: flex; flex-direction: column; gap: .35rem; }
    .tunnel-name { font-size: 0.95rem; font-weight: 600; color: #111827; }
    .tunnel-p95-row { display: flex; gap: .6rem; flex-wrap: wrap; }
    .p95-stat { font-size: 0.75rem; font-weight: 600; padding: .2rem .55rem; border-radius: 4px; }
    .ingress-stat { background: #eff6ff; color: #1d4ed8; }
    .egress-stat  { background: #fff7ed; color: #c2410c; }
    .p95-btn { flex-shrink: 0; font-size: 0.75rem; padding: .3rem .75rem; border: 1px solid #d1d5db; border-radius: 5px; cursor: pointer; background: white; color: #374151; }
    .p95-btn:hover { background: #f9fafb; }
    .p95-btn.active { background: #eff6ff; border-color: #93c5fd; color: #1d4ed8; }
    .chart-wrap { position: relative; }
    .chart-loading { padding: 3rem; text-align: center; font-size: 0.85rem; color: #9ca3af; }
    canvas { max-height: 260px; display: none; }

    /* Misc */
    .status { color: #9ca3af; text-align: center; padding: 3rem 1rem; font-size: 0.9rem; }
    .error { color: #ef4444; }
  </style>
</head>
<body>
  <header><h1>Cloudflare WAN Analytics</h1></header>
  <div class="container">

    <div class="top-bar">
      <div class="summary-cards">
        <div class="summary-card card-count">
          <div class="label">Tunnels</div>
          <div class="value" id="tunnel-count">--</div>
          <div class="sublabel">configured</div>
        </div>
        <div class="summary-card card-ingress">
          <div class="label">p95 Ingress &mdash; all tunnels</div>
          <div class="value" id="p95-ingress">--</div>
          <div class="sublabel">combined across all tunnels</div>
        </div>
        <div class="summary-card card-egress">
          <div class="label">p95 Egress &mdash; all tunnels</div>
          <div class="value" id="p95-egress">--</div>
          <div class="sublabel">combined across all tunnels</div>
        </div>
      </div>
      <div class="controls">
        <label for="range">Time range</label>
        <select id="range" onchange="onRangeChange()">
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
      </div>
    </div>

    <div class="toolbar">
      <input type="search" id="search" class="search-input" placeholder="Search tunnels\u2026" oninput="onFilterChange()">
      <select id="sort" onchange="onFilterChange()">
        <option value="p95-max">Sort: p95 highest (in or out)</option>
        <option value="p95-ingress">Sort: p95 ingress highest</option>
        <option value="p95-egress">Sort: p95 egress highest</option>
        <option value="name">Sort: name A\u2013Z</option>
      </select>
    </div>

    <div class="pagination" id="pag-top">
      <button class="page-btn" id="prev-top" onclick="changePage(-1)" disabled>\u2190 Prev</button>
      <span class="page-info" id="page-info-top"></span>
      <button class="page-btn" id="next-top" onclick="changePage(1)">Next \u2192</button>
    </div>

    <div id="charts"><p class="status">Loading\u2026</p></div>

    <div class="pagination" id="pag-bot">
      <button class="page-btn" id="prev-bot" onclick="changePage(-1)" disabled>\u2190 Prev</button>
      <span class="page-info" id="page-info-bot"></span>
      <button class="page-btn" id="next-bot" onclick="changePage(1)">Next \u2192</button>
    </div>

  </div>
  <script>
    var PAGE_SIZE    = 20;
    var allTunnels   = [];   // [{name, p95_ingress_bps, p95_egress_bps}] — full list
    var filteredList = [];   // sorted + filtered subset
    var currentPage  = 0;
    var metricsCache = {};   // key: 'name::range' -> metrics response
    var activeCharts = {};   // key: tunnel name -> Chart instance
    var pendingCards = {};   // key: tunnel name -> canvas element (in-flight fetch)

    function formatBps(bps) {
      if (bps === null || bps === undefined) return 'N/A';
      if (bps >= 1e9) return (bps / 1e9).toFixed(2) + ' Gbps';
      if (bps >= 1e6) return (bps / 1e6).toFixed(2) + ' Mbps';
      if (bps >= 1e3) return (bps / 1e3).toFixed(2) + ' Kbps';
      return bps.toFixed(0) + ' bps';
    }

    function formatLabel(ts) {
      var d = new Date(ts);
      return d.toLocaleDateString(undefined, {month: 'short', day: 'numeric'}) + ' ' +
             d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    }

    function maxP95(t) {
      return Math.max(t.p95_ingress_bps || 0, t.p95_egress_bps || 0);
    }

    // ── Filtering, sorting, pagination ───────────────────────────────────────

    function applyFilters() {
      var search = document.getElementById('search').value.trim().toLowerCase();
      var sort   = document.getElementById('sort').value;

      var filtered = allTunnels.filter(function(t) {
        return !search || t.name.toLowerCase().indexOf(search) !== -1;
      });

      filtered.sort(function(a, b) {
        if (sort === 'name')        return a.name.localeCompare(b.name);
        if (sort === 'p95-ingress') return (b.p95_ingress_bps || 0) - (a.p95_ingress_bps || 0);
        if (sort === 'p95-egress')  return (b.p95_egress_bps  || 0) - (a.p95_egress_bps  || 0);
        return maxP95(b) - maxP95(a); // p95-max (default)
      });

      filteredList = filtered;
    }

    function updatePagination() {
      var total      = filteredList.length;
      var totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      var start      = currentPage * PAGE_SIZE + 1;
      var end        = Math.min((currentPage + 1) * PAGE_SIZE, total);
      var show       = total > PAGE_SIZE;
      var info       = 'Page ' + (currentPage + 1) + ' of ' + totalPages +
                       ' (' + start + '\u2013' + end + ' of ' + total + ' tunnels)';

      ['pag-top', 'pag-bot'].forEach(function(id) {
        document.getElementById(id).style.display = show ? 'flex' : 'none';
      });
      ['page-info-top', 'page-info-bot'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.textContent = info;
      });

      var atFirst = currentPage === 0;
      var atLast  = currentPage >= totalPages - 1;
      document.getElementById('prev-top').disabled = atFirst;
      document.getElementById('prev-bot').disabled = atFirst;
      document.getElementById('next-top').disabled = atLast;
      document.getElementById('next-bot').disabled = atLast;
    }

    function changePage(delta) {
      var totalPages = Math.max(1, Math.ceil(filteredList.length / PAGE_SIZE));
      var next = currentPage + delta;
      if (next < 0 || next >= totalPages) return;
      currentPage = next;
      renderCurrentPage();
      updatePagination();
      window.scrollTo(0, 0);
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    function destroyAllCharts() {
      Object.keys(activeCharts).forEach(function(k) {
        if (activeCharts[k]) activeCharts[k].destroy();
      });
      activeCharts = {};
      pendingCards = {};
    }

    function renderCurrentPage() {
      destroyAllCharts();
      document.getElementById('charts').innerHTML = '';

      var start = currentPage * PAGE_SIZE;
      var page  = filteredList.slice(start, start + PAGE_SIZE);
      var range = document.getElementById('range').value;

      if (page.length === 0) {
        document.getElementById('charts').innerHTML =
          '<p class="status">No tunnels match your search.</p>';
        return;
      }

      page.forEach(function(t) {
        var canvas   = renderTunnelCard(t);
        var cacheKey = t.name + '::' + range;

        if (metricsCache[cacheKey]) {
          populateChart(t.name, canvas, metricsCache[cacheKey]);
        } else {
          pendingCards[t.name] = canvas;
          fetch('/api/metrics?tunnel=' + encodeURIComponent(t.name) + '&range=' + range)
            .then(function(r) { return r.json(); })
            .then(function(metrics) {
              metricsCache[cacheKey] = metrics;
              var c = pendingCards[t.name];
              if (c) populateChart(t.name, c, metrics);
            })
            .catch(function() {
              var c = pendingCards[t.name];
              if (c && c.parentNode) {
                var loading = c.parentNode.querySelector('.chart-loading');
                if (loading) loading.textContent = 'Failed to load chart data.';
              }
            });
        }
      });
    }

    function renderTunnelCard(t) {
      var card = document.createElement('div');
      card.className = 'tunnel-card';

      // Header: meta (name + p95 badges) + toggle button
      var header = document.createElement('div');
      header.className = 'tunnel-header';

      var meta = document.createElement('div');
      meta.className = 'tunnel-meta';

      var nameEl = document.createElement('span');
      nameEl.className = 'tunnel-name';
      nameEl.textContent = t.name;

      var p95row = document.createElement('div');
      p95row.className = 'tunnel-p95-row';

      var p95In = document.createElement('span');
      p95In.className = 'p95-stat ingress-stat';
      p95In.textContent = 'p95 In: ' + formatBps(t.p95_ingress_bps);

      var p95Eg = document.createElement('span');
      p95Eg.className = 'p95-stat egress-stat';
      p95Eg.textContent = 'p95 Out: ' + formatBps(t.p95_egress_bps);

      p95row.appendChild(p95In);
      p95row.appendChild(p95Eg);
      meta.appendChild(nameEl);
      meta.appendChild(p95row);

      var btn = document.createElement('button');
      btn.className = 'p95-btn';
      btn.textContent = 'Show p95 overlay';
      (function(name) {
        btn.addEventListener('click', function() { toggleP95(btn, name); });
      })(t.name);

      header.appendChild(meta);
      header.appendChild(btn);

      // Chart area
      var wrap = document.createElement('div');
      wrap.className = 'chart-wrap';

      var loading = document.createElement('div');
      loading.className = 'chart-loading';
      loading.textContent = 'Loading chart\u2026';

      var canvas = document.createElement('canvas');

      wrap.appendChild(loading);
      wrap.appendChild(canvas);
      card.appendChild(header);
      card.appendChild(wrap);
      document.getElementById('charts').appendChild(card);

      return canvas;
    }

    function populateChart(tunnelName, canvas, metrics) {
      if (!canvas.parentNode) return; // card removed before fetch completed

      var loading = canvas.parentNode.querySelector('.chart-loading');
      if (loading) loading.style.display = 'none';
      canvas.style.display = '';
      delete pendingCards[tunnelName];

      var ingress = metrics.ingress || [];
      var egress  = metrics.egress  || [];
      var src     = ingress.length > 0 ? ingress : egress;
      var labels  = src.map(function(d) { return formatLabel(d.ts); });
      var maxLen  = Math.max(ingress.length, egress.length);
      var p95In   = metrics.p95_ingress_bps !== null ? metrics.p95_ingress_bps / 1e6 : null;
      var p95Eg   = metrics.p95_egress_bps  !== null ? metrics.p95_egress_bps  / 1e6 : null;

      if (activeCharts[tunnelName]) activeCharts[tunnelName].destroy();

      activeCharts[tunnelName] = new Chart(canvas, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Ingress',
              data: ingress.map(function(d) { return d.bps / 1e6; }),
              borderColor: '#3b82f6',
              backgroundColor: 'rgba(59,130,246,0.07)',
              borderWidth: 2, pointRadius: 0, tension: 0.2, fill: true
            },
            {
              label: 'Egress',
              data: egress.map(function(d) { return d.bps / 1e6; }),
              borderColor: '#f97316',
              backgroundColor: 'rgba(249,115,22,0.07)',
              borderWidth: 2, pointRadius: 0, tension: 0.2, fill: true
            },
            {
              label: 'p95 Ingress',
              data: Array(maxLen).fill(p95In),
              borderColor: '#3b82f6', borderDash: [6, 4],
              borderWidth: 1.5, pointRadius: 0, hidden: true, fill: false
            },
            {
              label: 'p95 Egress',
              data: Array(maxLen).fill(p95Eg),
              borderColor: '#f97316', borderDash: [6, 4],
              borderWidth: 1.5, pointRadius: 0, hidden: true, fill: false
            }
          ]
        },
        options: {
          responsive: true,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { position: 'top' },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  return ctx.dataset.label + ': ' + formatBps(ctx.parsed.y * 1e6);
                }
              }
            }
          },
          scales: {
            y: { title: { display: true, text: 'Mbps' }, beginAtZero: true },
            x: { ticks: { maxTicksLimit: 10, maxRotation: 0 } }
          }
        }
      });
    }

    function toggleP95(btn, tunnelName) {
      var on    = btn.classList.toggle('active');
      btn.textContent = on ? 'Hide p95 overlay' : 'Show p95 overlay';
      var chart = activeCharts[tunnelName];
      if (!chart) return;
      chart.data.datasets[2].hidden = !on;
      chart.data.datasets[3].hidden = !on;
      chart.update();
    }

    // ── Event handlers ────────────────────────────────────────────────────────

    function onFilterChange() {
      currentPage = 0;
      applyFilters();
      renderCurrentPage();
      updatePagination();
    }

    function onRangeChange() { init(); }

    // ── Init ──────────────────────────────────────────────────────────────────

    async function init() {
      var range = document.getElementById('range').value;

      // Reset state
      metricsCache = {};
      allTunnels   = [];
      filteredList = [];
      currentPage  = 0;
      destroyAllCharts();

      document.getElementById('charts').innerHTML = '<p class="status">Loading\u2026</p>';
      document.getElementById('tunnel-count').textContent = '\u2026';
      document.getElementById('p95-ingress').textContent  = '\u2026';
      document.getElementById('p95-egress').textContent   = '\u2026';
      document.getElementById('search').value = '';

      try {
        var responses = await Promise.all([
          fetch('/api/summary?range=' + range),
          fetch('/api/tunnels?range='  + range)
        ]);

        var summary     = await responses[0].json();
        var tunnelsData = await responses[1].json();

        document.getElementById('p95-ingress').textContent  = formatBps(summary.p95_ingress_bps);
        document.getElementById('p95-egress').textContent   = formatBps(summary.p95_egress_bps);
        document.getElementById('tunnel-count').textContent = (tunnelsData.total || 0).toString();

        allTunnels = tunnelsData.tunnels || [];

        if (allTunnels.length === 0) {
          document.getElementById('charts').innerHTML =
            '<p class="status">No tunnel data yet \u2014 the cron job polls every 5 minutes.</p>';
          return;
        }

        applyFilters();
        renderCurrentPage();
        updatePagination();

      } catch (err) {
        document.getElementById('charts').innerHTML =
          '<p class="status error">Error loading data: ' + (err.message || err) + '</p>';
        document.getElementById('p95-ingress').textContent = 'Error';
        document.getElementById('p95-egress').textContent  = 'Error';
      }
    }

    init();
  </script>
</body>
</html>`;
}

// ── Worker entry point ────────────────────────────────────────────────────────

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleCron(env));
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return new Response(getDashboardHTML(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};
