function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function EditedTag({ editedAt, className = "review-edited-tag" }) {
  if (!editedAt) return null;
  return <span className={className} title={`Edited ${formatDate(editedAt)}`}>edited</span>;
}
