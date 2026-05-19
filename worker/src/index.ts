interface Env {
  DB: D1Database;
  WAN_API_TOKEN: string; // Cloudflare API token — Account Analytics: Read
  ACCOUNT_ID: string;    // Cloudflare account ID (non-secret var)
}

interface TunnelMetricRow {
  avg: { bitRateFiveMinutes: number };
  dimensions: { tunnelName: string; datetimeFiveMinutes: string };
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
// Fetches 5-minute average bit rates per tunnel for a given direction and window.
// The Cloudflare Analytics API uses `magicTransitTunnelTrafficAdaptiveGroups`
// for both Magic Transit and Cloudflare WAN (formerly Magic WAN).
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
// INSERT OR REPLACE uses the composite PK (tunnel_name, direction, ts) to
// deduplicate — safe to call on cron retries.

async function storeTunnelMetrics(
  db: D1Database,
  rows: TunnelMetricRow[],
  direction: 'ingress' | 'egress',
): Promise<void> {
  if (rows.length === 0) return;
  const BATCH_SIZE = 100; // D1 batch limit
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    await db.batch(
      chunk.map((row) =>
        db
          .prepare(
            'INSERT OR REPLACE INTO tunnel_metrics (tunnel_name, direction, ts, bit_rate) VALUES (?, ?, ?, ?)',
          )
          .bind(
            row.dimensions.tunnelName,
            direction,
            row.dimensions.datetimeFiveMinutes,
            row.avg.bitRateFiveMinutes,
          ),
      ),
    );
  }
}

// ── Cron handler ──────────────────────────────────────────────────────────────
// Queries the last 10 minutes to tolerate any API data latency.

