export type ScheduledState =
  "ok" | "running" | "failed" | "overdue" | "never" | "unloaded" | "unknown";

export type ScheduledJob = {
  app_id: string;
  service_id: string;
  state: ScheduledState;
  message: string;
  schedule: string | null;
  expected_interval: number | null;
  last_run_at: string | null;
  exit_code: number | null;
};

/** 異常として扱う状態（失敗・遅延）。 */
export const isScheduledAbnormal = (state: ScheduledState | undefined): boolean =>
  state === "failed" || state === "overdue";

/** アプリ内の異常な定期ジョブ（アプリカードの警告用）。 */
export function abnormalJobs(appId: string, jobs: Record<string, ScheduledJob>): ScheduledJob[] {
  return Object.values(jobs).filter((j) => j.app_id === appId && isScheduledAbnormal(j.state));
}
