export interface Env {
  DB: D1Database;
  RAW_METRICS: R2Bucket;
  WAN_API_TOKEN: string;
  ACCOUNT_ID: string;
  BACKFILL_TOKEN: string;
}

export interface IngressDimensions {
  ingressTunnelName: string;
  datetimeFiveMinutes?: string;
  datetimeFiveMinute?: string;
}

export interface EgressDimensions {
  egressTunnelName: string;
  datetimeFiveMinutes?: string;
  datetimeFiveMinute?: string;
}

export interface IngressRow {
  avg: { bitRateFiveMinutes: number };
  dimensions: IngressDimensions;
}

export interface EgressRow {
  avg: { bitRateFiveMinutes: number };
  dimensions: EgressDimensions;
}

export interface GraphQLResponse {
  data?: {
    viewer: {
      accounts: Array<{
        ingress: IngressRow[];
        egress: EgressRow[];
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

export type NormalizedRow = { tunnelName: string; ts: string; bitRate: number };

export interface TunnelStat {
  tunnel_name: string;
  p95_ingress_bps: number | null;
  p95_egress_bps: number | null;
}

export interface BillingP95Result {
  period: string;
  aggregate_ingress_bps: number | null;
  aggregate_egress_bps: number | null;
  sample_count: number;
  computed_at: string;
}
