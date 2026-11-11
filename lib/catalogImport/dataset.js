const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Ajv = require("ajv");

const SCHEMA_VERSION = "1.0.0";
const MAX_DATASET_BYTES = 25 * 1024 * 1024;
const SCHEMA_PATH = path.resolve(__dirname, "../../data/catalog-import/catalog-import.schema.json");
const DATASET_SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
const EXPECTED_RANGES = new Set(["all_time", "year", "month"]);

class DatasetValidationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "DatasetValidationError";
    this.code = code;
    this.errors = Array.isArray(options.errors) ? options.errors : [];
    this.quarantined = Array.isArray(options.quarantined) ? options.quarantined : [];
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createValidators() {
  const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });

  // Album failures are quarantinable, so the first pass validates only the
  // envelope and the fact that `albums` is a bounded, non-empty array.
  const envelopeSchema = clone(DATASET_SCHEMA);
  delete envelopeSchema.$id;
  envelopeSchema.properties.albums.items = {};

  const albumSchema = {
    $schema: DATASET_SCHEMA.$schema,
    definitions: DATASET_SCHEMA.definitions,
    $ref: "#/definitions/album",
  };

  return {
    envelope: ajv.compile(envelopeSchema),
    album: ajv.compile(albumSchema),
  };
}

const validators = createValidators();

function escapeJsonPointer(value) {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}

function legacyDataPathToPointer(dataPath = "") {
  return String(dataPath)
    .replace(/\[['"]([^'"]+)['"]\]/g, "/$1")
    .replace(/\[(\d+)\]/g, "/$1")
    .replace(/\.([^.[\]]+)/g, "/$1");
}

function ajvErrorPointer(error) {
  let pointer = typeof error.instancePath === "string"
    ? error.instancePath
    : legacyDataPathToPointer(error.dataPath);

  if (error.keyword === "required" && error.params?.missingProperty) {
    pointer += `/${escapeJsonPointer(error.params.missingProperty)}`;
  }
  if (error.keyword === "additionalProperties" && error.params?.additionalProperty) {
    pointer += `/${escapeJsonPointer(error.params.additionalProperty)}`;
  }
  return pointer;
}

function schemaErrorCode(error, scope) {
  if (error.keyword === "additionalProperties") return "UNKNOWN_FIELD";
  if (error.keyword === "required") return "MISSING_FIELD";
  return scope === "envelope" ? "INVALID_ENVELOPE" : "INVALID_ALBUM";
}

function issue({ code, pointer, message, rowIndex = null, sourceMbid = null }) {
  return {
    rowIndex,
    sourceMbid,
    code,
    pointer: pointer || "",
    message,
  };
}

function mapSchemaErrors(errors, { scope, basePointer = "", rowIndex = null, sourceMbid = null }) {
  return (errors || []).map((error) => issue({
    rowIndex,
    sourceMbid,
    code: schemaErrorCode(error, scope),
    pointer: `${basePointer}${ajvErrorPointer(error)}`,
    message: error.message || "does not match the dataset schema",
  }));
}

function isCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function isIsoTimestamp(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.exec(String(value));
  return Boolean(match && isCalendarDate(match[1]) && !Number.isNaN(Date.parse(value)));
}

function releaseDateParts(value) {
  if (value === "") return { precision: "", year: null, valid: true };
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(String(value));
  if (!match) return { valid: false };
  const precision = match[3] ? "day" : match[2] ? "month" : "year";
  if (precision === "day" && !isCalendarDate(value)) return { valid: false };
  return { precision, year: Number(match[1]), valid: true };
}

