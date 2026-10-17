export type MetricTags = Readonly<Record<string, string>>;

export interface Metrics {
  increment(name: string, tags?: MetricTags): void;
  /**
   * Records a measurement when the adapter supports duration/distribution data.
   * Optional during the migration so existing counter-only adapters remain valid.
   */
  observe?(name: string, value: number, tags?: MetricTags): void;
  /**
   * Sets the current value of a gauge/snapshot when the adapter supports it.
   * Optional during the migration so existing counter-only adapters remain valid.
   */
  set?(name: string, value: number, tags?: MetricTags): void;
}

export const METRICS = Symbol('METRICS');
