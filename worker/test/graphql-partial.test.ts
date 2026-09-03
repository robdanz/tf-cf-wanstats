import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchMetricsTimeSliced } from '../src/graphql';

function graphqlOk(ts: string): Response {
  return Response.json({
    data: {
      viewer: {
        accounts: [{
          ingress: [{ avg: { bitRateFiveMinutes: 100 }, dimensions: { datetimeFiveMinutes: ts, ingressTunnelName: 'TUN_P' } }],
          egress: [],
        }],
      },
    },
  });
}

function serverError(): Response {
  return new Response('boom', { status: 500, headers: { 'Retry-After': '0' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchMetricsTimeSliced per-slice isolation', () => {
  it('keeps the good slices and reports the failed one instead of throwing', async () => {
    // Three slices: 04:00, 04:05, 04:10. The middle one fails 4 times (initial + 3 retries).
    const fetchMock = vi.fn()
      .mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { variables: { datetimeStart: string } };
        if (body.variables.datetimeStart === '2026-07-21T04:05:00.000Z') return serverError();
        return graphqlOk(body.variables.datetimeStart.replace('.000Z', 'Z'));
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchMetricsTimeSliced(
      'acct', 'token',
      new Date('2026-07-21T04:00:00Z'),
      new Date('2026-07-21T04:15:00Z'),
    );

    expect(result.sliceCount).toBe(3);
    expect(result.failedSlices).toEqual(['2026-07-21T04:05:00.000Z']);
    expect(result.ingress.map((r) => r.ts)).toEqual(['2026-07-21T04:00:00Z', '2026-07-21T04:10:00Z']);
    expect(result.warnings.some((w) => w.includes('2026-07-21T04:05:00.000Z'))).toBe(true);
  });

  it('returns empty rows and every slice in failedSlices when all fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serverError()));

    const result = await fetchMetricsTimeSliced(
      'acct', 'token',
      new Date('2026-07-21T04:00:00Z'),
      new Date('2026-07-21T04:10:00Z'),
    );

    expect(result.sliceCount).toBe(2);
    expect(result.failedSlices).toHaveLength(2);
    expect(result.ingress).toEqual([]);
    expect(result.egress).toEqual([]);
  });
});
