import { useId, useMemo, useState } from "react";
import {
  RELEASE_TYPE_OPTIONS,
  SOURCE_TYPE_OPTIONS,
  formatCommunityValue,
} from "../../features/community/community.js";
import { clearDraft, readDraft, useDraftAutosave } from "../../features/community/drafts.js";
import DraftNotice from "./DraftNotice";
import {
  MAX_CREDIT_ROWS,
  creditRow,
  creditRowProblems,
  creditRowsFromCredits,
  creditRowsFromDraft,
  creditRowsSnapshot,
  creditsFromRows,
  creditIdentity,
  musicBrainzArtistUrl,
} from "../../features/community/artistCredits.js";
import { ArtistPicker } from "../../features/artists/ArtistPicker.jsx";
import { artistRequestFields, linksFromSubmission } from "../../features/artists/artistLinkPayload.js";
import { useArtistLinkingState } from "../../features/artists/useArtistLinking";

const FIELD_ORDER = ["title", "artists", "artistLinks", "releaseType", "releaseDate", "label", "cover", "tracks", "externalReferences"];
const FIELD_VALUE_KEYS = {
  title: ["title"],
  artists: ["artistDisplayName", "artistCredits"],
  artistLinks: ["artistLinks"],
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

const MAX_ARTIST_LINKS = 20;

// Identity-only links for the album's stored credits, one entry per credit
// position (null when unlinked). A revision restores its stored links,
// keeping explicit shared proposal keys.
function initialArtistLinks(initialValue) {
  const credits = targetAlbumFrom(initialValue).artistCredits || [];
  const stored = initialValue?.proposedChanges?.artistLinks;
  if (!stored) return credits.map(() => null);
  return linksFromSubmission({ proposedMetadata: { artistCredits: credits }, artistProposals: stored.artistProposals, artistSelections: stored.artistSelections });
}

function currentValues(initialValue) {
  const album = targetAlbumFrom(initialValue);
  const existingChanges = initialValue?.proposedChanges || {};
  const proposedCredits = existingChanges.artists?.artistCredits;
  const startingCredits = Array.isArray(proposedCredits) && proposedCredits.length
    ? proposedCredits
    : album.artistCredits?.length ? album.artistCredits : [{ name: album.artistDisplayName || "", role: "main" }];
  return {
    title: existingChanges.title ?? album.title ?? "",
    artistDisplayName: existingChanges.artists?.artistDisplayName ?? album.artistDisplayName ?? "",
    // One structured row per credit; names are never joined into text.
    artistCredits: creditRowsFromCredits(startingCredits),
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
    artistLinks: initialArtistLinks(initialValue),
  };
}

function initialFields(initialValue) {
  const existing = initialValue?.proposedChanges;
  return new Set(existing ? Object.keys(existing) : []);
}

function initialSource(initialValue) {
  return initialValue?.supportingSources?.[0] || DEFAULT_SOURCE;
}

// An old comma-joined credits draft that only repeats the current names holds no edits.
function isUnchangedCreditText(text, rows) {
  return typeof text === "string" && text.trim() === rows.map((row) => row.name).join(", ");
}

// A stored draft restores only the field groups it selected; everything else
// comes from the album as it is now.
function restoredState(initialValue, stored) {
  const values = currentValues(initialValue);
  if (!stored || typeof stored !== "object") {
    return { enabledFields: initialFields(initialValue), values, source: initialSource(initialValue), creditsNotRestored: false };
  }
  let creditsNotRestored = false;
  const fields = (Array.isArray(stored.enabledFields) ? stored.enabledFields : []).filter((field) => FIELD_ORDER.includes(field));
  for (const field of fields) {
    for (const key of FIELD_VALUE_KEYS[field]) {
      if (key === "artistLinks") {
        // Positions only make sense for the same credit list.
        const storedLinks = stored.values?.artistLinks;
        if (Array.isArray(storedLinks) && storedLinks.length === values.artistLinks.length) {
          values.artistLinks = storedLinks.map((link) => (link && typeof link === "object" ? link : null));
        }
      } else if (key === "artistCredits") {
        const storedCredits = stored.values?.artistCredits;
        const restoredCredits = creditRowsFromDraft(storedCredits);
        if (restoredCredits) {
          values.artistCredits = restoredCredits;
        } else if (storedCredits !== undefined && !isUnchangedCreditText(storedCredits, values.artistCredits)) {
          // An older draft stored the credits as one comma-joined string, which
          // cannot be split reliably. The form says so instead of dropping edits silently.
          creditsNotRestored = true;
        }
      } else if (typeof stored.values?.[key] === "string") {
        values[key] = stored.values[key];
      }
    }
  }
  const source = stored.source && typeof stored.source === "object" ? stored.source : {};
  return {
    enabledFields: new Set(fields),
    values,
    creditsNotRestored,
    source: {
      type: typeof source.type === "string" && source.type ? source.type : DEFAULT_SOURCE.type,
      url: typeof source.url === "string" ? source.url : "",
      description: typeof source.description === "string" ? source.description : "",
    },
  };
}

function draftSnapshot(enabledFields, values, source) {
  const fields = FIELD_ORDER.filter((field) => enabledFields.has(field));
  // Credit rows are stored without their per-load keys, so keys never count as edits.
  const selectedValues = Object.fromEntries(fields.flatMap((field) => FIELD_VALUE_KEYS[field].map((key) => [
    key,
    key === "artistCredits" ? creditRowsSnapshot(values[key]) : values[key],
  ])));
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
  getToken,
}) {
  const [storedDraft] = useState(() => readDraft(draftKey));
  const [initialState] = useState(() => restoredState(initialValue, storedDraft?.value));
  const [restoredAt, setRestoredAt] = useState(storedDraft?.savedAt || null);
  const [creditsNotRestored, setCreditsNotRestored] = useState(initialState.creditsNotRestored);
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
  const linkingState = useArtistLinkingState(getToken);
  // Links stored on the correction being revised. Like album suggestions,
  // they are never dropped implicitly while linking is unknown or off.
  const hasStoredLinks = Boolean(initialValue?.proposedChanges?.artistLinks?.artistSelections?.length);
  const albumCredits = Array.isArray(album.artistCredits) ? album.artistCredits : [];

  function updateValue(key, value) {
    setValues((current) => ({ ...current, [key]: value }));
    setClientError("");
  }

  function updateCredit(key, field, value) {
    setValues((current) => ({
      ...current,
      artistCredits: current.artistCredits.map((credit) => (credit.key === key ? { ...credit, [field]: value } : credit)),
    }));
    setClientError("");
  }

  function addCredit() {
    setValues((current) => (current.artistCredits.length >= MAX_CREDIT_ROWS
      ? current
      : { ...current, artistCredits: [...current.artistCredits, creditRow()] }));
    setClientError("");
  }

  function removeCredit(key) {
    setValues((current) => (current.artistCredits.length <= 1
      ? current
      : { ...current, artistCredits: current.artistCredits.filter((credit) => credit.key !== key) }));
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

  function updateArtistLink(position, link) {
    setValues((current) => ({
      ...current,
      artistLinks: current.artistLinks.map((entry, index) => (index === position ? link : entry)),
    }));
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
    setCreditsNotRestored(false);
  }

  function submit(event) {
    event.preventDefault();
    setClientError("");
    const proposedChanges = {};

    if (enabledFields.has("title")) proposedChanges.title = values.title;
    if (enabledFields.has("artists")) {
      const problems = creditRowProblems(values.artistCredits);
      if (problems.length) {
        setClientError(problems.join(" "));
        return;
      }
      proposedChanges.artists = {
        artistDisplayName: values.artistDisplayName,
        // Each row is submitted as its own credit, in order. A row keeps its
        // role and artist identity while its name is unchanged.
        artistCredits: creditsFromRows(values.artistCredits),
      };
    }
    if (enabledFields.has("artistLinks") || hasStoredLinks) {
      // Links go only after the server confirms linking is on; otherwise
      // the form refuses rather than dropping them.
      if (linkingState !== "enabled") {
        setClientError(hasStoredLinks && linkingState === "disabled"
          ? "This correction has artist links, and artist linking is turned off right now. Revise it when linking is back on, or withdraw it."
          : linkingState === "loading"
            ? "Still checking whether artist linking is available. Try again in a moment so your artist links are kept."
            : linkingState === "unavailable"
              ? "Could not check whether artist linking is available, so your artist links cannot be sent. Reload the page to try again."
              : "Artist linking is turned off right now. Deselect Artist links to send the other corrections without them.");
        return;
      }
    }
    if (enabledFields.has("artistLinks")) {
      const fields = artistRequestFields(values.artistLinks);
      if (!fields.artistSelections?.length) {
        setClientError("Choose an artist for at least one credit, or deselect Artist links.");
        return;
      }
      if (fields.artistSelections.length > MAX_ARTIST_LINKS) {
        setClientError(`A correction can link at most ${MAX_ARTIST_LINKS} credits. Send the rest in another correction.`);
        return;
      }
      proposedChanges.artistLinks = fields;
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
      <DraftNotice
        savedAt={restoredAt}
        onDiscard={discardDraft}
        disabled={isSubmitting}
        note={creditsNotRestored ? "Your artist credit edits in that draft could not be restored, so the credits shown are the current ones. Re-enter any changes you still want." : ""}
      />
      <fieldset className="correction-fieldset">
        <legend>Choose the catalog fields to correct</legend>
        <p className="correction-help">Each selected group is reviewed independently. Unselected fields remain exactly as they are.</p>
        {FIELD_ORDER.filter((field) => field !== "artistLinks" || linkingState === "enabled" || enabledFields.has("artistLinks")).map((field) => {
          // Replacing the credits and adding links to them cannot be combined.
          const blocked = (field === "artists" && enabledFields.has("artistLinks")) || (field === "artistLinks" && enabledFields.has("artists"));
          return (
            <label className="correction-field-toggle" key={field}>
              <input checked={enabledFields.has(field)} disabled={blocked && !enabledFields.has(field)} onChange={() => toggleField(field)} type="checkbox" />
              <span>{formatCommunityValue(field)}{blocked && !enabledFields.has(field) ? " (not with the other artist group)" : ""}</span>
            </label>
          );
        })}
      </fieldset>

      {enabledFields.has("title") ? (
        <div className="community-field">
          <label htmlFor={`${fieldPrefix}-title`}>Corrected title</label>
          <input id={`${fieldPrefix}-title`} onChange={(event) => updateValue("title", event.target.value)} value={values.title} />
        </div>
      ) : null}
      {enabledFields.has("artists") ? (
        <fieldset className="correction-fieldset correction-credits">
          <legend>Artist credits</legend>
          <div className="community-field">
            <label htmlFor={`${fieldPrefix}-artist`}>Artist display name</label>
            <input id={`${fieldPrefix}-artist`} onChange={(event) => updateValue("artistDisplayName", event.target.value)} value={values.artistDisplayName} />
          </div>
          {values.artistCredits.length > MAX_CREDIT_ROWS ? (
            <p className="community-message community-message-error" role="status">
              This album has {values.artistCredits.length} artist credits. A correction can carry at most {MAX_CREDIT_ROWS}, and every credit is kept here until you remove it. Deselect Artists to correct other fields without changing credits.
            </p>
          ) : null}
          <p className="correction-help">One row per credited artist, so a name with a comma stays a single credit. Changing a name removes its link to an artist.</p>
          <div className="suggestion-form-repeater">
            {values.artistCredits.map((credit, index) => {
              const linked = credit.identity && credit.identity.name === credit.name.trim() ? credit.identity : null;
              return (
                <div className="suggestion-form-repeater-row" key={credit.key}>
                  <p className="suggestion-form-row-number">Artist {String(index + 1).padStart(2, "0")}</p>
                  <div className="community-field">
                    <label htmlFor={`${fieldPrefix}-${credit.key}-name`}>Name</label>
                    <input
                      aria-label={`Artist ${index + 1} name`}
                      id={`${fieldPrefix}-${credit.key}-name`}
                      maxLength={200}
                      onChange={(event) => updateCredit(credit.key, "name", event.target.value)}
                      value={credit.name}
                    />
                    {linked ? (
                      <small>
                        {musicBrainzArtistUrl(linked)
                          ? <>Linked to a <a href={musicBrainzArtistUrl(linked)} target="_blank" rel="noreferrer">MusicBrainz artist</a>.</>
                          : "Linked to a Rescened artist."}
                      </small>
                    ) : null}
                  </div>
                  <div className="community-field">
                    <label htmlFor={`${fieldPrefix}-${credit.key}-role`}>Role</label>
                    <input
                      aria-label={`Artist ${index + 1} role`}
                      id={`${fieldPrefix}-${credit.key}-role`}
                      maxLength={80}
                      onChange={(event) => updateCredit(credit.key, "role", event.target.value)}
                      value={credit.role}
                    />
                  </div>
                  <button
                    aria-label={`Remove artist ${index + 1}`}
                    className="suggestion-form-remove"
                    disabled={values.artistCredits.length === 1}
                    onClick={() => removeCredit(credit.key)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
          <button
            className="suggestion-form-add"
            disabled={values.artistCredits.length >= MAX_CREDIT_ROWS}
            onClick={addCredit}
            type="button"
          >
            + Add artist credit
          </button>
        </fieldset>
      ) : null}
      {enabledFields.has("artistLinks") ? (
        <fieldset className="correction-fieldset correction-artist-links">
          <legend>Artist links</legend>
          <p className="correction-help">
            Link credits to the artists they name. Credit wording, roles, and order stay exactly as they are; only the link is added.
            Up to {MAX_ARTIST_LINKS} links per correction.
          </p>
          {linkingState !== "enabled" ? (
            <p className="community-message community-message-error" role="status">
              {linkingState === "loading"
                ? "Checking whether artist linking is available. Your links are kept."
                : linkingState === "unavailable"
                  ? "Artist linking could not be checked, so these links cannot be sent until you reload."
                  : hasStoredLinks
                    ? "Artist linking is turned off right now. These links are kept, and the correction can be revised when linking is back on."
                    : "Artist linking is turned off right now. Deselect Artist links to send the other corrections."}
            </p>
          ) : null}
          <div className="suggestion-form-repeater">
            {albumCredits.map((credit, index) => {
              const identity = creditIdentity(credit);
              return (
                <div className="suggestion-form-repeater-row correction-artist-link-row" key={`link-${index}`}>
                  <p className="suggestion-form-row-number">Artist {String(index + 1).padStart(2, "0")}</p>
                  <p className="correction-artist-link-credit">
                    <strong>{credit.name}</strong>
                    {credit.role ? <span> · {credit.role}</span> : null}
                  </p>
                  {identity ? (
                    <small className="suggestion-form-artist-link">Already linked to an artist.</small>
                  ) : linkingState === "enabled" ? (
                    <div className="suggestion-form-artist-link">
                      <ArtistPicker
                        key={`picker-${index}`}
                        label={`Artist ${String(index + 1).padStart(2, "0")}`}
                        creditName={credit.name}
                        value={values.artistLinks[index] || null}
                        onChange={(link) => updateArtistLink(index, link)}
                        disabled={isSubmitting}
                      />
                    </div>
                  ) : values.artistLinks[index] ? (
                    <small className="suggestion-form-artist-link">Link kept: {values.artistLinks[index].name || values.artistLinks[index].canonicalName}</small>
                  ) : null}
                </div>
              );
            })}
          </div>
        </fieldset>
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
