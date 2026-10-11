import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  RELEASE_TYPE_OPTIONS,
  SOURCE_TYPE_OPTIONS,
} from "../../features/community/community";
import { clearDraft, readDraft, useDraftAutosave } from "../../features/community/drafts.js";
import DraftNotice from "./DraftNotice";

const MAX_ARTISTS = 20;
const MAX_SOURCES = 10;
const MAX_REFERENCES = 20;
const MAX_TRACKS = 200;
const RELEASE_TYPES = new Set(RELEASE_TYPE_OPTIONS.map((option) => option.value));
const SOURCE_TYPES = new Set(SOURCE_TYPE_OPTIONS.map((option) => option.value));

let fallbackKey = 0;

function rowKey(prefix) {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }

  fallbackKey += 1;
  return `${prefix}-${fallbackKey}`;
}

function stringValue(value, fallback = "") {
  return value === undefined || value === null ? fallback : String(value);
}

function artistRow(value = {}) {
  return {
    key: rowKey("artist"),
    name: stringValue(value.name),
    role: stringValue(value.role, "main") || "main",
  };
}

function sourceRow(value = {}) {
  return {
    key: rowKey("source"),
    type: stringValue(value.type, "musicbrainz") || "musicbrainz",
    url: stringValue(value.url),
    description: stringValue(value.description),
  };
}

function referenceRow(value = {}) {
  return {
    key: rowKey("reference"),
    provider: stringValue(value.provider),
    entityType: stringValue(value.entityType),
    externalId: stringValue(value.externalId),
    url: stringValue(value.url),
  };
}

function trackRow(value = {}, index = 0) {
  return {
    key: rowKey("track"),
    discNumber: stringValue(value.discNumber, "1") || "1",
    trackNumber: stringValue(value.trackNumber, String(index + 1)) || String(index + 1),
    title: stringValue(value.title),
    durationMs: stringValue(value.durationMs, "0") || "0",
    artistDisplayName: stringValue(value.artistDisplayName),
  };
}

function createDraft(initialValue) {
  const source = initialValue?.suggestion || initialValue || {};
  const metadata = source.proposedMetadata || {};
  const artists = Array.isArray(metadata.artistCredits) && metadata.artistCredits.length
    ? metadata.artistCredits.map(artistRow)
    : [artistRow()];
  const sources = Array.isArray(source.supportingSources) && source.supportingSources.length
    ? source.supportingSources.map(sourceRow)
    : [sourceRow()];
  const references = Array.isArray(source.externalReferences)
    ? source.externalReferences.map(referenceRow)
    : [];
  const tracks = Array.isArray(metadata.tracks)
    ? metadata.tracks.map(trackRow)
    : [];

  return {
    proposedMetadata: {
      title: stringValue(metadata.title),
      artistDisplayName: stringValue(metadata.artistDisplayName),
      artistCredits: artists,
      releaseType: stringValue(metadata.releaseType, "album") || "album",
      releaseDate: stringValue(metadata.releaseDate),
      releaseYear: stringValue(metadata.releaseYear),
      label: stringValue(metadata.label),
      country: stringValue(metadata.country),
      catalogNumber: stringValue(metadata.catalogNumber),
      barcode: stringValue(metadata.barcode),
      coverSourceUrl: stringValue(metadata.coverSourceUrl),
      tracks,
    },
    supportingSources: sources,
    externalReferences: references,
  };
}

// Row keys are regenerated on every load, so they never count as edits.
function draftFingerprint(draft) {
  return JSON.stringify(draft, (field, value) => (field === "key" ? undefined : value));
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function dateParts(value) {
  if (!/^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(value)) {
    return null;
  }

  const year = Number(value.slice(0, 4));
  const precision = value.length === 4 ? "year" : value.length === 7 ? "month" : "day";

  if (year < 1 || year > 9999) {
    return null;
  }

  if (precision !== "year") {
    const month = Number(value.slice(5, 7));
    if (month < 1 || month > 12) {
      return null;
    }
  }

  if (precision === "day") {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())
      || parsed.getUTCFullYear() !== year
      || parsed.getUTCMonth() + 1 !== Number(value.slice(5, 7))
      || parsed.getUTCDate() !== Number(value.slice(8, 10))) {
      return null;
    }
  }

  return { year, precision };
}

function integerInRange(value, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum;
}

