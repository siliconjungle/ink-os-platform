export type EffectStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'fenced';
export interface EffectRun {
  id: string;
  requestId: string;
  appId: string;
  releaseId: string;
  entry: string;
  status: EffectStatus;
  phase: string;
  sequence: number;
  createdAt: number;
  deadlineAt: number;
  value?: unknown;
  valueWire?: string;
  observation?: unknown;
  observationWire?: string;
  error?: { code: string; message: string };
  lastEffect?: {
    operation: string;
    kind: string;
    sequence: number;
    attempt: number;
    version: string | null;
    error: {
      code: string;
      message: string;
      certainty: 'unknown' | 'not-applied';
      retryable: boolean;
    } | null;
  };
  cancellation: { requested: boolean; mayHaveTakenEffect: boolean };
}
export interface EffectOptions {
  requestId?: string;
  backend?: 'javascript' | 'native' | 'auto';
  releaseId?: string;
}
export function effectRequestId(): string;
export function createEffects(
  request: (
    action: 'start' | 'get' | 'cancel',
    input: Record<string, unknown>,
  ) => Promise<EffectRun>,
): Readonly<{
  start(
    entry: string,
    input?: string,
    options?: EffectOptions,
  ): Promise<EffectRun>;
  get(id: string): Promise<EffectRun>;
  cancel(id: string): Promise<EffectRun>;
}>;
