import type { Env, TunnelStat } from './types';
import { verifyToken, rangeToSince, rangeToUntil, rangeToTable, tableToStepSeconds, snapToStep } from './utils';
import {
  buildPaginatedTunnelsSql,
  buildTunnelCountSql,
  buildTimeSeriesSql,
  getP95PerTunnelSql,
  getP95AggregateSql,
  getBillingP95Summary,
  getBillingP95Tunnels,
  storeTunnelMetrics,
  getGapCells,
  getGapCounts,
  getMetadata,
  CURRENT_METRICS_SQL,
  CHANGED_SINCE_SQL,
  CHANGED_SINCE_GROUP_SQL,
} from './d1';
import { fetchMetricsTimeSliced } from './graphql';
import { writeRawToR2, streamCsvExport, cleanupRawDay } from './r2';
import { toPeriod } from './utils';

const VALID_SORT_COLUMNS: Record<string, string> = {
  'name': 'tunnel_name',
  'p95-ingress': 'COALESCE(p95_ingress_bps, 0)',
  'p95-egress': 'COALESCE(p95_egress_bps, 0)',
  'p95-max': 'p95_max',
};

const VALID_SORT_DIRS = new Set(['ASC', 'DESC']);

const CHANGED_SINCE_MAX_ROWS = 20000;
const CHANGED_SINCE_LAG_MS = 60 * 1000;

const GAPS_MAX_ROWS = 50000;
const GAPS_MAX_SPAN_MS = 7 * 24 * 60 * 60 * 1000;