function validateDraft(draft) {
  const errors = [];
  const metadata = draft.proposedMetadata;
  const title = metadata.title.trim();
  const releaseDate = metadata.releaseDate.trim();
  const releaseYear = metadata.releaseYear.trim();
  const parsedDate = releaseDate ? dateParts(releaseDate) : null;

  if (!title) errors.push("Enter the release title.");
  if (title.length > 200) errors.push("Release title must be 200 characters or fewer.");
  if (!metadata.artistCredits.length) errors.push("Add at least one artist credit.");
  metadata.artistCredits.forEach((artist, index) => {
    if (!artist.name.trim()) errors.push(`Artist ${index + 1} needs a name.`);
    if (artist.name.trim().length > 200) errors.push(`Artist ${index + 1} name must be 200 characters or fewer.`);
    if (artist.role.trim().length > 80) errors.push(`Artist ${index + 1} role must be 80 characters or fewer.`);
  });
  if (!RELEASE_TYPES.has(metadata.releaseType)) errors.push("Choose a valid release type.");
  if (!releaseDate && !releaseYear) errors.push("Enter a release date or release year.");
  if (releaseDate && !parsedDate) errors.push("Release date must be a valid YYYY, YYYY-MM, or YYYY-MM-DD value.");
  if (releaseYear && !integerInRange(releaseYear, 1, 9999)) errors.push("Release year must be an integer from 1 to 9999.");
  if (parsedDate && releaseYear && parsedDate.year !== Number(releaseYear)) errors.push("Release year must match the release date.");
  if (metadata.artistDisplayName.trim().length > 300) errors.push("Artist display name must be 300 characters or fewer.");
  if (metadata.label.trim().length > 200) errors.push("Label must be 200 characters or fewer.");
  if (metadata.country.trim().length > 100) errors.push("Country must be 100 characters or fewer.");
  if (metadata.catalogNumber.trim().length > 100) errors.push("Catalog number must be 100 characters or fewer.");
  if (metadata.barcode.trim() && !/^\d{8,14}$/.test(metadata.barcode.replace(/[\s-]/g, ""))) {
    errors.push("Barcode must contain 8 to 14 digits.");
  }
  if (metadata.coverSourceUrl.trim() && !isHttpsUrl(metadata.coverSourceUrl.trim())) {
    errors.push("Direct cover image URL must use HTTPS.");
  }

  if (!draft.supportingSources.length) errors.push("Add at least one supporting source.");
  draft.supportingSources.forEach((source, index) => {
    if (!SOURCE_TYPES.has(source.type)) errors.push(`Source ${index + 1} has an invalid type.`);
    if (!isHttpsUrl(source.url.trim())) errors.push(`Source ${index + 1} needs a valid HTTPS URL.`);
    if (source.description.trim().length > 200) errors.push(`Source ${index + 1} description must be 200 characters or fewer.`);
  });

  const seenReferences = new Set();
  draft.externalReferences.forEach((reference, index) => {
    const provider = reference.provider.trim().toLowerCase();
    const entityType = reference.entityType.trim().toLowerCase();
    const externalId = reference.externalId.trim();
    if (!provider) errors.push(`Reference ${index + 1} needs a provider.`);
    if (provider === "spotify") errors.push(`Reference ${index + 1}: add Spotify as supporting evidence instead.`);
    if (!entityType) errors.push(`Reference ${index + 1} needs an entity type.`);
    if (!externalId) errors.push(`Reference ${index + 1} needs an external ID.`);
    if (provider.length > 50 || entityType.length > 50 || externalId.length > 200) {
      errors.push(`Reference ${index + 1} exceeds an allowed field length.`);
    }
    if (reference.url.trim() && !isHttpsUrl(reference.url.trim())) {
      errors.push(`Reference ${index + 1} URL must use HTTPS.`);
    }
    const identity = `${provider}|${entityType}|${externalId}`;
    if (provider && entityType && externalId && seenReferences.has(identity)) {
      errors.push(`Reference ${index + 1} duplicates another external reference.`);
    }
    seenReferences.add(identity);
  });

  metadata.tracks.forEach((track, index) => {
    if (!track.title.trim()) errors.push(`Track ${index + 1} needs a title.`);
    if (track.title.trim().length > 200) errors.push(`Track ${index + 1} title must be 200 characters or fewer.`);
    if (!integerInRange(track.discNumber, 1, 999)) errors.push(`Track ${index + 1} has an invalid disc number.`);
    if (!integerInRange(track.trackNumber, 1, 999)) errors.push(`Track ${index + 1} has an invalid track number.`);
    if (!integerInRange(track.durationMs, 0, 86400000)) errors.push(`Track ${index + 1} has an invalid duration.`);
    if (track.artistDisplayName.trim().length > 300) errors.push(`Track ${index + 1} artist must be 300 characters or fewer.`);
  });

  return errors;
}

