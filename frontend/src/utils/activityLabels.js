const approvalLabels = {
  catalog_created: { label: "Album suggestion approved", action: "contributed" },
  catalog_linked: { label: "Suggestion approved", action: "had a suggestion approved for" },
  catalog_corrected: { label: "Correction approved", action: "contributed a correction to" },
  genres_updated: { label: "Genre suggestion approved", action: "contributed genre updates to" },
};

export function suggestionActivityLabels(activity) {
  if (activity.type !== "suggestion_approved") return null;
  return approvalLabels[activity.publicationType] || approvalLabels.catalog_linked;
}
