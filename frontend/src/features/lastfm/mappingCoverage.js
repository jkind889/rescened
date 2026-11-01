export function candidateCoverageWarning(evidence) {
  const coverage = (Array.isArray(evidence) ? evidence : []).find((item) => item?.source === "candidate_discovery" && item.candidateLimitReached);
  if (!coverage) return "";
  if (coverage.candidatesShown === 0) return "No candidates were found within the search limits. More matches may exist.";
  const summary = `Showing ${coverage.candidatesShown} of ${coverage.candidatesFound} discovered candidates.`;
  return coverage.candidateQueryLimitReached ? `${summary} Search limits were reached; more matches may exist.` : summary;
}
