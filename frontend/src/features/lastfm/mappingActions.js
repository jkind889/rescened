const ACTIONS = {
  approve: "Approve mapping",
  reject: "Reject case",
  "no-catalog-match": "No catalog match",
  refresh: "Request refreshed evidence",
  reconfirm: "Reconfirm mapping",
  revoke: "Revoke mapping",
};

export function mappingActions(detail) {
  const status = detail?.case?.status;
  const active = detail?.mapping?.status === "active";
  let values = [];
  if (status === "approved") {
    const revision = detail.mapping?.currentCatalogRevision;
    if (active && detail.mapping.stale && Number.isSafeInteger(revision) && revision > 0) values.push("reconfirm");
    values.push("refresh");
    if (active) values.push("revoke");
  } else if (["pending", "rejected", "no_catalog_match"].includes(status)) {
    values = ["approve", "reject", "no-catalog-match", "refresh"];
    if (active) values.push("revoke");
  }
  return values.map((value) => ({ value, label: ACTIONS[value] }));
}
