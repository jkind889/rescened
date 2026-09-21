const crypto = require("node:crypto");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function uuid(value, domain) {
  if (typeof value !== "string" || !UUID_V4.test(value.trim())) {
    throw fail(400, `INVALID_${domain.toUpperCase()}_ID`, `${domain}Id must be a UUID v4`);
  }
  return value.trim().toLowerCase();
}

function fields(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => !allowed.includes(key))) {
    throw fail(400, "INVALID_DIARY_REQUEST", "Request contains invalid or unsupported fields");
  }
}

function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function calendarDate(value) {
  if (!isCalendarDate(value)) throw fail(400, "INVALID_LISTEN_DATE", "Date must be a real YYYY-MM-DD calendar date");
  return value;
}

function listeningDate(body, now = new Date()) {
  const listenedOn = calendarDate(body.listenedOn);
  if (typeof body.timeZone !== "string" || !body.timeZone.trim() || /^[+-]/.test(body.timeZone.trim())) {
    throw fail(400, "INVALID_TIME_ZONE", "timeZone must be an IANA timezone");
  }
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: body.timeZone.trim(), year: "numeric", month: "2-digit", day: "2-digit",
    });
  } catch {
    throw fail(400, "INVALID_TIME_ZONE", "timeZone must be an IANA timezone");
  }
  const parts = Object.fromEntries(formatter.formatToParts(now).map(({ type, value }) => [type, value]));
  if (listenedOn > `${parts.year}-${parts.month}-${parts.day}`) {
    throw fail(400, "INVALID_LISTEN_DATE", "A listen cannot be dated in the future");
  }
  return { listenedOn, timeZone: formatter.resolvedOptions().timeZone };
}

function creationInput(body, key) {
  fields(body, ["albumId", "listenedOn", "timeZone", "boardIds"]);
  if (typeof key !== "string" || !UUID_V4.test(key.trim())) {
    throw fail(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be a UUID v4");
  }
  if (body.boardIds !== undefined && (!Array.isArray(body.boardIds) || body.boardIds.length > 100)) {
    throw fail(400, "INVALID_DIARY_REQUEST", "boardIds must contain at most 100 board UUIDs");
  }
  const input = {
    albumId: uuid(body.albumId, "album"),
    ...listeningDate(body),
    boardIds: [...new Set((body.boardIds || []).map((id) => uuid(id, "board")))].sort(),
  };
  return {
    ...input, key: key.trim().toLowerCase(),
    fingerprint: crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex"),
  };
}

module.exports = { UUID_V4, fail, uuid, fields, isCalendarDate, calendarDate, listeningDate, creationInput };
