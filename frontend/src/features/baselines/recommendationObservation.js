// Join a later browse page to the recommendation shown in this panel. If its private
// observation write failed, keep the visible releases but drop the provenance link.
export function mergeBrowsePage(current, page) {
  const prior = current || {};
  const browse = prior.coverage?.browse;
  const listed = browse ? browse.listed + (page?.items?.length || 0) : null;
  const coverage = browse ? {
    ...prior.coverage,
    browse: { ...browse, listed, complete: page?.incomplete === false && (!Number.isSafeInteger(browse.total) || listed >= browse.total) },
  } : prior.coverage;
  const pageRecorded = Boolean(page?.recommendationPageId && prior.recommendationRunId && page.recommendationRunId === prior.recommendationRunId);
  return {
    ...prior,
    items: [...(prior.items || []), ...(page?.items || [])],
    incomplete: Boolean(prior.incomplete || page?.incomplete),
    coverage,
    recommendationRunId: pageRecorded ? prior.recommendationRunId : "",
    recommendationPageIds: pageRecorded ? [...(prior.recommendationPageIds || []), page.recommendationPageId] : [],
  };
}