function semanticAlbumErrors(row, index) {
  const basePointer = `/albums/${index}`;
  const sourceMbid = typeof row?.releaseGroupMbid === "string" ? row.releaseGroupMbid : null;
  const errors = [];
  const add = (code, field, message) => errors.push(issue({
    rowIndex: index,
    sourceMbid,
    code,
    pointer: `${basePointer}${field}`,
    message,
  }));

  const stringsToTrim = [
    ["/title", row.title],
    ["/artistDisplayName", row.artistDisplayName],
    ...row.artistCredits.map((credit, creditIndex) => [`/artistCredits/${creditIndex}/name`, credit.name]),
    ...row.artistCredits.flatMap((credit, creditIndex) => credit.artistName === undefined ? [] : [[`/artistCredits/${creditIndex}/artistName`, credit.artistName]]),
  ];
  for (const [pointer, value] of stringsToTrim) {
    if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
      add("UNNORMALIZED_TEXT", pointer, "must be trimmed and must not contain control characters");
    }
  }

  const expectedArtistDisplayName = row.artistCredits
    .map((credit) => `${credit.name}${credit.joinPhrase}`)
    .join("");
  if (row.artistDisplayName !== expectedArtistDisplayName) {
    add(
      "ARTIST_DISPLAY_MISMATCH",
      "/artistDisplayName",
      "must equal the artist credits joined with their MusicBrainz join phrases",
    );
  }

  const date = releaseDateParts(row.releaseDate);
  if (!date.valid) {
    add("INVALID_RELEASE_DATE", "/releaseDate", "must be a real YYYY, YYYY-MM, or YYYY-MM-DD calendar date");
  } else if (row.releaseDatePrecision !== date.precision || row.releaseYear !== date.year) {
    add(
      "INVALID_DATE_TUPLE",
      "/releaseDate",
      "releaseDate, releaseDatePrecision, and releaseYear must describe the same precision and year",
    );
  }

  // ListenBrainz can return the same release group more than once in one
  // ranking (for example, with different representative CAA releases). Keep
  // every observed rank/listen-count tuple rather than collapsing by range.
  const signalRanges = new Set(row.selectionSignals.map((signal) => signal.range));
  if (!signalRanges.has(row.selectedRange)) {
    add("MISSING_SELECTED_RANGE_SIGNAL", "/selectedRange", "must have a matching selectionSignals entry");
  }

  if (row.cover) {
    if (row.representativeReleaseMbid !== row.cover.releaseMbid) {
      add(
        "INVALID_CAA_REFERENCE",
        "/cover/releaseMbid",
        "must equal representativeReleaseMbid",
      );
    }
    const expectedUrl = `https://coverartarchive.org/release/${row.cover.releaseMbid}/front-500`;
    if (row.cover.url500 !== expectedUrl) {
      add("INVALID_CAA_REFERENCE", "/cover/url500", "must reference the cover release MBID at the 500px endpoint");
    }
  }

  for (const source of ["listenbrainz", "musicbrainz"]) {
    if (!isIsoTimestamp(row.sourceFetchedAt[source])) {
      add("INVALID_SOURCE_TIMESTAMP", `/sourceFetchedAt/${source}`, "must be a real UTC ISO-8601 timestamp");
    }
  }

  return errors;
}

/**
 * Validate one album independently of dataset-wide duplicate/cap constraints.
 * Returns { valid, row, index, errors }. It never throws for row-level errors.
 */
function validateAlbumRow(row, index = 0) {
  const rowIndex = Number.isInteger(index) && index >= 0 ? index : 0;
  const sourceMbid = typeof row?.releaseGroupMbid === "string" ? row.releaseGroupMbid : null;
  const schemaValid = validators.album(row);
  if (!schemaValid) {
    const errors = mapSchemaErrors(validators.album.errors, {
      scope: "album",
      basePointer: `/albums/${rowIndex}`,
      rowIndex,
      sourceMbid,
    });
    return { valid: false, row, index: rowIndex, errors };
  }

  const errors = semanticAlbumErrors(row, rowIndex);
  return { valid: errors.length === 0, row, index: rowIndex, errors };
}

