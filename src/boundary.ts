import type { MonitorIngressDecision } from "./types/events.js";
import type {
  MonitorAdmissionPosture,
  MonitorAdmissionReasonCode,
} from "./types/snapshots.js";

export type MonitorBoundaryErrorCode =
  | "ERR_MONITOR_CLOSED"
  | "ERR_MONITOR_ADMISSION_REFUSED"
  | "ERR_MONITOR_STORAGE_BUSY"
  | "ERR_MONITOR_STORAGE_FULL"
  | "ERR_MONITOR_STORAGE_READ_ONLY"
  | "ERR_MONITOR_STORAGE_IO"
  | "ERR_MONITOR_OUTCOME_INDETERMINATE";

export type MonitorBoundaryOutcome =
  | "definite_rejection"
  | "indeterminate";

export type MonitorBoundaryRecommendedAction =
  | "do_not_retry"
  | "retry_when_admission_reopens"
  | "retry_after_contention_clears"
  | "free_local_storage_then_retry"
  | "restore_writable_local_storage_then_retry"
  | "stop_and_inspect_storage"
  | "reconcile_from_monitor_storage";

export interface MonitorBoundaryFailure {
  code: MonitorBoundaryErrorCode;
  operation: string;
  outcome: MonitorBoundaryOutcome;
  retryable: boolean;
  recommendedAction: MonitorBoundaryRecommendedAction;
  message: string;
}

export interface MonitorAdmissionDecision {
  posture: MonitorAdmissionPosture;
  accepted: boolean;
  httpStatus: 202 | 503;
  reasonCode: MonitorAdmissionReasonCode;
}

export class MonitorBoundaryError extends Error {
  readonly code: MonitorBoundaryErrorCode;
  readonly operation: string;
  readonly outcome: MonitorBoundaryOutcome;
  readonly retryable: boolean;
  readonly recommendedAction: MonitorBoundaryRecommendedAction;

  constructor(
    failure: MonitorBoundaryFailure,
    options: { cause?: unknown } = {},
  ) {
    super(
      failure.message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "MonitorBoundaryError";
    this.code = failure.code;
    this.operation = failure.operation;
    this.outcome = failure.outcome;
    this.retryable = failure.retryable;
    this.recommendedAction = failure.recommendedAction;
  }

  toJSON(): MonitorBoundaryFailure {
    return {
      code: this.code,
      operation: this.operation,
      outcome: this.outcome,
      retryable: this.retryable,
      recommendedAction: this.recommendedAction,
      message: this.message,
    };
  }
}

export class MonitorClosedError extends MonitorBoundaryError {
  constructor(operation: string) {
    super({
      code: "ERR_MONITOR_CLOSED",
      operation,
      outcome: "definite_rejection",
      retryable: false,
      recommendedAction: "do_not_retry",
      message: `Cannot ${operation} because the monitor is closed.`,
    });
    this.name = "MonitorClosedError";
  }
}

export class MonitorAdmissionRefusedError extends MonitorBoundaryError {
  readonly httpStatus = 503 as const;
  readonly decision: MonitorIngressDecision;

  constructor(decision: MonitorIngressDecision) {
    super({
      code: "ERR_MONITOR_ADMISSION_REFUSED",
      operation: "admit an ingress event",
      outcome: "definite_rejection",
      retryable: true,
      recommendedAction: "retry_when_admission_reopens",
      message:
        "The monitor is in a protective refusal posture; the event was not persisted. Return HTTP 503 when this error crosses an HTTP ingress boundary.",
    });
    this.name = "MonitorAdmissionRefusedError";
    this.decision = decision;
  }
}

export class MonitorIndeterminateOutcomeError extends MonitorBoundaryError {
  readonly rowId: number | null;

  constructor(operation: string, rowId: number | null, cause: unknown) {
    super(
      {
        code: "ERR_MONITOR_OUTCOME_INDETERMINATE",
        operation,
        outcome: "indeterminate",
        retryable: false,
        recommendedAction: "reconcile_from_monitor_storage",
        message:
          `The monitor persisted row ${rowId ?? "unknown"} but ${operation} did not complete observably. ` +
          "Reconcile from monitor storage; do not assume the event was absent or delivered.",
      },
      { cause },
    );
    this.name = "MonitorIndeterminateOutcomeError";
    this.rowId = rowId;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyMonitorBoundaryFailure(
  error: unknown,
  operation = "perform the monitor operation",
): MonitorBoundaryFailure | null {
  if (error instanceof MonitorBoundaryError) {
    return error.toJSON();
  }

  const message = errorText(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("database is locked") || normalized.includes("database is busy")) {
    return {
      code: "ERR_MONITOR_STORAGE_BUSY",
      operation,
      outcome: "definite_rejection",
      retryable: true,
      recommendedAction: "retry_after_contention_clears",
      message,
    };
  }
  if (normalized.includes("database or disk is full") || normalized.includes("sqlite_full")) {
    return {
      code: "ERR_MONITOR_STORAGE_FULL",
      operation,
      outcome: "definite_rejection",
      retryable: true,
      recommendedAction: "free_local_storage_then_retry",
      message,
    };
  }
  if (normalized.includes("readonly") || normalized.includes("read-only")) {
    return {
      code: "ERR_MONITOR_STORAGE_READ_ONLY",
      operation,
      outcome: "definite_rejection",
      retryable: true,
      recommendedAction: "restore_writable_local_storage_then_retry",
      message,
    };
  }
  if (
    normalized.includes("disk i/o") ||
    normalized.includes("sqlite_ioerr") ||
    normalized.includes("unable to open database")
  ) {
    return {
      code: "ERR_MONITOR_STORAGE_IO",
      operation,
      outcome: "definite_rejection",
      retryable: false,
      recommendedAction: "stop_and_inspect_storage",
      message,
    };
  }
  return null;
}

export function deriveMonitorAdmissionDecision(
  decision: MonitorIngressDecision,
): MonitorAdmissionDecision {
  if (decision.action === "pause") {
    return {
      posture: "protective_refusal",
      accepted: false,
      httpStatus: 503,
      reasonCode: "MONITOR_PROTECTIVE_THROTTLE",
    };
  }
  if (decision.action === "buffer_only") {
    return {
      posture: "accepted_buffered",
      accepted: true,
      httpStatus: 202,
      reasonCode: decision.routingMode === "replay_through_dedupe"
        ? "MONITOR_RECOVERY_GATE_BUFFERING"
        : "MONITOR_OUTAGE_BUFFERING",
    };
  }
  return {
    posture: "accepted_live",
    accepted: true,
    httpStatus: 202,
    reasonCode: "MONITOR_LIVE_FLOW_AVAILABLE",
  };
}

export function toMonitorBoundaryError(
  error: unknown,
  operation: string,
): unknown {
  if (error instanceof MonitorBoundaryError) return error;
  const failure = classifyMonitorBoundaryFailure(error, operation);
  return failure === null ? error : new MonitorBoundaryError(failure, { cause: error });
}
