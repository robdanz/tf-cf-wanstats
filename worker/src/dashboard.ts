export function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloudflare WAN Analytics</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3"></script>
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

    /* Billing section */
    .billing-section { background: white; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); border-left: 4px solid #10b981; }
    .billing-title { font-size: 1rem; font-weight: 700; color: #111827; margin-bottom: .25rem; }
    .billing-subtitle { font-size: 0.75rem; color: #6b7280; margin-bottom: 1rem; }
    .billing-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    .billing-month-label { font-size: 0.78rem; font-weight: 600; color: #374151; margin-bottom: .5rem; }
    .billing-values { display: flex; gap: 1rem; flex-wrap: wrap; }
    .billing-val .bv-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; }
    .billing-val .bv-value { font-size: 1.3rem; font-weight: 700; }
    .bv-ingress { color: #3b82f6; }
    .bv-egress { color: #f97316; }
    .billing-computed { font-size: 0.68rem; color: #9ca3af; margin-top: .25rem; }
    .billing-badge { display: inline-block; font-size: 0.65rem; font-weight: 600; padding: .15rem .5rem; border-radius: 3px; background: #ecfdf5; color: #047857; margin-left: .5rem; vertical-align: middle; }

    /* Estimate banner */
    .estimate-banner { background: #fffbeb; border: 1px solid #f59e0b; border-radius: 6px; padding: .6rem 1rem; margin-bottom: 1.25rem; display: none; }
    .estimate-banner-text { font-size: 0.82rem; color: #92400e; }
    .estimate-banner-text strong { font-weight: 600; }
    .estimate-tooltip { position: relative; display: inline-block; cursor: help; border-bottom: 1px dashed #92400e; }
    .estimate-tooltip .tooltip-content { visibility: hidden; background: #1f2937; color: white; font-size: 0.75rem; padding: .5rem .75rem; border-radius: 6px; position: absolute; bottom: 125%; left: 50%; transform: translateX(-50%); white-space: nowrap; z-index: 10; }
    .estimate-tooltip:hover .tooltip-content { visibility: visible; }

    /* Export bar */
    .export-bar { display: flex; gap: .75rem; align-items: center; margin-bottom: 1.25rem; flex-wrap: wrap; }
    .export-btn { padding: .42rem .85rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.85rem; background: white; cursor: pointer; color: #374151; }
    .export-btn:hover:not(:disabled) { background: #f9fafb; }
    .export-btn:disabled { opacity: .5; cursor: not-allowed; }
    .export-status { font-size: 0.78rem; color: #6b7280; }

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
          <option value="90d">Last 90 days</option>
          <option value="180d">Last 180 days</option>
          <option value="custom">Custom range</option>
        </select>
      </div>
    </div>

    <div id="custom-range" style="display:none; margin-top:.5rem; gap:.5rem; align-items:center;">
      <label for="custom-start" style="font-size:0.78rem; color:#6b7280;">Start</label>
      <input type="date" id="custom-start" style="padding:.35rem .6rem; border:1px solid #d1d5db; border-radius:6px; font-size:0.85rem;">
      <label for="custom-end" style="font-size:0.78rem; color:#6b7280; margin-left:.5rem;">End</label>
      <input type="date" id="custom-end" style="padding:.35rem .6rem; border:1px solid #d1d5db; border-radius:6px; font-size:0.85rem;">
      <button onclick="applyCustomRange()" style="margin-left:.5rem; padding:.35rem .75rem; border:1px solid #d1d5db; border-radius:6px; font-size:0.85rem; background:white; cursor:pointer;">Apply</button>
      <span id="custom-error" style="color:#ef4444; font-size:0.78rem; margin-left:.5rem;"></span>
    </div>

    <div class="billing-section" id="billing-section">
      <div style="display:flex; align-items:center; gap:.5rem;">
        <span class="billing-title">Billing-Grade P95</span>
        <span class="billing-badge">From raw 5-min data</span>
      </div>
      <div class="billing-subtitle">Computed from raw 5-minute samples in R2 &mdash; matches Cloudflare invoice methodology</div>
      <div class="billing-grid">
        <div>
          <div class="billing-month-label" id="billing-current-label">Current Month</div>
          <div class="billing-values">
            <div class="billing-val"><div class="bv-label">P95 Ingress</div><div class="bv-value bv-ingress" id="billing-current-ingress">--</div></div>
            <div class="billing-val"><div class="bv-label">P95 Egress</div><div class="bv-value bv-egress" id="billing-current-egress">--</div></div>
          </div>
          <div class="billing-computed" id="billing-current-computed"></div>
        </div>
        <div>
          <div class="billing-month-label" id="billing-prev-label">Previous Month</div>
          <div class="billing-values">
            <div class="billing-val"><div class="bv-label">P95 Ingress</div><div class="bv-value bv-ingress" id="billing-prev-ingress">--</div></div>
            <div class="billing-val"><div class="bv-label">P95 Egress</div><div class="bv-value bv-egress" id="billing-prev-egress">--</div></div>
          </div>
          <div class="billing-computed" id="billing-prev-computed"></div>
        </div>
      </div>
    </div>

    <div class="estimate-banner" id="estimate-banner">
      <span class="estimate-banner-text">
        <strong>\u26A0 Estimated values.</strong>
        Chart p95 values are approximations based on hourly/daily rollups, not raw 5-minute data.
        For billing-grade p95, see the Billing P95 section above.
        <span class="estimate-tooltip">Export raw data
          <span class="tooltip-content">Use the Export button below to download raw 5-minute data as CSV for your own analysis.</span>
        </span>
      </span>
    </div>

    <div class="toolbar">
      <input type="search" id="search" class="search-input" placeholder="Search tunnels\u2026" oninput="onFilterChange()">
      <select id="sort" onchange="onSortChange()">
        <option value="p95-max">Sort: p95 highest (in or out)</option>
        <option value="p95-ingress">Sort: p95 ingress highest</option>
        <option value="p95-egress">Sort: p95 egress highest</option>
        <option value="name">Sort: name A\u2013Z</option>
      </select>
      <button id="clear-excl" class="clear-excl-btn" onclick="clearExclusions()" style="display:none">Clear exclusions (<span id="excl-count">0</span>)</button>
    </div>

    <div class="export-bar">
      <button class="export-btn" id="export-btn" onclick="startExport()">Export Raw Data (CSV)</button>
      <span class="export-status" id="export-status"></span>
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
    var PAGE_SIZE = 20;
    var currentPage = 1;
    var totalTunnels = 0;
    var totalPages = 1;
    var metricsCache = {};
    var activeCharts = {};
    var pendingCards = {};
    var excludedTunnels = {};
    var customStart = null;
    var customEnd = null;
    var exportInProgress = false;
    var searchDebounceTimer = null;

    function loadExclusions() {
      try { excludedTunnels = JSON.parse(localStorage.getItem('wanstats_excl') || '{}'); }
      catch(e) { excludedTunnels = {}; }
    }

    function saveExclusions() {
      localStorage.setItem('wanstats_excl', JSON.stringify(excludedTunnels));
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

    function buildRangeParams() {
      var range = document.getElementById('range').value;
      var params = 'range=' + range;
      if (range === 'custom' && customStart && customEnd) {
        params += '&start=' + encodeURIComponent(customStart) + '&end=' + encodeURIComponent(customEnd);
      }
      return params;
    }

    function destroyAllCharts() {
      Object.keys(activeCharts).forEach(function(k) {
        if (activeCharts[k]) activeCharts[k].destroy();
      });
      activeCharts = {};
      pendingCards = {};
    }

    // -- Exclusion helpers --

    function updateExclCount() {
      var n = Object.keys(excludedTunnels).length;
      var btn = document.getElementById('clear-excl');
      var cnt = document.getElementById('excl-count');
      if (btn) btn.style.display = n > 0 ? 'inline-block' : 'none';
      if (cnt) cnt.textContent = n;
    }

    function refreshSummary() {
      var rangeParams = buildRangeParams();
      var excl = Object.keys(excludedTunnels);
      var q = '/api/summary?' + rangeParams + (excl.length ? '&exclude=' + excl.map(encodeURIComponent).join(',') : '');
      fetch(q)
        .then(function(r) { return r.json(); })
        .then(function(s) {
          document.getElementById('p95-ingress').textContent = formatBps(s.p95_ingress_bps);
          document.getElementById('p95-egress').textContent = formatBps(s.p95_egress_bps);
        });
    }

    function toggleExclusion(name) {
      if (excludedTunnels[name]) { delete excludedTunnels[name]; } else { excludedTunnels[name] = true; }
      saveExclusions();
      metricsCache = {};
      updateExclCount();
      refreshSummary();
      loadTunnelPage();
    }

    function clearExclusions() {
      excludedTunnels = {};
      saveExclusions();
      metricsCache = {};
      updateExclCount();
      refreshSummary();
      loadTunnelPage();
    }

    // -- Range / custom --

    function onRangeChange() {
      var range = document.getElementById('range').value;
      var customDiv = document.getElementById('custom-range');
      if (range === 'custom') {
        customDiv.style.display = 'flex';
        return;
      }
      customDiv.style.display = 'none';
      customStart = null;
      customEnd = null;
      init();
    }

    function applyCustomRange() {
      var startEl = document.getElementById('custom-start');
      var endEl = document.getElementById('custom-end');
      var errEl = document.getElementById('custom-error');
      errEl.textContent = '';
      if (!startEl.value || !endEl.value) { errEl.textContent = 'Both dates required'; return; }
      var s = new Date(startEl.value + 'T00:00:00Z');
      var e = new Date(endEl.value + 'T23:59:59Z');
      if (s >= e) { errEl.textContent = 'Start must be before end'; return; }
      var diffDays = (e.getTime() - s.getTime()) / 86400000;
      if (diffDays > 180) { errEl.textContent = 'Max range is 180 days'; return; }
      customStart = s.toISOString();
      customEnd = e.toISOString();
      init();
    }

    // -- Pagination --

    function updatePaginationControls() {
      var show = totalPages > 1;
      var start = (currentPage - 1) * PAGE_SIZE + 1;
      var end = Math.min(currentPage * PAGE_SIZE, totalTunnels);
      var info = 'Page ' + currentPage + ' of ' + totalPages +
                 ' (' + start + '\u2013' + end + ' of ' + totalTunnels + ' tunnels)';
      ['pag-top', 'pag-bot'].forEach(function(id) {
        document.getElementById(id).style.display = show ? 'flex' : 'none';
      });
      ['page-info-top', 'page-info-bot'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.textContent = info;
      });
      document.getElementById('prev-top').disabled = currentPage <= 1;
      document.getElementById('prev-bot').disabled = currentPage <= 1;
      document.getElementById('next-top').disabled = currentPage >= totalPages;
      document.getElementById('next-bot').disabled = currentPage >= totalPages;
    }

    function changePage(delta) {
      var next = currentPage + delta;
      if (next < 1 || next > totalPages) return;
      currentPage = next;
      loadTunnelPage();
      window.scrollTo(0, 0);
    }

    function onFilterChange() {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(function() {
        currentPage = 1;
        loadTunnelPage();
      }, 300);
    }

    function onSortChange() {
      currentPage = 1;
      loadTunnelPage();
    }

    // -- Tunnel page loading (server-side) --

    function loadTunnelPage() {
      var rangeParams = buildRangeParams();
      var sort = document.getElementById('sort').value;
      var search = document.getElementById('search').value.trim();
      var sortDir = (sort === 'name') ? 'ASC' : 'DESC';

      document.getElementById('charts').innerHTML = '<p class="status">Loading\u2026</p>';

      var url = '/api/tunnels?' + rangeParams + '&page=' + currentPage + '&pageSize=' + PAGE_SIZE + '&sort=' + sort + '&dir=' + sortDir;
      if (search) url += '&search=' + encodeURIComponent(search);

      fetch(url)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          totalTunnels = data.total;
          totalPages = data.totalPages;

          var bannerEl = document.getElementById('estimate-banner');
          if (bannerEl) bannerEl.style.display = data.isEstimate ? 'block' : 'none';

          document.getElementById('tunnel-count').textContent = totalTunnels.toString();
          renderTunnelPage(data.tunnels, rangeParams);
          updatePaginationControls();
        })
        .catch(function(err) {
          document.getElementById('charts').innerHTML =
            '<p class="status error">Error: ' + (err.message || err) + '</p>';
        });
    }

    // -- Rendering --

    function renderTunnelPage(tunnels, rangeParams) {
      destroyAllCharts();
      document.getElementById('charts').innerHTML = '';

      if (tunnels.length === 0) {
        document.getElementById('charts').innerHTML =
          '<p class="status">No tunnels match your search.</p>';
        return;
      }

      var canvasMap = {};
      tunnels.forEach(function(t) {
        var canvas = renderTunnelCard(t);
        if (!excludedTunnels[t.name]) {
          canvasMap[t.name] = canvas;
        }
      });

      var names = Object.keys(canvasMap);
      if (names.length === 0) return;

      var range = document.getElementById('range').value;
      var chartEnd;
      if (range === 'custom' && customEnd) {
        chartEnd = new Date(customEnd);
      } else {
        chartEnd = new Date();
      }

      var batchUrl = '/api/metrics?tunnels=' + names.map(encodeURIComponent).join(',') + '&' + rangeParams;

      fetch(batchUrl)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var tunnelMetrics = data.tunnels || {};
          names.forEach(function(name) {
            if (tunnelMetrics[name] && canvasMap[name]) {
              populateChart(name, canvasMap[name], tunnelMetrics[name], chartEnd);
            }
          });
        })
        .catch(function(err) {
          console.error('Failed to load batch metrics:', err);
        });
    }

    function renderTunnelCard(t) {
      var isExcluded = !!excludedTunnels[t.name];
      var card = document.createElement('div');
      card.className = 'tunnel-card' + (isExcluded ? ' excluded' : '');

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

    function populateChart(tunnelName, canvas, metrics, chartEnd) {
      if (!canvas.parentNode) return;

      var loading = canvas.parentNode.querySelector('.chart-loading');
      if (loading) loading.style.display = 'none';
      canvas.style.display = '';
      delete pendingCards[tunnelName];

      var ingress = metrics.ingress || [];
      var egress = metrics.egress || [];

      var tsSet = {};
      var i;
      for (i = 0; i < ingress.length; i++) tsSet[ingress[i].ts] = true;
      for (i = 0; i < egress.length; i++) tsSet[egress[i].ts] = true;
      var allTs = Object.keys(tsSet).sort();

      var ingressMap = {};
      var egressMap = {};
      for (i = 0; i < ingress.length; i++) ingressMap[ingress[i].ts] = ingress[i].bps;
      for (i = 0; i < egress.length; i++) egressMap[egress[i].ts] = egress[i].bps;

      var labels = allTs.map(function(ts) { return new Date(ts); });
      var ingressArr = allTs.map(function(ts) { return ingressMap[ts] !== undefined ? ingressMap[ts] / 1e6 : 0; });
      var egressArr = allTs.map(function(ts) { return egressMap[ts] !== undefined ? egressMap[ts] / 1e6 : 0; });

      var p95In = metrics.p95_ingress_bps !== null ? metrics.p95_ingress_bps / 1e6 : null;
      var p95Eg = metrics.p95_egress_bps !== null ? metrics.p95_egress_bps / 1e6 : null;

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
            x: {
              type: 'time',
              max: chartEnd,
              time: { tooltipFormat: 'MMM d, h:mm a' },
              ticks: { maxTicksLimit: 10, maxRotation: 0 }
            }
          }
        }
      });
    }

    function toggleP95(btn, tunnelName) {
      var on = btn.classList.toggle('active');
      btn.textContent = on ? 'Hide p95 overlay' : 'Show p95 overlay';
      var chart = activeCharts[tunnelName];
      if (!chart) return;
      chart.data.datasets[2].hidden = !on;
      chart.data.datasets[3].hidden = !on;
      chart.update();
    }

    // -- Billing --

    function loadBillingP95() {
      fetch('/api/billing')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var c = data.current;
          document.getElementById('billing-current-label').textContent = c.period;
          document.getElementById('billing-current-ingress').textContent = formatBps(c.p95_ingress_bps);
          document.getElementById('billing-current-egress').textContent = formatBps(c.p95_egress_bps);
          document.getElementById('billing-current-computed').textContent = c.computed_at
            ? 'Last computed: ' + new Date(c.computed_at).toLocaleString()
            : 'Not yet computed \u2014 runs daily at midnight UTC';

          var p = data.previous;
          document.getElementById('billing-prev-label').textContent = p.period;
          document.getElementById('billing-prev-ingress').textContent = formatBps(p.p95_ingress_bps);
          document.getElementById('billing-prev-egress').textContent = formatBps(p.p95_egress_bps);
          document.getElementById('billing-prev-computed').textContent = p.computed_at
            ? 'Last computed: ' + new Date(p.computed_at).toLocaleString()
            : 'Not yet computed \u2014 runs daily at midnight UTC';
        })
        .catch(function(err) { console.error('Failed to load billing p95:', err); });
    }

    // -- Export --

    function startExport() {
      if (exportInProgress) return;
      var range = document.getElementById('range').value;
      var exportBtn = document.getElementById('export-btn');
      var statusEl = document.getElementById('export-status');

      var start, end;
      if (range === 'custom' && customStart && customEnd) {
        start = customStart;
        end = customEnd;
      } else {
        var now = new Date();
        end = now.toISOString();
        var daysMap = { '24h': 1, '7d': 7, '30d': 30, '90d': 90, '180d': 180 };
        var days = daysMap[range] || 1;
        var s = new Date(now);
        s.setUTCDate(s.getUTCDate() - days);
        start = s.toISOString();
      }

      exportInProgress = true;
      exportBtn.disabled = true;
      exportBtn.textContent = 'Exporting\u2026';
      statusEl.textContent = 'Preparing CSV download\u2026';

      var url = '/api/export?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end);

      fetch(url)
        .then(function(r) {
          if (!r.ok) throw new Error('Export failed: ' + r.status);
          return r.blob();
        })
        .then(function(blob) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'wanstats-export.csv.gz';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(a.href);
          statusEl.textContent = 'Download complete.';
        })
        .catch(function(err) {
          statusEl.textContent = 'Export failed: ' + (err.message || err);
        })
        .finally(function() {
          exportInProgress = false;
          exportBtn.disabled = false;
          exportBtn.textContent = 'Export Raw Data (CSV)';
        });
    }

    // -- Init --

    function init() {
      loadExclusions();
      metricsCache = {};
      currentPage = 1;
      destroyAllCharts();

      document.getElementById('charts').innerHTML = '<p class="status">Loading\u2026</p>';
      document.getElementById('tunnel-count').textContent = '\u2026';
      document.getElementById('p95-ingress').textContent = '\u2026';
      document.getElementById('p95-egress').textContent = '\u2026';

      var rangeParams = buildRangeParams();
      var excl = Object.keys(excludedTunnels);
      var exclSuffix = excl.length ? '&exclude=' + excl.map(encodeURIComponent).join(',') : '';

      Promise.all([
        fetch('/api/summary?' + rangeParams + exclSuffix).then(function(r) { return r.json(); }),
        fetch('/api/billing').then(function(r) { return r.json(); })
      ]).then(function(results) {
        var summary = results[0];
        var billingData = results[1];

        document.getElementById('p95-ingress').textContent = formatBps(summary.p95_ingress_bps);
        document.getElementById('p95-egress').textContent = formatBps(summary.p95_egress_bps);

        // Billing
        var c = billingData.current;
        document.getElementById('billing-current-label').textContent = c.period;
        document.getElementById('billing-current-ingress').textContent = formatBps(c.p95_ingress_bps);
        document.getElementById('billing-current-egress').textContent = formatBps(c.p95_egress_bps);
        document.getElementById('billing-current-computed').textContent = c.computed_at
          ? 'Last computed: ' + new Date(c.computed_at).toLocaleString()
          : 'Not yet computed \u2014 runs daily at midnight UTC';
        var p = billingData.previous;
        document.getElementById('billing-prev-label').textContent = p.period;
        document.getElementById('billing-prev-ingress').textContent = formatBps(p.p95_ingress_bps);
        document.getElementById('billing-prev-egress').textContent = formatBps(p.p95_egress_bps);
        document.getElementById('billing-prev-computed').textContent = p.computed_at
          ? 'Last computed: ' + new Date(p.computed_at).toLocaleString()
          : 'Not yet computed \u2014 runs daily at midnight UTC';

        loadTunnelPage();
      }).catch(function(err) {
        document.getElementById('charts').innerHTML =
          '<p class="status error">Error loading data: ' + (err.message || err) + '</p>';
      });
    }

    init();
  </script>
</body>
</html>`;
}
