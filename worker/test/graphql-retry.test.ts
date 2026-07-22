import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchMetricsTimeSliced } from '../src/graphql';

function graphqlOk(): Response {
  return Response.json({
    data: {
      viewer: {
        accounts: [{
          ingress: [{
            avg: { bitRateFiveMinutes: 12345 },
            dimensions: { datetimeFiveMinutes: '2026-07-21T04:00:00Z', ingressTunnelName: 'TUN_A' },
          }],
          egress: [],
        }],
      },
    },
  });
}

function rateLimited(): Response {
  // Retry-After: 0 keeps the test fast; the impl must honor the header.
  return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchSingleBucket retry on rate limit', () => {
  it('retries a 429 response with backoff instead of failing the run', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(graphqlOk());
    vi.stubGlobal('fetch', fetchMock);

    const { ingress, egress } = await fetchMetricsTimeSliced(
      'acct', 'token',
      new Date('2026-07-21T04:00:00Z'),
      new Date('2026-07-21T04:05:00Z'),
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(ingress).toEqual([{ tunnelName: 'TUN_A', ts: '2026-07-21T04:00:00Z', bitRate: 12345 }]);
    expect(egress).toEqual([]);
  });

  it('gives up after exhausting retries and reports the 429', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rateLimited());
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchMetricsTimeSliced(
      'acct', 'token',
      new Date('2026-07-21T04:00:00Z'),
      new Date('2026-07-21T04:05:00Z'),
    )).rejects.toThrow(/429/);

    expect(fetchMock).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('does not retry a non-retryable client error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchMetricsTimeSliced(
      'acct', 'token',
      new Date('2026-07-21T04:00:00Z'),
      new Date('2026-07-21T04:05:00Z'),
    )).rejects.toThrow(/400/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