export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === '/api/backfill' && request.method === 'POST') {
    return handleBackfill(request, env);
  }

  if (pathname === '/api/cleanup' && request.method === 'POST') {
    return handleCleanup(request, env);
  }

  if (pathname === '/api/tunnels') {
    const range = url.searchParams.get('range') ?? '24h';
    const customStart = url.searchParams.get('start') ?? undefined;
    const customEnd = url.searchParams.get('end') ?? undefined;
    const table = rangeToTable(range, customStart && customEnd
      ? Math.ceil((new Date(customEnd).getTime() - new Date(customStart).getTime()) / 86400000)
      : undefined);
    const stepSeconds = tableToStepSeconds(table);
    const since = snapToStep(rangeToSince(range, customStart, customEnd), stepSeconds);
    const until = rangeToUntil(range, customStart, customEnd);

    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '20', 10)));
    const sortParam = url.searchParams.get('sort') ?? 'p95-max';
    const dirParam = (url.searchParams.get('dir') ?? 'DESC').toUpperCase();
    const search = url.searchParams.get('search') ?? '';

    const sortColumn = VALID_SORT_COLUMNS[sortParam] ?? 'p95_max';
    const sortDir = VALID_SORT_DIRS.has(dirParam) ? dirParam : 'DESC';
    const hasSearch = search.length > 0;
    const searchPattern = hasSearch ? `%${search}%` : undefined;

    const offset = (page - 1) * pageSize;

    const countSql = buildTunnelCountSql(table, hasSearch);
    const countStmt = env.DB.prepare(countSql);
    const countBound = hasSearch
      ? countStmt.bind(since, searchPattern)
      : countStmt.bind(since);
    const countResult = await countBound.first<{ total: number }>();
    const total = countResult?.total ?? 0;

    // Bind: ?1=since, ?2=pageSize, ?3=offset, ?4=until, ?5=step_seconds, ?6=searchPattern (if hasSearch)
    const sql = buildPaginatedTunnelsSql(table, sortColumn, sortDir, hasSearch);
    const stmt = env.DB.prepare(sql);
    const bound = hasSearch
      ? stmt.bind(since, pageSize, offset, until, stepSeconds, searchPattern)
      : stmt.bind(since, pageSize, offset, until, stepSeconds);
    const { results } = await bound.all<TunnelStat & { p95_max: number }>();

    const isEstimate = table !== 'raw';

    return Response.json({
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
      isEstimate,
      dataSource: table,
      tunnels: results.map((r) => ({
        name: r.tunnel_name,
        p95_ingress_bps: r.p95_ingress_bps,
        p95_egress_bps: r.p95_egress_bps,
      })),
    });
  }

  if (pathname === '/api/summary') {
    const range = url.searchParams.get('range') ?? '24h';
    const customStart = url.searchParams.get('start') ?? undefined;
    const customEnd = url.searchParams.get('end') ?? undefined;
    const table = rangeToTable(range, customStart && customEnd
      ? Math.ceil((new Date(customEnd).getTime() - new Date(customStart).getTime()) / 86400000)
      : undefined);
    const stepSeconds = tableToStepSeconds(table);
    const since = snapToStep(rangeToSince(range, customStart, customEnd), stepSeconds);
    const until = rangeToUntil(range, customStart, customEnd);

    const excludeParam = url.searchParams.get('exclude') ?? '';
    const excludeList = excludeParam ? excludeParam.split(',').map(decodeURIComponent) : [];
    const excludeJson = JSON.stringify(excludeList);

    // Bind: ?1=direction, ?2=since, ?3=excludeJson, ?4=until, ?5=step_seconds
    const aggSql = getP95AggregateSql(table);
    const [p95In, p95Eg] = await Promise.all([
      env.DB.prepare(aggSql).bind('ingress', since, excludeJson, until, stepSeconds).first<{ val: number }>(),
      env.DB.prepare(aggSql).bind('egress', since, excludeJson, until, stepSeconds).first<{ val: number }>(),
    ]);

    const isEstimate = table !== 'raw';

    return Response.json({
      p95_ingress_bps: p95In?.val ?? null,
      p95_egress_bps: p95Eg?.val ?? null,
      isEstimate,
      dataSource: table,
    });
  }

  if (pathname === '/api/metrics') {
    const tunnelsParam = url.searchParams.get('tunnels') ?? url.searchParams.get('tunnel') ?? '';
    if (!tunnelsParam) return new Response('Missing tunnel(s) parameter', { status: 400 });
    const tunnelNames = tunnelsParam.split(',').map(decodeURIComponent);

    const range = url.searchParams.get('range') ?? '24h';
    const customStart = url.searchParams.get('start') ?? undefined;
    const customEnd = url.searchParams.get('end') ?? undefined;
    const table = rangeToTable(range, customStart && customEnd
      ? Math.ceil((new Date(customEnd).getTime() - new Date(customStart).getTime()) / 86400000)
      : undefined);
    const stepSeconds = tableToStepSeconds(table);
    const since = snapToStep(rangeToSince(range, customStart, customEnd), stepSeconds);
    const until = rangeToUntil(range, customStart, customEnd);

    const tsSql = buildTimeSeriesSql(table);
    // Bind: ?1=tunnel_name, ?2=direction, ?3=since, ?4=until, ?5=step_seconds
    const p95Sql = getP95PerTunnelSql(table);
    const isEstimate = table !== 'raw';

    const results: Record<string, {
      ingress: Array<{ ts: string; bps: number }>;
      egress: Array<{ ts: string; bps: number }>;
      p95_ingress_bps: number | null;
      p95_egress_bps: number | null;
    }> = {};

    await Promise.all(tunnelNames.map(async (tunnel) => {
      const [ingressTs, egressTs, p95In, p95Eg] = await Promise.all([
        env.DB.prepare(tsSql).bind(tunnel, 'ingress', since).all<{ ts: string; bit_rate: number }>(),
        env.DB.prepare(tsSql).bind(tunnel, 'egress', since).all<{ ts: string; bit_rate: number }>(),
        env.DB.prepare(p95Sql).bind(tunnel, 'ingress', since, until, stepSeconds).first<{ val: number }>(),
        env.DB.prepare(p95Sql).bind(tunnel, 'egress', since, until, stepSeconds).first<{ val: number }>(),
      ]);

      results[tunnel] = {
        ingress: ingressTs.results.map((r) => ({ ts: r.ts, bps: r.bit_rate })),
        egress: egressTs.results.map((r) => ({ ts: r.ts, bps: r.bit_rate })),
        p95_ingress_bps: p95In?.val ?? null,
        p95_egress_bps: p95Eg?.val ?? null,
      };
    }));

    return Response.json({ tunnels: results, isEstimate, dataSource: table });
  }

  if (pathname === '/api/billing') {
    const now = new Date();
    const currentPeriod = toPeriod(now);
    const prevDate = new Date(now);
    prevDate.setUTCMonth(prevDate.getUTCMonth() - 1);
    const prevPeriod = toPeriod(prevDate);

    const [current, previous] = await Promise.all([
      getBillingP95Summary(env.DB, currentPeriod),
      getBillingP95Summary(env.DB, prevPeriod),
    ]);

    return Response.json({
      current: {
        period: currentPeriod,
        p95_ingress_bps: current.ingress,
        p95_egress_bps: current.egress,
        computed_at: current.computed_at,
      },
      previous: {
        period: prevPeriod,
        p95_ingress_bps: previous.ingress,
        p95_egress_bps: previous.egress,
        computed_at: previous.computed_at,
      },
    });
  }

  if (pathname === '/api/billing/tunnels') {
    const period = url.searchParams.get('period') ?? toPeriod(new Date());
    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '20', 10)));
    const sortParam = url.searchParams.get('sort') ?? 'p95-max';
    const dirParam = (url.searchParams.get('dir') ?? 'DESC').toUpperCase();
    const sortDir = VALID_SORT_DIRS.has(dirParam) ? dirParam : 'DESC';
    const offset = (page - 1) * pageSize;

    const { tunnels, total } = await getBillingP95Tunnels(
      env.DB, period, sortParam, sortDir, pageSize, offset,
    );

    return Response.json({
      period,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
      tunnels: tunnels.map((t) => ({
        name: t.tunnel_name,
        p95_ingress_bps: t.p95_ingress_bps,
        p95_egress_bps: t.p95_egress_bps,
      })),
    });
  }

  if (pathname === '/api/export') {
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    if (!start || !end) return new Response('Missing start or end', { status: 400 });
    if (isNaN(Date.parse(start)) || isNaN(Date.parse(end))) {
      return new Response('Invalid date format', { status: 400 });
    }

    const startDate = new Date(start);
    const endDate = new Date(end);

    const maxMs = 180 * 24 * 60 * 60 * 1000;
    if (endDate.getTime() - startDate.getTime() > maxMs) {
      return new Response('Date range exceeds 180 days', { status: 400 });
    }

    const tunnel = url.searchParams.get('tunnel') ?? null;
    const csvStream = await streamCsvExport(env.RAW_METRICS, startDate, endDate, tunnel);
    const gzipStream = csvStream.pipeThrough(new CompressionStream('gzip'));

    const filename = tunnel
      ? `wanstats-${tunnel}-${start.slice(0, 10)}-to-${end.slice(0, 10)}.csv.gz`
      : `wanstats-all-${start.slice(0, 10)}-to-${end.slice(0, 10)}.csv.gz`;

    return new Response(gzipStream, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  }

  if (pathname === '/api/gaps') {
    const startParam = url.searchParams.get('start');
    const endParam = url.searchParams.get('end');
    if (!startParam || !endParam || isNaN(Date.parse(startParam)) || isNaN(Date.parse(endParam))) {
      return new Response('Missing or invalid start/end — use ISO 8601', { status: 400 });
    }
    const startDate = new Date(startParam);
    const endDate = new Date(endParam);
    if (endDate.getTime() - startDate.getTime() > GAPS_MAX_SPAN_MS) {
      return new Response('Range exceeds 7 days', { status: 400 });
    }
    const statusParam = url.searchParams.get('status');
    if (statusParam !== null && statusParam !== 'pending' && statusParam !== 'confirmed_empty') {
      return new Response('status must be pending or confirmed_empty', { status: 400 });
    }
    const tunnel = url.searchParams.get('tunnel');

    // Raw ts format bounds (no milliseconds).
    const start = startDate.toISOString().slice(0, 19) + 'Z';
    const end = endDate.toISOString().slice(0, 19) + 'Z';
    const cells = await getGapCells(env.DB, start, end, tunnel, statusParam, GAPS_MAX_ROWS + 1);
    const truncated = cells.length > GAPS_MAX_ROWS;
    const page = truncated ? cells.slice(0, GAPS_MAX_ROWS) : cells;

    let pending = 0;
    let confirmedEmpty = 0;
    for (const c of page) {
      if (c.confirmed_empty_at === null) pending++; else confirmedEmpty++;
    }

    return Response.json({
      start, end, pending, confirmed_empty: confirmedEmpty, truncated,
      cells: page.map((c) => ({
        tunnel_name: c.tunnel_name,
        direction: c.direction,
        ts: c.ts,
        status: c.confirmed_empty_at === null ? 'pending' : 'confirmed_empty',
        attempts: c.attempts,
        first_detected: c.first_detected,
        confirmed_empty_at: c.confirmed_empty_at,
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (pathname === '/api/health') {
    const now = new Date();
    const keys = [
      'last_cron_run', 'last_tunnel_count', 'last_full_run_at', 'last_full_run_ok',
      'reconciled_through', 'last_error_at', 'last_error_step', 'last_error_message',
    ] as const;
    const values = await Promise.all(keys.map((k) => getMetadata(env.DB, k)));
    const meta = Object.fromEntries(keys.map((k, i) => [k, values[i]])) as Record<typeof keys[number], string | null>;

    const reconciledThrough = meta.reconciled_through;
    const hoursBehind = reconciledThrough === null
      ? null
      : Math.max(0, Math.floor((now.getTime() - 2 * 60 * 60 * 1000 - new Date(reconciledThrough).getTime()) / (60 * 60 * 1000)));

    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const counts = await getGapCounts(env.DB, sevenDaysAgo);

    return Response.json({
      generated_at: now.toISOString(),
      last_cron_run: meta.last_cron_run,
      last_tunnel_count: meta.last_tunnel_count === null ? null : parseInt(meta.last_tunnel_count, 10),
      last_full_run_at: meta.last_full_run_at,
      last_full_run_ok: meta.last_full_run_ok === null ? null : meta.last_full_run_ok === 'true',
      reconciled_through: reconciledThrough,
      hours_behind: hoursBehind,
      pending_gaps: counts.pending,
      confirmed_empty_7d: counts.confirmedEmpty,
      last_error: meta.last_error_at === null ? null : {
        at: meta.last_error_at,
        step: meta.last_error_step,
        message: meta.last_error_message,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (pathname === '/api/current') {
    const now = new Date();
    const sinceParam = url.searchParams.get('since');

    if (sinceParam !== null) {
      if (isNaN(Date.parse(sinceParam))) return new Response('Invalid since — use ISO 8601', { status: 400 });
      const since = new Date(sinceParam).toISOString();
      // 60s lag: every row of one storeTunnelMetrics call shares a written_at
      // and commits within seconds, so nothing mid-commit is ever skipped.
      const until = new Date(now.getTime() - CHANGED_SINCE_LAG_MS).toISOString();

      const maxParam = parseInt(url.searchParams.get('_max_rows') ?? '', 10);
      const maxRows = Number.isInteger(maxParam) && maxParam > 0 && maxParam < CHANGED_SINCE_MAX_ROWS
        ? maxParam
        : CHANGED_SINCE_MAX_ROWS;

      const { results } = await env.DB.prepare(CHANGED_SINCE_SQL)
        .bind(since, until, maxRows + 1)
        .all<{ tunnel_name: string; direction: string; ts: string; bit_rate: number; written_at: string }>();

      let rows = results;
      let truncated = false;
      let nextSince = until;
      if (results.length > maxRows) {
        truncated = true;
        const cutoff = results[maxRows].written_at;
        const complete = results.filter((r) => r.written_at !== cutoff);
        if (complete.length > 0) {
          // Drop the incomplete trailing group; resume from the last complete one.
          rows = complete;
          nextSince = rows[rows.length - 1].written_at;
        } else {
          // The whole page is one group. Return it intact even though it
          // exceeds the cap: splitting it would lose its tail forever, since
          // the next poll filters written_at > next_since.
          const group = await env.DB.prepare(CHANGED_SINCE_GROUP_SQL)
            .bind(cutoff)
            .all<{ tunnel_name: string; direction: string; ts: string; bit_rate: number; written_at: string }>();
          rows = group.results;
          nextSince = cutoff;
        }
      }

      return Response.json({
        generated_at: now.toISOString(),
        mode: 'since',
        since,
        next_since: nextSince,
        truncated,
        row_count: rows.length,
        rows: rows.map((r) => ({
          tunnel_name: r.tunnel_name,
          direction: r.direction,
          ts: r.ts,
          bit_rate_bps: r.bit_rate,
          written_at: r.written_at,
        })),
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const windowParam = parseInt(url.searchParams.get('window') ?? '', 10);
    const windowMinutes = isNaN(windowParam) ? 20 : Math.min(1440, Math.max(5, windowParam));
    // Match the raw ts storage format (no milliseconds) for clean string comparison.
    const since = new Date(now.getTime() - windowMinutes * 60 * 1000)
      .toISOString().slice(0, 19) + 'Z';

    const { results } = await env.DB.prepare(CURRENT_METRICS_SQL)
      .bind(since)
      .all<{ tunnel_name: string; direction: string; ts: string; bit_rate: number; written_at: string | null }>();

    return Response.json({
      generated_at: now.toISOString(),
      mode: 'window',
      window_minutes: windowMinutes,
      row_count: results.length,
      rows: results.map((r) => ({
        tunnel_name: r.tunnel_name,
        direction: r.direction,
        ts: r.ts,
        bit_rate_bps: r.bit_rate,
        written_at: r.written_at,
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  return new Response('Not found', { status: 404 });
}

async function handleCleanup(request: Request, env: Env): Promise<Response> {
  const provided = request.headers.get('X-Backfill-Token') ?? '';
  if (!(await verifyToken(provided, env.BACKFILL_TOKEN))) {
    return new Response('Unauthorized', { status: 401 });
  }

  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
    return new Response('Missing or invalid date query param — use YYYY-MM-DD', { status: 400 });
  }

  const { filesProcessed, duplicatesRemoved } = await cleanupRawDay(env.RAW_METRICS, date);

  return Response.json({ date, filesProcessed, duplicatesRemoved });
}

async function handleBackfill(request: Request, env: Env): Promise<Response> {
  const provided = request.headers.get('X-Backfill-Token') ?? '';
  if (!(await verifyToken(provided, env.BACKFILL_TOKEN))) {
    return new Response('Unauthorized', { status: 401 });
  }

  const url = new URL(request.url);
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');

  if (!start || !end) {
    return new Response('Missing start or end query param', { status: 400 });
  }
  if (isNaN(Date.parse(start)) || isNaN(Date.parse(end))) {
    return new Response('Invalid datetime format — use ISO 8601', { status: 400 });
  }
  if (new Date(start) >= new Date(end)) {
    return new Response('start must be before end', { status: 400 });
  }

  const { ingress, egress, warnings, failedSlices } = await fetchMetricsTimeSliced(
    env.ACCOUNT_ID,
    env.WAN_API_TOKEN,
    new Date(start),
    new Date(end),
  );

  await Promise.all([
    Promise.all([
      storeTunnelMetrics(env.DB, ingress, 'ingress'),
      storeTunnelMetrics(env.DB, egress, 'egress'),
    ]),
    writeRawToR2(env.RAW_METRICS, ingress, egress),
  ]);

  return Response.json({
    start,
    end,
    ingress_rows: ingress.length,
    egress_rows: egress.length,
    failed_slices: failedSlices,
    warnings,
  });
}
