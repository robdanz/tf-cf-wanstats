import type { IngressRow, EgressRow, GraphQLResponse, NormalizedRow } from './types';
import { snapToFiveMin } from './utils';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const GRAPHQL_LIMIT = 3000;

function buildQuery(limit: number): string {
  return `
  query MwanTunnelBitrate(
    $accountTag: string,
    $datetimeStart: string,
    $datetimeEnd: string
  ) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        ingress: magicTransitNetworkAnalyticsAdaptiveGroups(
          filter: {
            datetime_geq: $datetimeStart,
            datetime_lt: $datetimeEnd,
            ingressTunnelName_notin: ["", "device_id"]
          }
          limit: ${limit}
          orderBy: [datetimeFiveMinutes_ASC]
        ) {
          avg { bitRateFiveMinutes }
          dimensions {
            datetimeFiveMinutes
            ingressTunnelName
          }
        }
        egress: magicTransitNetworkAnalyticsAdaptiveGroups(
          filter: {
            datetime_geq: $datetimeStart,
            datetime_lt: $datetimeEnd,
            egressTunnelName_notin: ["", "device_id"]
          }
          limit: ${limit}
          orderBy: [datetimeFiveMinutes_ASC]
        ) {
          avg { bitRateFiveMinutes }
          dimensions {
            datetimeFiveMinutes
            egressTunnelName
          }
        }
      }
    }
  }
`;
}

const GRAPHQL_QUERY = buildQuery(GRAPHQL_LIMIT);

export interface TimeSlice {
  start: string;
  end: string;
}

export function generateTimeSlices(start: Date, end: Date): TimeSlice[] {
  const slices: TimeSlice[] = [];
  let current = snapToFiveMin(start);

  while (current < end) {
    const bucketEnd = new Date(current.getTime() + FIVE_MINUTES_MS);
    const actualEnd = bucketEnd > end ? end : bucketEnd;
    slices.push({
      start: current.toISOString(),
      end: actualEnd.toISOString(),
    });
    current = bucketEnd;
  }

  return slices;
}

async function fetchSingleBucket(
  accountId: string,
  apiToken: string,
  datetimeStart: string,
  datetimeEnd: string,
): Promise<{ ingress: IngressRow[]; egress: EgressRow[] }> {
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: GRAPHQL_QUERY,
      variables: { accountTag: accountId, datetimeStart, datetimeEnd },
    }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as GraphQLResponse;
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(', ')}`);
  }

  const account = json.data?.viewer.accounts[0];
  return {
    ingress: account?.ingress ?? [],
    egress: account?.egress ?? [],
  };
}

export async function fetchMetricsTimeSliced(
  accountId: string,
  apiToken: string,
  start: Date,
  end: Date,
): Promise<{ ingress: NormalizedRow[]; egress: NormalizedRow[]; warnings: string[] }> {
  const slices = generateTimeSlices(start, end);
  const allIngress: NormalizedRow[] = [];
  const allEgress: NormalizedRow[] = [];
  const warnings: string[] = [];

  for (const slice of slices) {
    const { ingress, egress } = await fetchSingleBucket(
      accountId, apiToken, slice.start, slice.end,
    );

    if (ingress.length >= GRAPHQL_LIMIT) {
      const msg = `WARNING: Ingress hit limit ${GRAPHQL_LIMIT} for bucket ${slice.start}. Data may be truncated.`;
      console.warn(msg);
      warnings.push(msg);
    }
    if (egress.length >= GRAPHQL_LIMIT) {
      const msg = `WARNING: Egress hit limit ${GRAPHQL_LIMIT} for bucket ${slice.start}. Data may be truncated.`;
      console.warn(msg);
      warnings.push(msg);
    }

    const normalized = normalizeMetrics(ingress, egress);
    allIngress.push(...normalized.ingress);
    allEgress.push(...normalized.egress);
  }

  console.log(`Fetched ${allIngress.length} ingress rows, ${allEgress.length} egress rows across ${slices.length} time slices`);

  return { ingress: allIngress, egress: allEgress, warnings };
}

export function normalizeMetrics(
  ingressRows: IngressRow[],
  egressRows: EgressRow[],
): { ingress: NormalizedRow[]; egress: NormalizedRow[] } {
  const ingress = ingressRows.map((row) => {
    const ts = row.dimensions.datetimeFiveMinutes ?? row.dimensions.datetimeFiveMinute;
    if (!ts) throw new Error(`Missing datetime for ingress tunnel ${row.dimensions.ingressTunnelName}`);
    return { tunnelName: row.dimensions.ingressTunnelName, ts, bitRate: row.avg.bitRateFiveMinutes };
  });

  const egress = egressRows.map((row) => {
    const ts = row.dimensions.datetimeFiveMinutes ?? row.dimensions.datetimeFiveMinute;
    if (!ts) throw new Error(`Missing datetime for egress tunnel ${row.dimensions.egressTunnelName}`);
    return { tunnelName: row.dimensions.egressTunnelName, ts, bitRate: row.avg.bitRateFiveMinutes };
  });

  return { ingress, egress };
}