function semanticEnvelopeErrors(dataset) {
  const errors = [];
  const add = (code, pointer, message) => errors.push(issue({ code, pointer, message }));

  if (!isIsoTimestamp(dataset.generatedAt)) {
    add("INVALID_GENERATED_AT", "/generatedAt", "must be a real UTC ISO-8601 timestamp");
  }

  const ranges = new Map();
  for (let index = 0; index < dataset.selection.ranges.length; index += 1) {
    const selectionRange = dataset.selection.ranges[index];
    if (ranges.has(selectionRange.range)) {
      add("DUPLICATE_SELECTION_RANGE", `/selection/ranges/${index}/range`, "each selection range must occur once");
    }
    ranges.set(selectionRange.range, selectionRange);

    if (selectionRange.candidateLimit < selectionRange.quota) {
      add(
        "INVALID_RANGE_LIMIT",
        `/selection/ranges/${index}/candidateLimit`,
        "candidateLimit must be greater than or equal to quota",
      );
    }
    const hasFrom = selectionRange.from !== null;
    const hasTo = selectionRange.to !== null;
    if (hasFrom !== hasTo) {
      add("INVALID_RANGE_DATES", `/selection/ranges/${index}`, "from and to must both be dates or both be null");
    } else if (hasFrom) {
      if (!isCalendarDate(selectionRange.from) || !isCalendarDate(selectionRange.to)) {
        add("INVALID_RANGE_DATES", `/selection/ranges/${index}`, "from and to must be real calendar dates");
      } else if (selectionRange.from > selectionRange.to) {
        add("INVALID_RANGE_DATES", `/selection/ranges/${index}/from`, "from must not be after to");
      }
    }
    if (!isIsoTimestamp(selectionRange.fetchedAt)) {
      add("INVALID_RANGE_TIMESTAMP", `/selection/ranges/${index}/fetchedAt`, "must be a real UTC ISO-8601 timestamp");
    }
  }

  for (const rangeName of EXPECTED_RANGES) {
    if (!ranges.has(rangeName)) {
      add("MISSING_SELECTION_RANGE", "/selection/ranges", `must contain the ${rangeName} range`);
    }
  }

  const totalQuota = dataset.selection.ranges.reduce((sum, selectionRange) => sum + selectionRange.quota, 0);
  if (totalQuota !== dataset.selection.targetAlbumCount) {
    add("INVALID_QUOTA_TOTAL", "/selection/targetAlbumCount", "must equal the sum of selection range quotas");
  }
  if (dataset.albums.length !== dataset.selection.targetAlbumCount) {
    add("INVALID_ALBUM_COUNT", "/albums", "album row count must equal selection.targetAlbumCount");
  }

  return errors;
}

function quarantineRecord(errors) {
  const first = errors[0];
  return {
    rowIndex: first.rowIndex,
    sourceMbid: first.sourceMbid,
    code: first.code,
    pointer: first.pointer,
    message: first.message,
    issues: errors,
  };
}

/**
 * Validate a parsed dataset. Envelope failures throw DatasetValidationError;
 * album failures are returned as one quarantine record per rejected row.
 */