async function handleCron(env: Env): Promise<void> {
  const now = new Date();
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
  const datetimeEnd = now.toISOString();
  const datetimeStart = tenMinutesAgo.toISOString();

  const [ingressRows, egressRows] = await Promise.all([
    fetchTunnelMetrics(env.ACCOUNT_ID, env.WAN_API_TOKEN, 'ingress', datetimeStart, datetimeEnd),
    fetchTunnelMetrics(env.ACCOUNT_ID, env.WAN_API_TOKEN, 'egress', datetimeStart, datetimeEnd),
  ]);

  await Promise.all([
    storeTunnelMetrics(env.DB, ingressRows, 'ingress'),
    storeTunnelMetrics(env.DB, egressRows, 'egress'),
  ]);
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

// p95 via ROW_NUMBER + COUNT — SQLite/D1 has no built-in PERCENTILE function.
// The aggregate flavour sums all tunnels at each interval first, matching
// Cloudflare's billing methodology.
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

// ── HTTP API handlers ─────────────────────────────────────────────────────────

async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  // GET /api/tunnels — distinct tunnel names seen in D1
  if (pathname === '/api/tunnels') {
    const { results } = await env.DB.prepare(
      'SELECT DISTINCT tunnel_name FROM tunnel_metrics ORDER BY tunnel_name',
    ).all<{ tunnel_name: string }>();
    return Response.json({ tunnels: results.map((r) => r.tunnel_name) });
  }

  // GET /api/summary?range=24h — aggregate p95 ingress and egress (all tunnels)
  if (pathname === '/api/summary') {
    const range = url.searchParams.get('range') ?? '24h';
    const since = rangeToSince(range);

    const [p95In, p95Eg] = await Promise.all([
      env.DB.prepare(P95_AGGREGATE_SQL).bind('ingress', since).first<{ val: number }>(),
      env.DB.prepare(P95_AGGREGATE_SQL).bind('egress', since).first<{ val: number }>(),
    ]);

    return Response.json({
      p95_ingress_bps: p95In?.val ?? null,
      p95_egress_bps: p95Eg?.val ?? null,
    });
  }

  // GET /api/metrics?tunnel=X&range=24h — time series + per-tunnel p95 for one tunnel
  if (pathname === '/api/metrics') {
    const tunnel = url.searchParams.get('tunnel');
    if (!tunnel) return new Response('Missing tunnel parameter', { status: 400 });
    const range = url.searchParams.get('range') ?? '24h';
    const since = rangeToSince(range);

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
      env.DB.prepare(P95_PER_TUNNEL_SQL)
        .bind(tunnel, 'ingress', since)
        .first<{ val: number }>(),
      env.DB.prepare(P95_PER_TUNNEL_SQL)
        .bind(tunnel, 'egress', since)
        .first<{ val: number }>(),
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
// Single-page dashboard served directly from the worker.
// Chart.js loaded from CDN. All JS uses ES5-compatible syntax to avoid
// backtick conflicts with the TypeScript template literal wrapping this HTML.

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
    header { background: #f38020; color: white; padding: 1rem 2rem; display: flex; align-items: center; gap: 1rem; }
    header h1 { font-size: 1.25rem; font-weight: 600; }
    .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
    .top-bar { display: flex; align-items: flex-start; gap: 1.5rem; margin-bottom: 2rem; flex-wrap: wrap; }
    .summary-cards { display: flex; gap: 1rem; flex-wrap: wrap; flex: 1; }
    .summary-card { background: white; border-radius: 8px; padding: 1.25rem 1.75rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); flex: 1; min-width: 180px; }
    .summary-card .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; margin-bottom: 0.4rem; }
    .summary-card .value { font-size: 1.75rem; font-weight: 700; }
    .summary-card .sublabel { font-size: 0.7rem; color: #9ca3af; margin-top: 0.2rem; }
    .ingress .value { color: #3b82f6; }
    .egress .value  { color: #f97316; }
    .controls { display: flex; flex-direction: column; gap: .5rem; justify-content: center; }
    .controls label { font-size: 0.8rem; color: #6b7280; }
    select { padding: .45rem .9rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.875rem; background: white; cursor: pointer; }
    .tunnel-card { background: white; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .tunnel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
    .tunnel-name { font-size: 0.95rem; font-weight: 600; color: #374151; }
    .p95-btn { font-size: 0.75rem; padding: .3rem .75rem; border: 1px solid #d1d5db; border-radius: 5px; cursor: pointer; background: white; color: #374151; transition: background .15s; }
    .p95-btn:hover { background: #f9fafb; }
    .p95-btn.active { background: #eff6ff; border-color: #93c5fd; color: #1d4ed8; }
    canvas { max-height: 280px; }
    .status { color: #9ca3af; text-align: center; padding: 3rem 1rem; font-size: 0.9rem; }
    .error { color: #ef4444; }
  </style>
</head>
<body>
  <header>
    <h1>Cloudflare WAN Analytics</h1>
  </header>
  <div class="container">
    <div class="top-bar">
      <div class="summary-cards">
        <div class="summary-card ingress">
          <div class="label">p95 Ingress &mdash; all tunnels</div>
          <div class="value" id="p95-ingress">--</div>
          <div class="sublabel">Combined ingress across all tunnels</div>
        </div>
        <div class="summary-card egress">
          <div class="label">p95 Egress &mdash; all tunnels</div>
          <div class="value" id="p95-egress">--</div>
          <div class="sublabel">Combined egress across all tunnels</div>
        </div>
      </div>
      <div class="controls">
        <label for="range">Time range</label>
        <select id="range" onchange="init()">
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
      </div>
    </div>
    <div id="charts"><p class="status">Loading&hellip;</p></div>
  </div>

  <script>
    var activeCharts = {};

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

    function toggleP95(btn, tunnel) {
      var isActive = btn.classList.toggle('active');
      btn.textContent = isActive ? 'Hide p95' : 'Show p95';
      var chart = activeCharts[tunnel];
      if (!chart) return;
      // Datasets 2 = p95 ingress line, 3 = p95 egress line
      chart.data.datasets[2].hidden = !isActive;
      chart.data.datasets[3].hidden = !isActive;
      chart.update();
    }

    function destroyCharts() {
      Object.keys(activeCharts).forEach(function(k) {
        if (activeCharts[k]) activeCharts[k].destroy();
      });
      activeCharts = {};
    }

    function renderTunnelChart(tunnel, metrics) {
      var ingress = metrics.ingress || [];
      var egress  = metrics.egress  || [];
      var labels  = (ingress.length > 0 ? ingress : egress).map(function(d) { return formatLabel(d.ts); });
      var maxLen  = Math.max(ingress.length, egress.length);
      var p95In   = (metrics.p95_ingress_bps !== null) ? metrics.p95_ingress_bps / 1e6 : null;
      var p95Eg   = (metrics.p95_egress_bps  !== null) ? metrics.p95_egress_bps  / 1e6 : null;

      var card = document.createElement('div');
      card.className = 'tunnel-card';

      var header = document.createElement('div');
      header.className = 'tunnel-header';

      var nameEl = document.createElement('span');
      nameEl.className = 'tunnel-name';
      nameEl.textContent = tunnel;

      var btn = document.createElement('button');
      btn.className = 'p95-btn';
      btn.textContent = 'Show p95';
      btn.addEventListener('click', function() { toggleP95(btn, tunnel); });

      header.appendChild(nameEl);
      header.appendChild(btn);

      var canvas = document.createElement('canvas');
      card.appendChild(header);
      card.appendChild(canvas);
      document.getElementById('charts').appendChild(card);

      activeCharts[tunnel] = new Chart(canvas, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Ingress',
              data: ingress.map(function(d) { return d.bps / 1e6; }),
              borderColor: '#3b82f6',
              backgroundColor: 'rgba(59,130,246,0.07)',
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.2,
              fill: true
            },
            {
              label: 'Egress',
              data: egress.map(function(d) { return d.bps / 1e6; }),
              borderColor: '#f97316',
              backgroundColor: 'rgba(249,115,22,0.07)',
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.2,
              fill: true
            },
            {
              label: 'p95 Ingress',
              data: Array(maxLen).fill(p95In),
              borderColor: '#3b82f6',
              borderDash: [6, 4],
              borderWidth: 1.5,
              pointRadius: 0,
              hidden: true,
              fill: false
            },
            {
              label: 'p95 Egress',
              data: Array(maxLen).fill(p95Eg),
              borderColor: '#f97316',
              borderDash: [6, 4],
              borderWidth: 1.5,
              pointRadius: 0,
              hidden: true,
              fill: false
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
            y: {
              title: { display: true, text: 'Mbps' },
              beginAtZero: true
            },
            x: {
              ticks: { maxTicksLimit: 10, maxRotation: 0 }
            }
          }
        }
      });
    }

    async function init() {
      var range = document.getElementById('range').value;
      destroyCharts();
      document.getElementById('charts').innerHTML = '<p class="status">Loading\u2026</p>';
      document.getElementById('p95-ingress').textContent = '\u2026';
      document.getElementById('p95-egress').textContent  = '\u2026';

      try {
        var summaryRes = await fetch('/api/summary?range=' + range);
        var summary    = await summaryRes.json();
        document.getElementById('p95-ingress').textContent = formatBps(summary.p95_ingress_bps);
        document.getElementById('p95-egress').textContent  = formatBps(summary.p95_egress_bps);

        var tunnelsRes  = await fetch('/api/tunnels');
        var tunnelsData = await tunnelsRes.json();
        var tunnels     = tunnelsData.tunnels || [];

        if (tunnels.length === 0) {
          document.getElementById('charts').innerHTML =
            '<p class="status">No tunnel data yet \u2014 the cron job polls every 5 minutes. Check back shortly.</p>';
          return;
        }

        document.getElementById('charts').innerHTML = '';

        var metricsPromises = tunnels.map(function(t) {
          return fetch('/api/metrics?tunnel=' + encodeURIComponent(t) + '&range=' + range)
            .then(function(r) { return r.json(); })
            .then(function(m) { return { tunnel: t, metrics: m }; });
        });

        var results = await Promise.all(metricsPromises);
        results.forEach(function(r) { renderTunnelChart(r.tunnel, r.metrics); });

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