function buildPayload(draft) {
  const metadata = draft.proposedMetadata;
  const releaseDate = metadata.releaseDate.trim();
  const parsedDate = releaseDate ? dateParts(releaseDate) : null;
  const releaseYear = parsedDate?.year || Number(metadata.releaseYear);
  const proposedMetadata = {
    title: metadata.title.trim(),
    artistDisplayName: metadata.artistDisplayName.trim(),
    artistCredits: metadata.artistCredits.map((artist) => ({
      name: artist.name.trim(),
      role: artist.role.trim() || "main",
    })),
    releaseType: metadata.releaseType,
    releaseDate,
    releaseYear,
    label: metadata.label.trim(),
    country: metadata.country.trim(),
    catalogNumber: metadata.catalogNumber.trim(),
    barcode: metadata.barcode.trim(),
    tracks: metadata.tracks.map((track) => ({
      discNumber: Number(track.discNumber),
      trackNumber: Number(track.trackNumber),
      title: track.title.trim(),
      durationMs: Number(track.durationMs),
      artistDisplayName: track.artistDisplayName.trim(),
    })),
    coverSourceUrl: metadata.coverSourceUrl.trim(),
  };

  if (parsedDate) {
    proposedMetadata.releaseDatePrecision = parsedDate.precision;
  }

  return {
    proposedMetadata,
    supportingSources: draft.supportingSources.map((source) => ({
      type: source.type,
      url: source.url.trim(),
      description: source.description.trim(),
    })),
    externalReferences: draft.externalReferences.map((reference) => ({
      provider: reference.provider.trim().toLowerCase(),
      entityType: reference.entityType.trim().toLowerCase(),
      externalId: reference.externalId.trim(),
      url: reference.url.trim(),
    })),
  };
}

function FormError({ error, focusRef = null }) {
  if (!error) {
    return null;
  }

  const message = typeof error === "string" ? error : error.message;
  const code = typeof error === "object" ? error.code : "";
  const details = typeof error === "object" && Array.isArray(error.details) ? error.details : [];
  const retryAfterSeconds = typeof error === "object" ? error.retryAfterSeconds : undefined;

  return (
    <div className="suggestion-form-error" ref={focusRef} role="alert" tabIndex={-1}>
      <p className="suggestion-form-error-title">{message || "The suggestion could not be saved."}</p>
      {code ? <p className="suggestion-form-error-code">Code: {code}</p> : null}
      {details.length ? (
        <ul className="suggestion-form-error-details">
          {details.map((detail, index) => <li key={`${detail}-${index}`}>{detail}</li>)}
        </ul>
      ) : null}
      {retryAfterSeconds ? (
        <p className="suggestion-form-error-retry">Try again in about {retryAfterSeconds} seconds.</p>
      ) : null}
    </div>
  );
}

function SectionHeading({ eyebrow, title, description, count, headingId }) {
  return (
    <div className="suggestion-form-section-heading">
      <div className="suggestion-form-section-copy">
        <p className="suggestion-form-section-eyebrow">{eyebrow}</p>
        <h2 className="suggestion-form-section-title" id={headingId}>{title}</h2>
        {description ? <p className="suggestion-form-section-description">{description}</p> : null}
      </div>
      {count ? <span className="suggestion-form-section-count">{count}</span> : null}
    </div>
  );
}

