// RFC 4180 CSV for spreadsheet users: every field quoted, CRLF line endings,
// and a UTF-8 byte order mark so Excel detects the encoding.
const BOM = "﻿";
const CRLF = "\r\n";

// Spreadsheets run a cell that starts with one of these as a formula. Text
// cells get a visible ' prefix; numbers and booleans are never prefixed.
const FORMULA_START = /^[=+\-@\t\r]/;

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value);
  return FORMULA_START.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  return `"${cellText(value).replace(/"/g, "\"\"")}"`;
}

// rows are objects; columns name their keys in output order.
function toCsv(columns, rows) {
  const lines = [columns, ...rows.map((row) => columns.map((column) => row[column]))];
  return BOM + lines.map((cells) => cells.map(csvCell).join(",")).join(CRLF) + CRLF;
}

module.exports = { BOM, CRLF, csvCell, toCsv };
