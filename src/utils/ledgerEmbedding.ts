export type LedgerEmbeddingStatus = "pending" | "ready" | "failed" | "skipped";

export interface EmbeddingRetryCandidate {
  summary: string;
  decisions?: string[] | null;
  embedding_status?: unknown;
  embedding_retry_count?: unknown;
  embedding_last_attempt_at?: unknown;
}

export function getLedgerEmbeddingSegments(
  summary: string,
  decisions?: string[] | null,
): string[] {
  return [summary, ...(Array.isArray(decisions) ? decisions : [])]
    .map((segment) => (typeof segment === "string" ? segment.trim() : ""))
    .filter(Boolean);
}

export function buildLedgerEmbeddingText(
  summary: string,
  decisions?: string[] | null,
  separator: string = "\n",
): string {
  return getLedgerEmbeddingSegments(summary, decisions).join(separator);
}

export function hasEmbeddableLedgerContent(
  summary: string,
  decisions?: string[] | null,
): boolean {
  return getLedgerEmbeddingSegments(summary, decisions).length > 0;
}

export function assertEmbeddableLedgerContent(
  summary: string,
  decisions?: string[] | null,
  context: string = "saveLedger",
): string {
  const embeddingText = buildLedgerEmbeddingText(summary, decisions);
  if (!embeddingText) {
    throw new Error(`${context} requires a non-empty summary or decision.`);
  }
  return embeddingText;
}

export function getEmbeddingRetryCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return 0;
}

export function normalizeEmbeddingError(
  error: unknown,
  maxLength: number = 500,
): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const trimmed = rawMessage.trim() || "Unknown embedding error";
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(1, maxLength - 1))}...`;
}

export function createPendingEmbeddingState() {
  return {
    embedding_status: "pending" as const,
    embedding_last_error: null,
    embedding_retry_count: 0,
    embedding_last_attempt_at: null,
  };
}

export function createReadyEmbeddingState(attemptedAt: string) {
  return {
    embedding_status: "ready" as const,
    embedding_last_error: null,
    embedding_last_attempt_at: attemptedAt,
  };
}

export function createFailedEmbeddingState(
  error: unknown,
  retryCount: number,
  attemptedAt: string,
) {
  return {
    embedding_status: "failed" as const,
    embedding_last_error: normalizeEmbeddingError(error),
    embedding_retry_count: retryCount,
    embedding_last_attempt_at: attemptedAt,
  };
}

export function createSkippedEmbeddingState(reason: string, attemptedAt: string) {
  return {
    embedding_status: "skipped" as const,
    embedding_last_error: reason,
    embedding_last_attempt_at: attemptedAt,
  };
}

export function isEmbeddingRetryEligible(
  candidate: EmbeddingRetryCandidate,
  options: {
    maxRetryCount?: number;
    retryBefore?: string | Date;
  } = {},
): boolean {
  if (!hasEmbeddableLedgerContent(candidate.summary, candidate.decisions)) {
    return false;
  }

  const status = typeof candidate.embedding_status === "string"
    ? candidate.embedding_status
    : null;
  if (status === "ready" || status === "skipped") {
    return false;
  }

  const retryCount = getEmbeddingRetryCount(candidate.embedding_retry_count);
  if (typeof options.maxRetryCount === "number" && retryCount >= options.maxRetryCount) {
    return false;
  }

  if (options.retryBefore !== undefined) {
    const cutoffMs = options.retryBefore instanceof Date
      ? options.retryBefore.getTime()
      : Date.parse(options.retryBefore);
    const lastAttemptMs = typeof candidate.embedding_last_attempt_at === "string"
      ? Date.parse(candidate.embedding_last_attempt_at)
      : Number.NaN;

    if (Number.isFinite(cutoffMs) && Number.isFinite(lastAttemptMs) && lastAttemptMs > cutoffMs) {
      return false;
    }
  }

  return true;
}
