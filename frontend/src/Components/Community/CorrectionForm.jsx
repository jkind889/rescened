import { useId, useMemo, useState } from "react";
import {
  RELEASE_TYPE_OPTIONS,
  SOURCE_TYPE_OPTIONS,
  formatCommunityValue,
} from "../../features/community/community.js";
import { clearDraft, readDraft, useDraftAutosave } from "../../features/community/drafts.js";
import DraftNotice from "./DraftNotice";

const FIELD_ORDER = ["title", "artists", "releaseType", "releaseDate", "label", "cover", "tracks", "externalReferences"];
const FIELD_VALUE_KEYS = {
  title: ["title"],
  artists: ["artistDisplayName", "artistCredits"],
  releaseType: ["releaseType"],
  releaseDate: ["releaseDate", "releaseYear"],
  label: ["label"],
  cover: ["cover"],
  tracks: ["tracks"],
  externalReferences: ["referenceProvider", "referenceEntityType", "referenceExternalId", "referenceUrl"],
};
const DEFAULT_SOURCE = { type: "musicbrainz", url: "", description: "" };

function targetAlbumFrom(initialValue) {
  return initialValue?.targetAlbum || {};
}

function currentValues(initialValue) {
  const album = targetAlbumFrom(initialValue);
  const existingChanges = initialValue?.proposedChanges || {};
  const artistCredits = album.artistCredits?.length ? album.artistCredits : [{ name: album.artistDisplayName || "", role: "main" }];
  return {
    title: existingChanges.title ?? album.title ?? "",
    artistDisplayName: existingChanges.artists?.artistDisplayName ?? album.artistDisplayName ?? "",
    artistCredits: existingChanges.artists?.artistCredits?.map((credit) => credit.name).join(", ")
      ?? artistCredits.map((credit) => credit.name).join(", "),
    releaseType: existingChanges.releaseType ?? album.releaseType ?? "album",
    releaseDate: existingChanges.releaseDate?.releaseDate ?? album.releaseDate ?? "",
    releaseYear: existingChanges.releaseDate?.releaseYear ?? album.releaseYear ?? "",
    label: existingChanges.label ?? album.label ?? "",
    cover: existingChanges.cover ?? album.cover ?? "",
    tracks: JSON.stringify(existingChanges.tracks ?? album.tracks ?? [], null, 2),
    referenceProvider: existingChanges.externalReferences?.add?.[0]?.provider ?? "musicbrainz",
    referenceEntityType: existingChanges.externalReferences?.add?.[0]?.entityType ?? "release-group",
    referenceExternalId: existingChanges.externalReferences?.add?.[0]?.externalId ?? "",
    referenceUrl: existingChanges.externalReferences?.add?.[0]?.url ?? "",
  };
}

function initialFields(initialValue) {
  const existing = initialValue?.proposedChanges;
  return new Set(existing ? Object.keys(existing) : []);
}

function initialSource(initialValue) {
  return initialValue?.supportingSources?.[0] || DEFAULT_SOURCE;
}

// A stored draft restores only the field groups it selected; everything else
// comes from the album as it is now.
function restoredState(initialValue, stored) {
  const values = currentValues(initialValue);
  if (!stored || typeof stored !== "object") {
    return { enabledFields: initialFields(initialValue), values, source: initialSource(initialValue) };
  }
  const fields = (Array.isArray(stored.enabledFields) ? stored.enabledFields : []).filter((field) => FIELD_ORDER.includes(field));
  for (const field of fields) {
    for (const key of FIELD_VALUE_KEYS[field]) {
      if (typeof stored.values?.[key] === "string") values[key] = stored.values[key];
    }
  }
  const source = stored.source && typeof stored.source === "object" ? stored.source : {};
  return {
    enabledFields: new Set(fields),
    values,
    source: {
      type: typeof source.type === "string" && source.type ? source.type : DEFAULT_SOURCE.type,
      url: typeof source.url === "string" ? source.url : "",
      description: typeof source.description === "string" ? source.description : "",
    },
  };
}

function draftSnapshot(enabledFields, values, source) {
  const fields = FIELD_ORDER.filter((field) => enabledFields.has(field));
  const selectedValues = Object.fromEntries(fields.flatMap((field) => FIELD_VALUE_KEYS[field].map((key) => [key, values[key]])));
  return { enabledFields: fields, values: selectedValues, source };
}

function precisionForDate(date) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return "day";
  if (/^\d{4}-\d{2}$/.test(date)) return "month";
  return "year";
}