function validateDatasetObject(dataset) {
  if (!dataset || typeof dataset !== "object" || Array.isArray(dataset)) {
    throw new DatasetValidationError("INVALID_ENVELOPE", "Dataset must be a JSON object", {
      errors: [issue({ code: "INVALID_ENVELOPE", pointer: "", message: "must be a JSON object" })],
    });
  }
  if (Object.prototype.hasOwnProperty.call(dataset, "schemaVersion") && dataset.schemaVersion !== SCHEMA_VERSION) {
    throw new DatasetValidationError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `Unsupported dataset schemaVersion: ${String(dataset.schemaVersion)}`,
      { errors: [issue({ code: "UNSUPPORTED_SCHEMA_VERSION", pointer: "/schemaVersion", message: `must equal ${SCHEMA_VERSION}` })] },
    );
  }

  const envelopeValid = validators.envelope(dataset);
  if (!envelopeValid) {
    const errors = mapSchemaErrors(validators.envelope.errors, { scope: "envelope" });
    throw new DatasetValidationError("INVALID_ENVELOPE", "Dataset envelope does not match schema version 1.0.0", { errors });
  }

  const envelopeErrors = semanticEnvelopeErrors(dataset);
  if (envelopeErrors.length > 0) {
    throw new DatasetValidationError("INVALID_ENVELOPE", "Dataset envelope failed semantic validation", {
      errors: envelopeErrors,
    });
  }

  const validAlbums = [];
  const quarantined = [];
  const seenReleaseGroups = new Map();
  const primaryArtistCounts = new Map();
  const rangeLimits = new Map(dataset.selection.ranges.map((selectionRange) => [selectionRange.range, selectionRange]));
  const acceptedRangeCounts = new Map(dataset.selection.ranges.map((selectionRange) => [selectionRange.range, 0]));

  dataset.albums.forEach((row, index) => {
    const validation = validateAlbumRow(row, index);
    if (!validation.valid) {
      quarantined.push(quarantineRecord(validation.errors));
      return;
    }

    const contextErrors = [];
    const add = (code, pointer, message) => contextErrors.push(issue({
      rowIndex: index,
      sourceMbid: row.releaseGroupMbid,
      code,
      pointer: `/albums/${index}${pointer}`,
      message,
    }));

    if (seenReleaseGroups.has(row.releaseGroupMbid)) {
      add(
        "DUPLICATE_SOURCE_KEY",
        "/releaseGroupMbid",
        `duplicates album row ${seenReleaseGroups.get(row.releaseGroupMbid)}`,
      );
    }

    for (let signalIndex = 0; signalIndex < row.selectionSignals.length; signalIndex += 1) {
      const signal = row.selectionSignals[signalIndex];
      const selectionRange = rangeLimits.get(signal.range);
      if (selectionRange && signal.rank > selectionRange.candidateLimit) {
        add(
          "RANK_EXCEEDS_CANDIDATE_LIMIT",
          `/selectionSignals/${signalIndex}/rank`,
          `must not exceed the ${signal.range} candidateLimit`,
        );
      }
    }

    const primaryArtistMbid = row.artistCredits[0].artistMbid;
    const artistCount = primaryArtistCounts.get(primaryArtistMbid) || 0;
    if (artistCount >= dataset.selection.maxPerPrimaryArtist) {
      add(
        "PRIMARY_ARTIST_CAP_EXCEEDED",
        "/artistCredits/0/artistMbid",
        `exceeds maxPerPrimaryArtist (${dataset.selection.maxPerPrimaryArtist})`,
      );
    }

    // Only otherwise-acceptable rows compete for quota slots. Schema-invalid,
    // duplicate, rank-invalid, and artist-capped rows must not consume a slot
    // that a later valid row from the same range can fill.
    if (contextErrors.length === 0) {
      const selectedRange = rangeLimits.get(row.selectedRange);
      const acceptedInRange = acceptedRangeCounts.get(row.selectedRange) || 0;
      if (acceptedInRange >= selectedRange.quota) {
        add(
          "RANGE_QUOTA_EXCEEDED",
          "/selectedRange",
          `exceeds the declared ${row.selectedRange} quota (${selectedRange.quota})`,
        );
      }
    }

    if (contextErrors.length > 0) {
      quarantined.push(quarantineRecord(contextErrors));
      return;
    }

    seenReleaseGroups.set(row.releaseGroupMbid, index);
    primaryArtistCounts.set(primaryArtistMbid, artistCount + 1);
    acceptedRangeCounts.set(row.selectedRange, (acceptedRangeCounts.get(row.selectedRange) || 0) + 1);
    validAlbums.push({ row, index });
  });

  if (validAlbums.length === 0) {
    throw new DatasetValidationError("NO_VALID_ALBUMS", "Dataset contains zero valid album rows", { quarantined });
  }

  return {
    dataset,
    validAlbums,
    quarantined,
    errors: [],
  };
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function datasetSha256(objectOrText) {
  const input = typeof objectOrText === "string" ? objectOrText : stableJson(objectOrText);
  if (typeof input !== "string") throw new TypeError("datasetSha256 requires a JSON value or string");
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Read, size-limit, parse, and validate a dataset without touching MongoDB.
 */
function readDatasetFile(inputPath) {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new DatasetValidationError("DATASET_READ_FAILED", "A dataset input path is required");
  }

  const sourcePath = path.resolve(inputPath);
  let stat;
  let sourceText;
  try {
    stat = fs.statSync(sourcePath);
    if (!stat.isFile()) throw new Error("input path is not a file");
    if (stat.size > MAX_DATASET_BYTES) {
      throw new DatasetValidationError(
        "DATASET_TOO_LARGE",
        `Dataset exceeds the ${MAX_DATASET_BYTES}-byte limit`,
      );
    }
    sourceText = fs.readFileSync(sourcePath, "utf8");
  } catch (error) {
    if (error instanceof DatasetValidationError) throw error;
    throw new DatasetValidationError("DATASET_READ_FAILED", `Unable to read dataset: ${sourcePath}`, { cause: error });
  }

  const bytes = Buffer.byteLength(sourceText, "utf8");
  if (bytes > MAX_DATASET_BYTES) {
    throw new DatasetValidationError("DATASET_TOO_LARGE", `Dataset exceeds the ${MAX_DATASET_BYTES}-byte limit`);
  }

  let dataset;
  try {
    dataset = JSON.parse(sourceText);
  } catch (error) {
    throw new DatasetValidationError("MALFORMED_JSON", "Dataset is not valid JSON", { cause: error });
  }

  return {
    ...validateDatasetObject(dataset),
    sourcePath,
    sourceText,
    bytes,
    sha256: datasetSha256(sourceText),
  };
}

module.exports = {
  DATASET_SCHEMA,
  DatasetValidationError,
  MAX_DATASET_BYTES,
  SCHEMA_PATH,
  SCHEMA_VERSION,
  datasetSha256,
  readDatasetFile,
  validateAlbumRow,
  validateDatasetObject,
};