export function SuggestionForm({
  initialValue = null,
  onSubmit,
  submitLabel = "Send for review",
  submittingLabel = "Sending suggestion…",
  isSubmitting = false,
  error = null,
  disabled = false,
  formId = "community-suggestion-form",
  draftKey = "",
}) {
  const generatedId = useId();
  const [storedDraft] = useState(() => readDraft(draftKey));
  const [restoredAt, setRestoredAt] = useState(storedDraft?.savedAt || null);
  // Stored drafts are normalized through the same path as server records.
  const [draft, setDraft] = useState(() => createDraft(storedDraft?.value || initialValue));
  const initialFingerprint = useMemo(() => draftFingerprint(createDraft(initialValue)), [initialValue]);
  useDraftAutosave(draftKey, draft, draftFingerprint(draft) === initialFingerprint);
  const [validationErrors, setValidationErrors] = useState([]);
  const validationSummaryRef = useRef(null);
  const serverErrorRef = useRef(null);
  const controlsDisabled = disabled || isSubmitting;
  const idPrefix = `${formId}-${generatedId.replace(/:/g, "")}`;

  useEffect(() => {
    if (validationErrors.length) validationSummaryRef.current?.focus();
  }, [validationErrors]);

  useEffect(() => {
    if (error) serverErrorRef.current?.focus();
  }, [error]);

  function updateMetadata(field, value) {
    setDraft((current) => ({
      ...current,
      proposedMetadata: { ...current.proposedMetadata, [field]: value },
    }));
  }

  function updateRow(collection, key, field, value) {
    setDraft((current) => ({
      ...current,
      [collection]: current[collection].map((row) => (
        row.key === key ? { ...row, [field]: value } : row
      )),
    }));
  }

  function updateArtist(key, field, value) {
    setDraft((current) => ({
      ...current,
      proposedMetadata: {
        ...current.proposedMetadata,
        artistCredits: current.proposedMetadata.artistCredits.map((artist) => (
          artist.key === key ? { ...artist, [field]: value } : artist
        )),
      },
    }));
  }

  function updateTrack(key, field, value) {
    setDraft((current) => ({
      ...current,
      proposedMetadata: {
        ...current.proposedMetadata,
        tracks: current.proposedMetadata.tracks.map((track) => (
          track.key === key ? { ...track, [field]: value } : track
        )),
      },
    }));
  }

  function addArtist() {
    setDraft((current) => ({
      ...current,
      proposedMetadata: {
        ...current.proposedMetadata,
        artistCredits: [...current.proposedMetadata.artistCredits, artistRow()],
      },
    }));
  }

  function removeArtist(key) {
    setDraft((current) => ({
      ...current,
      proposedMetadata: {
        ...current.proposedMetadata,
        artistCredits: current.proposedMetadata.artistCredits.filter((artist) => artist.key !== key),
      },
    }));
  }

  function addSource() {
    setDraft((current) => ({ ...current, supportingSources: [...current.supportingSources, sourceRow()] }));
  }

  function addReference() {
    setDraft((current) => ({ ...current, externalReferences: [...current.externalReferences, referenceRow()] }));
  }

  function addTrack() {
    setDraft((current) => {
      const tracks = current.proposedMetadata.tracks;
      return {
        ...current,
        proposedMetadata: {
          ...current.proposedMetadata,
          tracks: [...tracks, trackRow({}, tracks.length)],
        },
      };
    });
  }

  function removeRow(collection, key) {
    setDraft((current) => ({
      ...current,
      [collection]: current[collection].filter((row) => row.key !== key),
    }));
  }

  function removeTrack(key) {
    setDraft((current) => ({
      ...current,
      proposedMetadata: {
        ...current.proposedMetadata,
        tracks: current.proposedMetadata.tracks.filter((track) => track.key !== key),
      },
    }));
  }

  function discardDraft() {
    clearDraft(draftKey);
    setDraft(createDraft(initialValue));
    setValidationErrors([]);
    setRestoredAt(null);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const errors = validateDraft(draft);
    setValidationErrors(errors);

    if (errors.length || controlsDisabled || typeof onSubmit !== "function") {
      return;
    }

    await onSubmit(buildPayload(draft));
  }

  const metadata = draft.proposedMetadata;
  const artistSummary = metadata.artistDisplayName.trim()
    || metadata.artistCredits.map((artist) => artist.name.trim()).filter(Boolean).join(" & ")
    || "No artist entered";
  const releaseTypeSummary = RELEASE_TYPE_OPTIONS.find((option) => option.value === metadata.releaseType)?.label
    || "Release";
  const releaseDateSummary = metadata.releaseDate.trim() || metadata.releaseYear.trim() || "Date not set";

  return (
    <form className="suggestion-form" id={formId} onSubmit={handleSubmit} noValidate>
      <DraftNotice savedAt={restoredAt} onDiscard={discardDraft} disabled={controlsDisabled} />
      {validationErrors.length ? (
        <div className="suggestion-form-validation" ref={validationSummaryRef} role="alert" tabIndex={-1}>
          <p className="suggestion-form-validation-title">Check these fields before continuing:</p>
          <ul className="suggestion-form-validation-list">
            {validationErrors.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}
          </ul>
        </div>
      ) : null}
      <FormError error={error} focusRef={serverErrorRef} />

      <nav className="suggestion-form-progress" aria-label="Suggestion form sections">
        <a href={`#${idPrefix}-release`}><span>01</span> Release</a>
        <a href={`#${idPrefix}-artists`}><span>02</span> Artists</a>
        <a href={`#${idPrefix}-sources`}><span>03</span> Evidence</a>
        <a href={`#${idPrefix}-references`}><span>04</span> IDs</a>
        <a href={`#${idPrefix}-tracks`}><span>05</span> Tracks</a>
      </nav>

      <div className="suggestion-form-layout">
        <fieldset className="suggestion-form-fieldset" disabled={controlsDisabled}>
        <legend className="suggestion-form-legend">Album suggestion</legend>

        <section className="suggestion-form-section" id={`${idPrefix}-release`} aria-labelledby={`${idPrefix}-release-heading`}>
          <SectionHeading
            eyebrow="01 / Release"
            title="Core metadata"
            description="Describe the release as it appears in the most reliable source."
            headingId={`${idPrefix}-release-heading`}
          />
          <div className="suggestion-form-grid">
            <label className="suggestion-form-field suggestion-form-field-wide" htmlFor={`${idPrefix}-title`}>
              <span className="suggestion-form-label">Release title *</span>
              <input
                id={`${idPrefix}-title`}
                className="suggestion-form-input"
                type="text"
                value={metadata.title}
                maxLength={200}
                onChange={(event) => updateMetadata("title", event.target.value)}
                required
              />
            </label>
            <label className="suggestion-form-field" htmlFor={`${idPrefix}-release-type`}>
              <span className="suggestion-form-label">Release type *</span>
              <select
                id={`${idPrefix}-release-type`}
                className="suggestion-form-select"
                value={metadata.releaseType}
                onChange={(event) => updateMetadata("releaseType", event.target.value)}
              >
                {RELEASE_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="suggestion-form-field" htmlFor={`${idPrefix}-release-date`}>
              <span className="suggestion-form-label">Release date</span>
              <input
                id={`${idPrefix}-release-date`}
                className="suggestion-form-input"
                type="text"
                inputMode="numeric"
                value={metadata.releaseDate}
                maxLength={10}
                placeholder="YYYY, YYYY-MM, or YYYY-MM-DD"
                onChange={(event) => updateMetadata("releaseDate", event.target.value)}
              />
            </label>
            <label className="suggestion-form-field" htmlFor={`${idPrefix}-release-year`}>
              <span className="suggestion-form-label">Release year *</span>
              <input
                id={`${idPrefix}-release-year`}
                className="suggestion-form-input"
                type="number"
                inputMode="numeric"
                value={metadata.releaseYear}
                min="1"
                max="9999"
                step="1"
                onChange={(event) => updateMetadata("releaseYear", event.target.value)}
              />
              <span className="suggestion-form-hint">Required only when the date is blank.</span>
            </label>
            <label className="suggestion-form-field" htmlFor={`${idPrefix}-label`}>
              <span className="suggestion-form-label">Label</span>
              <input
                id={`${idPrefix}-label`}
                className="suggestion-form-input"
                type="text"
                value={metadata.label}
                maxLength={200}
                onChange={(event) => updateMetadata("label", event.target.value)}
              />
            </label>
            <label className="suggestion-form-field" htmlFor={`${idPrefix}-country`}>
              <span className="suggestion-form-label">Country</span>
              <input
                id={`${idPrefix}-country`}
                className="suggestion-form-input"
                type="text"
                value={metadata.country}
                maxLength={100}
                placeholder="US"
                onChange={(event) => updateMetadata("country", event.target.value)}
              />
            </label>
            <label className="suggestion-form-field" htmlFor={`${idPrefix}-catalog-number`}>
              <span className="suggestion-form-label">Catalog number</span>
              <input
                id={`${idPrefix}-catalog-number`}
                className="suggestion-form-input"
                type="text"
                value={metadata.catalogNumber}
                maxLength={100}
                onChange={(event) => updateMetadata("catalogNumber", event.target.value)}
              />
            </label>
            <label className="suggestion-form-field" htmlFor={`${idPrefix}-barcode`}>
              <span className="suggestion-form-label">Barcode</span>
              <input
                id={`${idPrefix}-barcode`}
                className="suggestion-form-input"
                type="text"
                inputMode="numeric"
                value={metadata.barcode}
                maxLength={32}
                onChange={(event) => updateMetadata("barcode", event.target.value)}
              />
            </label>
            <label className="suggestion-form-field suggestion-form-field-wide" htmlFor={`${idPrefix}-cover-source`}>
              <span className="suggestion-form-label">Direct cover image URL</span>
              <input
                id={`${idPrefix}-cover-source`}
                className="suggestion-form-input"
                type="url"
                value={metadata.coverSourceUrl}
                maxLength={2048}
                placeholder="https://"
                onChange={(event) => updateMetadata("coverSourceUrl", event.target.value)}
              />
              <span className="suggestion-form-hint">Optional. If approved, this HTTPS image URL will be published as the album cover. Leave blank and Rescened will try Cover Art Archive automatically.</span>
            </label>
          </div>
        </section>

        <section className="suggestion-form-section" id={`${idPrefix}-artists`} aria-labelledby={`${idPrefix}-artists-heading`}>
          <SectionHeading
            eyebrow="02 / Credits"
            title="Artist credits"
            description="Add every credited artist and their role on this release."
            count={`${metadata.artistCredits.length}/${MAX_ARTISTS}`}
            headingId={`${idPrefix}-artists-heading`}
          />
          <label className="suggestion-form-field suggestion-form-field-wide" htmlFor={`${idPrefix}-artist-display`}>
            <span className="suggestion-form-label">Artist display name</span>
            <input
              id={`${idPrefix}-artist-display`}
              className="suggestion-form-input"
              type="text"
              value={metadata.artistDisplayName}
              maxLength={300}
              placeholder="Leave blank to join the credit names with &"
              onChange={(event) => updateMetadata("artistDisplayName", event.target.value)}
            />
          </label>
          <div className="suggestion-form-repeater">
            {metadata.artistCredits.map((artist, index) => (
              <div className="suggestion-form-repeater-row" key={artist.key}>
                <p className="suggestion-form-row-number">Artist {String(index + 1).padStart(2, "0")}</p>
                <label className="suggestion-form-field" htmlFor={`${idPrefix}-${artist.key}-name`}>
                  <span className="suggestion-form-label">Name *</span>
                  <input
                    id={`${idPrefix}-${artist.key}-name`}
                    className="suggestion-form-input"
                    type="text"
                    value={artist.name}
                    maxLength={200}
                    onChange={(event) => updateArtist(artist.key, "name", event.target.value)}
                  />
                </label>
                <label className="suggestion-form-field" htmlFor={`${idPrefix}-${artist.key}-role`}>
                  <span className="suggestion-form-label">Role</span>
                  <input
                    id={`${idPrefix}-${artist.key}-role`}
                    className="suggestion-form-input"
                    type="text"
                    value={artist.role}
                    maxLength={80}
                    onChange={(event) => updateArtist(artist.key, "role", event.target.value)}
                  />
                </label>
                <button
                  className="suggestion-form-remove"
                  type="button"
                  disabled={metadata.artistCredits.length === 1}
                  onClick={() => removeArtist(artist.key)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button
            className="suggestion-form-add"
            type="button"
            disabled={metadata.artistCredits.length >= MAX_ARTISTS}
            onClick={addArtist}
          >
            + Add artist credit
          </button>
        </section>

        <section className="suggestion-form-section" id={`${idPrefix}-sources`} aria-labelledby={`${idPrefix}-sources-heading`}>
          <SectionHeading
            eyebrow="03 / Evidence"
            title="Supporting sources"
            description="Provide at least one trustworthy HTTPS source. Spotify belongs here as evidence."
            count={`${draft.supportingSources.length}/${MAX_SOURCES}`}
            headingId={`${idPrefix}-sources-heading`}
          />
          <div className="suggestion-form-repeater">
            {draft.supportingSources.map((source, index) => (
              <div className="suggestion-form-repeater-row suggestion-form-repeater-row-source" key={source.key}>
                <p className="suggestion-form-row-number">Source {String(index + 1).padStart(2, "0")}</p>
                <label className="suggestion-form-field" htmlFor={`${idPrefix}-${source.key}-type`}>
                  <span className="suggestion-form-label">Type *</span>
                  <select
                    id={`${idPrefix}-${source.key}-type`}
                    className="suggestion-form-select"
                    value={source.type}
                    onChange={(event) => updateRow("supportingSources", source.key, "type", event.target.value)}
                  >
                    {SOURCE_TYPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="suggestion-form-field suggestion-form-field-wide" htmlFor={`${idPrefix}-${source.key}-url`}>
                  <span className="suggestion-form-label">HTTPS URL *</span>
                  <input
                    id={`${idPrefix}-${source.key}-url`}
                    className="suggestion-form-input"
                    type="url"
                    value={source.url}
                    maxLength={2048}
                    placeholder="https://"
                    onChange={(event) => updateRow("supportingSources", source.key, "url", event.target.value)}
                  />
                </label>
                <label className="suggestion-form-field suggestion-form-field-wide" htmlFor={`${idPrefix}-${source.key}-description`}>
                  <span className="suggestion-form-label">What this source confirms</span>
                  <input
                    id={`${idPrefix}-${source.key}-description`}
                    className="suggestion-form-input"
                    type="text"
                    value={source.description}
                    maxLength={200}
                    onChange={(event) => updateRow("supportingSources", source.key, "description", event.target.value)}
                  />
                </label>
                <button
                  className="suggestion-form-remove"
                  type="button"
                  disabled={draft.supportingSources.length === 1}
                  onClick={() => removeRow("supportingSources", source.key)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button
            className="suggestion-form-add"
            type="button"
            disabled={draft.supportingSources.length >= MAX_SOURCES}
            onClick={addSource}
          >
            + Add supporting source
          </button>
        </section>

        <section className="suggestion-form-section" id={`${idPrefix}-references`} aria-labelledby={`${idPrefix}-references-heading`}>
          <SectionHeading
            eyebrow="04 / IDs"
            title="External references"
            description="Optional structured IDs help moderators match canonical records. Do not add Spotify here."
            count={`${draft.externalReferences.length}/${MAX_REFERENCES}`}
            headingId={`${idPrefix}-references-heading`}
          />
          {draft.externalReferences.length ? (
            <div className="suggestion-form-repeater">
              {draft.externalReferences.map((reference, index) => (
                <div className="suggestion-form-repeater-row suggestion-form-repeater-row-reference" key={reference.key}>
                  <p className="suggestion-form-row-number">Reference {String(index + 1).padStart(2, "0")}</p>
                  <label className="suggestion-form-field" htmlFor={`${idPrefix}-${reference.key}-provider`}>
                    <span className="suggestion-form-label">Provider *</span>
                    <input
                      id={`${idPrefix}-${reference.key}-provider`}
                      className="suggestion-form-input"
                      type="text"
                      value={reference.provider}
                      maxLength={50}
                      placeholder="musicbrainz"
                      onChange={(event) => updateRow("externalReferences", reference.key, "provider", event.target.value)}
                    />
                  </label>
                  <label className="suggestion-form-field" htmlFor={`${idPrefix}-${reference.key}-entity`}>
                    <span className="suggestion-form-label">Entity type *</span>
                    <input
                      id={`${idPrefix}-${reference.key}-entity`}
                      className="suggestion-form-input"
                      type="text"
                      value={reference.entityType}
                      maxLength={50}
                      placeholder="release-group"
                      onChange={(event) => updateRow("externalReferences", reference.key, "entityType", event.target.value)}
                    />
                  </label>
                  <label className="suggestion-form-field" htmlFor={`${idPrefix}-${reference.key}-id`}>
                    <span className="suggestion-form-label">External ID *</span>
                    <input
                      id={`${idPrefix}-${reference.key}-id`}
                      className="suggestion-form-input"
                      type="text"
                      value={reference.externalId}
                      maxLength={200}
                      onChange={(event) => updateRow("externalReferences", reference.key, "externalId", event.target.value)}
                    />
                  </label>
                  <label className="suggestion-form-field suggestion-form-field-wide" htmlFor={`${idPrefix}-${reference.key}-url`}>
                    <span className="suggestion-form-label">Reference URL</span>
                    <input
                      id={`${idPrefix}-${reference.key}-url`}
                      className="suggestion-form-input"
                      type="url"
                      value={reference.url}
                      maxLength={2048}
                      placeholder="https://"
                      onChange={(event) => updateRow("externalReferences", reference.key, "url", event.target.value)}
                    />
                  </label>
                  <button
                    className="suggestion-form-remove"
                    type="button"
                    onClick={() => removeRow("externalReferences", reference.key)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="suggestion-form-empty-copy">No external references added.</p>
          )}
          <button
            className="suggestion-form-add"
            type="button"
            disabled={draft.externalReferences.length >= MAX_REFERENCES}
            onClick={addReference}
          >
            + Add external reference
          </button>
        </section>

        <section className="suggestion-form-section" id={`${idPrefix}-tracks`} aria-labelledby={`${idPrefix}-tracks-heading`}>
          <SectionHeading
            eyebrow="05 / Tracklist"
            title="Tracks"
            description="Optional. Add a tracklist when a reliable source confirms it. Duration is entered in milliseconds."
            count={`${metadata.tracks.length}/${MAX_TRACKS}`}
            headingId={`${idPrefix}-tracks-heading`}
          />
          {metadata.tracks.length ? (
            <div className="suggestion-form-repeater">
              {metadata.tracks.map((track, index) => (
                <div className="suggestion-form-repeater-row suggestion-form-repeater-row-track" key={track.key}>
                  <p className="suggestion-form-row-number">Track {String(index + 1).padStart(2, "0")}</p>
                  <label className="suggestion-form-field suggestion-form-field-compact" htmlFor={`${idPrefix}-${track.key}-disc`}>
                    <span className="suggestion-form-label">Disc *</span>
                    <input
                      id={`${idPrefix}-${track.key}-disc`}
                      className="suggestion-form-input"
                      type="number"
                      value={track.discNumber}
                      min="1"
                      max="999"
                      step="1"
                      onChange={(event) => updateTrack(track.key, "discNumber", event.target.value)}
                    />
                  </label>
                  <label className="suggestion-form-field suggestion-form-field-compact" htmlFor={`${idPrefix}-${track.key}-number`}>
                    <span className="suggestion-form-label">Number *</span>
                    <input
                      id={`${idPrefix}-${track.key}-number`}
                      className="suggestion-form-input"
                      type="number"
                      value={track.trackNumber}
                      min="1"
                      max="999"
                      step="1"
                      onChange={(event) => updateTrack(track.key, "trackNumber", event.target.value)}
                    />
                  </label>
                  <label className="suggestion-form-field suggestion-form-field-wide" htmlFor={`${idPrefix}-${track.key}-title`}>
                    <span className="suggestion-form-label">Title *</span>
                    <input
                      id={`${idPrefix}-${track.key}-title`}
                      className="suggestion-form-input"
                      type="text"
                      value={track.title}
                      maxLength={200}
                      onChange={(event) => updateTrack(track.key, "title", event.target.value)}
                    />
                  </label>
                  <label className="suggestion-form-field" htmlFor={`${idPrefix}-${track.key}-duration`}>
                    <span className="suggestion-form-label">Duration (ms)</span>
                    <input
                      id={`${idPrefix}-${track.key}-duration`}
                      className="suggestion-form-input"
                      type="number"
                      value={track.durationMs}
                      min="0"
                      max="86400000"
                      step="1"
                      onChange={(event) => updateTrack(track.key, "durationMs", event.target.value)}
                    />
                  </label>
                  <label className="suggestion-form-field suggestion-form-field-wide" htmlFor={`${idPrefix}-${track.key}-artist`}>
                    <span className="suggestion-form-label">Track artist</span>
                    <input
                      id={`${idPrefix}-${track.key}-artist`}
                      className="suggestion-form-input"
                      type="text"
                      value={track.artistDisplayName}
                      maxLength={300}
                      onChange={(event) => updateTrack(track.key, "artistDisplayName", event.target.value)}
                    />
                  </label>
                  <button
                    className="suggestion-form-remove"
                    type="button"
                    onClick={() => removeTrack(track.key)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="suggestion-form-empty-copy">No tracks added.</p>
          )}
          <button
            className="suggestion-form-add"
            type="button"
            disabled={metadata.tracks.length >= MAX_TRACKS}
            onClick={addTrack}
          >
            + Add track
          </button>
        </section>
        </fieldset>

        <aside className="suggestion-form-summary" aria-labelledby={`${idPrefix}-summary-heading`}>
          <p className="suggestion-form-section-eyebrow">Review summary</p>
          <h2 id={`${idPrefix}-summary-heading`}>{metadata.title.trim() || "Untitled release"}</h2>
          <p className="suggestion-form-summary-artist">{artistSummary}</p>
          <dl>
            <div>
              <dt>Release</dt>
              <dd>{releaseTypeSummary} · {releaseDateSummary}</dd>
            </div>
            <div>
              <dt>Artists</dt>
              <dd>{metadata.artistCredits.length}</dd>
            </div>
            <div>
              <dt>Evidence</dt>
              <dd>{draft.supportingSources.length} required source{draft.supportingSources.length === 1 ? "" : "s"}</dd>
            </div>
            <div>
              <dt>External IDs</dt>
              <dd>{draft.externalReferences.length}</dd>
            </div>
            <div>
              <dt>Tracks</dt>
              <dd>{metadata.tracks.length || "Not added"}</dd>
            </div>
          </dl>
          <p className="suggestion-form-summary-note">
            Your proposal stays private to you and catalog moderators until an approval publishes an album.
          </p>
        </aside>
      </div>

      <div className="suggestion-form-submit-row">
        <p className="suggestion-form-submit-note">Fields marked * are required. Submission evidence remains private to you and moderators.</p>
        <button className="suggestion-form-submit" type="submit" disabled={controlsDisabled}>
          {isSubmitting ? submittingLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}

export default SuggestionForm;