export function CorrectionForm({
  initialValue,
  onSubmit,
  submitLabel = "Send correction for review",
  submittingLabel = "Sending correction…",
  isSubmitting = false,
  error = null,
  formId = "community-correction-form",
  draftKey = "",
}) {
  const [storedDraft] = useState(() => readDraft(draftKey));
  const [initialState] = useState(() => restoredState(initialValue, storedDraft?.value));
  const [restoredAt, setRestoredAt] = useState(storedDraft?.savedAt || null);
  const [enabledFields, setEnabledFields] = useState(initialState.enabledFields);
  const [values, setValues] = useState(initialState.values);
  const [source, setSource] = useState(initialState.source);
  const snapshot = useMemo(() => draftSnapshot(enabledFields, values, source), [enabledFields, values, source]);
  const initialFingerprint = useMemo(() => {
    const start = restoredState(initialValue, null);
    return JSON.stringify(draftSnapshot(start.enabledFields, start.values, start.source));
  }, [initialValue]);
  useDraftAutosave(draftKey, snapshot, JSON.stringify(snapshot) === initialFingerprint);
  const [clientError, setClientError] = useState("");
  const fieldPrefix = useId();
  const album = targetAlbumFrom(initialValue);
  const isRevision = Boolean(initialValue?.submissionId);

  function updateValue(key, value) {
    setValues((current) => ({ ...current, [key]: value }));
    setClientError("");
  }

  function toggleField(field) {
    setEnabledFields((current) => {
      const next = new Set(current);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
    setClientError("");
  }

  function discardDraft() {
    const start = restoredState(initialValue, null);
    clearDraft(draftKey);
    setEnabledFields(start.enabledFields);
    setValues(start.values);
    setSource(start.source);
    setClientError("");
    setRestoredAt(null);
  }

  function submit(event) {
    event.preventDefault();
    setClientError("");
    const proposedChanges = {};

    if (enabledFields.has("title")) proposedChanges.title = values.title;
    if (enabledFields.has("artists")) {
      proposedChanges.artists = {
        artistDisplayName: values.artistDisplayName,
        artistCredits: values.artistCredits.split(",").map((name) => ({ name: name.trim(), role: "main" })).filter((credit) => credit.name),
      };
    }
    if (enabledFields.has("releaseType")) proposedChanges.releaseType = values.releaseType;
    if (enabledFields.has("releaseDate")) {
      proposedChanges.releaseDate = {
        releaseDate: values.releaseDate,
        releaseDatePrecision: precisionForDate(values.releaseDate),
        releaseYear: Number(values.releaseYear || String(values.releaseDate).slice(0, 4)),
      };
    }
    if (enabledFields.has("label")) proposedChanges.label = values.label;
    if (enabledFields.has("cover")) proposedChanges.cover = values.cover;
    if (enabledFields.has("tracks")) {
      try {
        proposedChanges.tracks = JSON.parse(values.tracks);
      } catch {
        setClientError("Tracks must be valid JSON before they can be submitted.");
        return;
      }
    }
    if (enabledFields.has("externalReferences")) {
      proposedChanges.externalReferences = {
        add: [{
          provider: values.referenceProvider,
          entityType: values.referenceEntityType,
          externalId: values.referenceExternalId,
          url: values.referenceUrl,
        }],
      };
    }

    if (!Object.keys(proposedChanges).length) {
      setClientError("Select at least one field group to correct.");
      return;
    }
    if (!source.url.trim()) {
      setClientError("Add one HTTPS supporting source for the correction.");
      return;
    }

    onSubmit({
      ...(isRevision ? {} : { albumId: initialValue?.targetAlbumId || album.albumId }),
      proposedChanges,
      supportingSources: [{ ...source, url: source.url.trim() }],
    });
  }

  return (
    <form className="community-form correction-form" id={formId} onSubmit={submit} noValidate>
      <DraftNotice savedAt={restoredAt} onDiscard={discardDraft} disabled={isSubmitting} />
      <fieldset className="correction-fieldset">
        <legend>Choose the catalog fields to correct</legend>
        <p className="correction-help">Each selected group is reviewed independently. Unselected fields remain exactly as they are.</p>
        {FIELD_ORDER.map((field) => (
          <label className="correction-field-toggle" key={field}>
            <input checked={enabledFields.has(field)} onChange={() => toggleField(field)} type="checkbox" />
            <span>{formatCommunityValue(field)}</span>
          </label>
        ))}
      </fieldset>

      {enabledFields.has("title") ? (
        <div className="community-field">
          <label htmlFor={`${fieldPrefix}-title`}>Corrected title</label>
          <input id={`${fieldPrefix}-title`} onChange={(event) => updateValue("title", event.target.value)} value={values.title} />
        </div>
      ) : null}
      {enabledFields.has("artists") ? (
        <div className="correction-grid">
          <div className="community-field">
            <label htmlFor={`${fieldPrefix}-artist`}>Artist display name</label>
            <input id={`${fieldPrefix}-artist`} onChange={(event) => updateValue("artistDisplayName", event.target.value)} value={values.artistDisplayName} />
          </div>
          <div className="community-field">
            <label htmlFor={`${fieldPrefix}-credits`}>Artist credits</label>
            <input id={`${fieldPrefix}-credits`} onChange={(event) => updateValue("artistCredits", event.target.value)} value={values.artistCredits} />
            <small>Separate multiple credits with commas.</small>
          </div>
        </div>
      ) : null}
      {enabledFields.has("releaseType") ? (
        <div className="community-field">
          <label htmlFor={`${fieldPrefix}-type`}>Release type</label>
          <select id={`${fieldPrefix}-type`} onChange={(event) => updateValue("releaseType", event.target.value)} value={values.releaseType}>
            {RELEASE_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      ) : null}
      {enabledFields.has("releaseDate") ? (
        <div className="correction-grid">
          <div className="community-field">
            <label htmlFor={`${fieldPrefix}-date`}>Release date</label>
            <input id={`${fieldPrefix}-date`} maxLength={10} onChange={(event) => updateValue("releaseDate", event.target.value)} placeholder="YYYY-MM-DD" value={values.releaseDate} />
          </div>
          <div className="community-field">
            <label htmlFor={`${fieldPrefix}-year`}>Release year</label>
            <input id={`${fieldPrefix}-year`} inputMode="numeric" onChange={(event) => updateValue("releaseYear", event.target.value)} value={values.releaseYear} />
          </div>
        </div>
      ) : null}
      {enabledFields.has("label") ? (
        <div className="community-field">
          <label htmlFor={`${fieldPrefix}-label`}>Label <span>blank clears the label</span></label>
          <input id={`${fieldPrefix}-label`} onChange={(event) => updateValue("label", event.target.value)} value={values.label} />
        </div>
      ) : null}
      {enabledFields.has("cover") ? (
        <div className="community-field">
          <label htmlFor={`${fieldPrefix}-cover`}>Reviewed cover URL</label>
          <input id={`${fieldPrefix}-cover`} onChange={(event) => updateValue("cover", event.target.value)} placeholder="https://…" value={values.cover} />
          <small>The server never fetches this URL.</small>
        </div>
      ) : null}
      {enabledFields.has("tracks") ? (
        <div className="community-field">
          <label htmlFor={`${fieldPrefix}-tracks`}>Complete track list JSON</label>
          <textarea id={`${fieldPrefix}-tracks`} onChange={(event) => updateValue("tracks", event.target.value)} rows={8} value={values.tracks} />
          <small>Existing track IDs are preserved; new tracks receive server-generated IDs.</small>
        </div>
      ) : null}
      {enabledFields.has("externalReferences") ? (
        <div className="correction-grid correction-reference-grid">
          <div className="community-field">
            <label htmlFor={`${fieldPrefix}-provider`}>Provider</label>
            <input id={`${fieldPrefix}-provider`} onChange={(event) => updateValue("referenceProvider", event.target.value)} value={values.referenceProvider} />
          </div>
          <div className="community-field">
            <label htmlFor={`${fieldPrefix}-entity`}>Entity type</label>
            <input id={`${fieldPrefix}-entity`} onChange={(event) => updateValue("referenceEntityType", event.target.value)} value={values.referenceEntityType} />
          </div>
          <div className="community-field">
            <label htmlFor={`${fieldPrefix}-external-id`}>External ID</label>
            <input id={`${fieldPrefix}-external-id`} onChange={(event) => updateValue("referenceExternalId", event.target.value)} value={values.referenceExternalId} />
          </div>
          <div className="community-field">
            <label htmlFor={`${fieldPrefix}-reference-url`}>Record URL <span>optional</span></label>
            <input id={`${fieldPrefix}-reference-url`} onChange={(event) => updateValue("referenceUrl", event.target.value)} value={values.referenceUrl} />
          </div>
        </div>
      ) : null}

      <fieldset className="correction-fieldset correction-evidence-fieldset">
        <legend>Supporting evidence</legend>
        <div className="correction-grid">
          <div className="community-field">
            <label htmlFor={`${fieldPrefix}-source-type`}>Source type</label>
            <select id={`${fieldPrefix}-source-type`} onChange={(event) => setSource((current) => ({ ...current, type: event.target.value }))} value={source.type}>
              {SOURCE_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div className="community-field">
            <label htmlFor={`${fieldPrefix}-source-url`}>HTTPS source URL</label>
            <input id={`${fieldPrefix}-source-url`} onChange={(event) => setSource((current) => ({ ...current, url: event.target.value }))} value={source.url} />
          </div>
        </div>
        <div className="community-field">
          <label htmlFor={`${fieldPrefix}-source-description`}>Evidence note <span>optional</span></label>
          <input id={`${fieldPrefix}-source-description`} onChange={(event) => setSource((current) => ({ ...current, description: event.target.value }))} value={source.description || ""} />
        </div>
      </fieldset>

      {clientError ? <p className="community-message community-message-error" role="alert">{clientError}</p> : null}
      {error ? <p className="community-message community-message-error" role="alert">{error.message || "The correction could not be submitted."}</p> : null}
      <button className="community-primary-button" disabled={isSubmitting} type="submit">
        {isSubmitting ? submittingLabel : submitLabel}
      </button>
    </form>
  );
}

export default CorrectionForm;
