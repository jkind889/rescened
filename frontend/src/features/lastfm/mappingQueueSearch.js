export const MAX_MAPPING_QUEUE_SEARCH_LENGTH = 200;
export const MAPPING_QUEUE_SEARCH_DEBOUNCE_MS = 200;

export function normalizeMappingQueueSearch(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function isMappingQueueSearchTooLong(value) {
  return normalizeMappingQueueSearch(value).length > MAX_MAPPING_QUEUE_SEARCH_LENGTH;
}

export function buildMappingQueueParams({ status, priorityOnly, staleOnly, query, cursor }) {
  return {
    status,
    cursor,
    priority: priorityOnly ? "high" : "",
    stale: staleOnly ? "true" : "",
    q: normalizeMappingQueueSearch(query),
  };
}

export function appendUniqueMappingCases(current, incoming) {
  const seen = new Set(current.map((item) => item.caseId));
  const appended = [...current];
  for (const item of incoming) {
    if (seen.has(item.caseId)) continue;
    seen.add(item.caseId);
    appended.push(item);
  }
  return appended;
}

// Token lookup and response parsing can finish after a request is cancelled.
export function createMappingQueueRequestGate() {
  let current = null;
  return {
    begin() {
      current?.abort();
      current = new AbortController();
      return current;
    },
    isCurrent(ticket) { return current === ticket && !ticket.signal.aborted; },
    cancel() { current?.abort(); current = null; },
  };
}

export function mappingQueueStatusLabel({ itemsCount, hasMore, query, loading, loadingMore, error }) {
  if ((!loadingMore && loading) || (!itemsCount && error) || !itemsCount) return "";
  const noun = itemsCount === 1 && !hasMore ? "case" : "cases";
  return `${itemsCount}${hasMore ? "+" : ""} ${query ? "matching " : ""}${noun}${loadingMore ? " · Loading more…" : ""}`;
}
