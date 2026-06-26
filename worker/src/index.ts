import type { Env } from './types';
import { handleCron } from './cron';
import { handleApiRequest } from './api';

// getDashboardHTML is kept inline temporarily — extracted to dashboard.ts in Task 10.
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
    .excl-btn { flex-shrink: 0; font-size: 0.75rem; padding: .3rem .75rem; border: 1px solid #d1d5db; border-radius: 5px; cursor: pointer; background: white; color: #6b7280; margin-left: .4rem; }
    .excl-btn:hover { background: #f9fafb; }
    .excl-btn.excluded { background: #fef2f2; border-color: #fca5a5; color: #dc2626; }
    .tunnel-card.excluded { opacity: 0.4; }
    .clear-excl-btn { padding: .42rem .85rem; border: 1px solid #fca5a5; border-radius: 6px; font-size: 0.875rem; background: #fef2f2; color: #dc2626; cursor: pointer; white-space: nowrap; }
    .clear-excl-btn:hover { background: #fee2e2; }
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
          <div class="sublabel">with data in selected range</div>
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
      <button id="clear-excl" class="clear-excl-btn" onclick="clearExclusions()" style="display:none">Clear exclusions (<span id="excl-count">0</span>)</button>
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
    var PAGE_SIZE      = 20;
    var allTunnels     = [];   // [{name, p95_ingress_bps, p95_egress_bps}] — full list
    var filteredList   = [];   // sorted + filtered subset
    var currentPage    = 0;
    var metricsCache   = {};   // key: 'name::range' -> metrics response
    var activeCharts   = {};   // key: tunnel name -> Chart instance
    var pendingCards   = {};   // key: tunnel name -> canvas element (in-flight fetch)
    var excludedTunnels = {}; // key: tunnel name -> true; persisted in localStorage

    // ── Exclusion helpers ────────────────────────────────────────────────────

    function loadExclusions() {
      try { excludedTunnels = JSON.parse(localStorage.getItem('wanstats_excl') || '{}'); }
      catch(e) { excludedTunnels = {}; }
    }

    function saveExclusions() {
      localStorage.setItem('wanstats_excl', JSON.stringify(excludedTunnels));
    }

    function updateExclCount() {
      var n   = Object.keys(excludedTunnels).length;
      var btn = document.getElementById('clear-excl');
      var cnt = document.getElementById('excl-count');
      if (btn) btn.style.display = n > 0 ? 'inline-block' : 'none';
      if (cnt) cnt.textContent   = n;
      var included = allTunnels.filter(function(t) { return !excludedTunnels[t.name]; }).length;
      var countEl  = document.getElementById('tunnel-count');
      if (countEl) countEl.textContent = n > 0 ? included + ' (' + n + ' excl.)' : included.toString();
    }

    function refreshSummary() {
      var range = document.getElementById('range').value;
      var excl  = Object.keys(excludedTunnels);
      var q     = '/api/summary?range=' + range + (excl.length ? '&exclude=' + excl.map(encodeURIComponent).join(',') : '');
      fetch(q)
        .then(function(r) { return r.json(); })
        .then(function(s) {
          document.getElementById('p95-ingress').textContent = formatBps(s.p95_ingress_bps);
          document.getElementById('p95-egress').textContent  = formatBps(s.p95_egress_bps);
        });
    }

    function toggleExclusion(name) {
      if (excludedTunnels[name]) { delete excludedTunnels[name]; } else { excludedTunnels[name] = true; }
      saveExclusions();
      metricsCache = {}; // chart data still valid but don't re-fetch on exclusion toggle
      updateExclCount();
      refreshSummary();
      applyFilters();
      renderCurrentPage();
      updatePagination();
    }

    function clearExclusions() {
      excludedTunnels = {};
      saveExclusions();
      metricsCache = {};
      updateExclCount();
      refreshSummary();
      applyFilters();
      renderCurrentPage();
      updatePagination();
    }

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
        // Excluded tunnels always sort to the bottom
        var aEx = !!excludedTunnels[a.name];
        var bEx = !!excludedTunnels[b.name];
        if (aEx !== bEx) return aEx ? 1 : -1;
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

        // Skip chart for excluded tunnels — they're greyed out, no data needed
        if (excludedTunnels[t.name]) return;

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
      var isExcluded = !!excludedTunnels[t.name];
      var card = document.createElement('div');
      card.className = 'tunnel-card' + (isExcluded ? ' excluded' : '');

      // Header: meta (name + p95 badges) + action buttons
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

      var btnGroup = document.createElement('div');
      btnGroup.style.display = 'flex';
      btnGroup.style.alignItems = 'center';

      var btn = document.createElement('button');
      btn.className = 'p95-btn';
      btn.textContent = 'Show p95 overlay';
      (function(name) {
        btn.addEventListener('click', function() { toggleP95(btn, name); });
      })(t.name);

      var exclBtn = document.createElement('button');
      exclBtn.className = 'excl-btn' + (isExcluded ? ' excluded' : '');
      exclBtn.textContent = isExcluded ? 'Excluded' : 'Exclude';
      (function(name) {
        exclBtn.addEventListener('click', function() { toggleExclusion(name); });
      })(t.name);

      btnGroup.appendChild(btn);
      btnGroup.appendChild(exclBtn);
      header.appendChild(meta);
      header.appendChild(btnGroup);

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

      // Build a unified set of timestamps from both series so each
      // data point is plotted at its real time position.
      var tsSet = {};
      var i;
      for (i = 0; i < ingress.length; i++) tsSet[ingress[i].ts] = true;
      for (i = 0; i < egress.length;  i++) tsSet[egress[i].ts]  = true;
      var allTs = Object.keys(tsSet).sort();

      var ingressMap = {};
      var egressMap  = {};
      for (i = 0; i < ingress.length; i++) ingressMap[ingress[i].ts] = ingress[i].bps;
      for (i = 0; i < egress.length;  i++) egressMap[egress[i].ts]   = egress[i].bps;

      var labels     = allTs.map(function(ts) { return formatLabel(ts); });
      var ingressArr = allTs.map(function(ts) { return ingressMap[ts] !== undefined ? ingressMap[ts] / 1e6 : null; });
      var egressArr  = allTs.map(function(ts) { return egressMap[ts]  !== undefined ? egressMap[ts]  / 1e6 : null; });

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
              data: ingressArr,
              borderColor: '#3b82f6',
              backgroundColor: 'rgba(59,130,246,0.07)',
              borderWidth: 2, pointRadius: 0, tension: 0.2, fill: true, spanGaps: true
            },
            {
              label: 'Egress',
              data: egressArr,
              borderColor: '#f97316',
              backgroundColor: 'rgba(249,115,22,0.07)',
              borderWidth: 2, pointRadius: 0, tension: 0.2, fill: true, spanGaps: true
            },
            {
              label: 'p95 Ingress',
              data: Array(allTs.length).fill(p95In),
              borderColor: '#3b82f6', borderDash: [6, 4],
              borderWidth: 1.5, pointRadius: 0, hidden: true, fill: false
            },
            {
              label: 'p95 Egress',
              data: Array(allTs.length).fill(p95Eg),
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

      // Reset state — preserve exclusions across range changes
      loadExclusions();
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
        var excl       = Object.keys(excludedTunnels);
        var exclSuffix = excl.length ? '&exclude=' + excl.map(encodeURIComponent).join(',') : '';
        var responses  = await Promise.all([
          fetch('/api/summary?range=' + range + exclSuffix),
          fetch('/api/tunnels?range='  + range)
        ]);

        var summary     = await responses[0].json();
        var tunnelsData = await responses[1].json();

        document.getElementById('p95-ingress').textContent = formatBps(summary.p95_ingress_bps);
        document.getElementById('p95-egress').textContent  = formatBps(summary.p95_egress_bps);

        allTunnels = tunnelsData.tunnels || [];
        updateExclCount();

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
