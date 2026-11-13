// Text handling for cached artist biographies. Pure functions only:
// - leadParagraphsFromParseHtml: plain-text paragraphs from the lead section
//   HTML that MediaWiki's action=parse returns for one pinned revision.
// - shortenBiography: a display excerpt of about 250 user-perceived
//   characters (grapheme clusters), preferring complete sentences.
// Nothing here fetches or stores data.

const crypto = require("node:crypto");

const EXTRACTION_VERSION = "en-lead-sentences-v1";
const DEFAULT_MAX_GRAPHEMES = 250;
const MIN_GRAPHEMES = 20;
const MAX_HTML_BYTES = 1024 * 1024;

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
// Subtrees that are never biography prose: references, maintenance and
// navigation markup, styles, media, tables (infoboxes), and anything
// Wikipedia marks as not suitable for excerpts.
const SKIP_TAGS = new Set(["sup", "style", "script", "table", "figure", "audio", "video", "noscript", "math", "svg", "img", "ul", "ol", "dl", "blockquote", "div", "h1", "h2", "h3", "h4", "h5", "h6"]);
const SKIP_CLASSES = ["reference", "noprint", "noexcerpt", "mw-editsection", "metadata", "mw-empty-elt", "mw-ref", "error", "hatnote", "shortdescription", "nomobile", "mw-cite-backlink", "Z3988"];
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", shy: "", zwj: "‍", zwnj: "‌", thinsp: " ", ensp: " ", emsp: " " };

class BiographyTextError extends Error {
  constructor(message, code = "BIOGRAPHY_TEXT_UNSUITABLE") {
    super(message);
    this.name = "BiographyTextError";
    this.code = code;
  }
}

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function attribute(attrs, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(` ${attrs}`);
  return match ? decodeEntities(match[2] ?? match[3] ?? match[4] ?? "") : "";
}

function skipsElement(tag, attrs) {
  if (SKIP_TAGS.has(tag)) return true;
  const classes = attribute(attrs, "class").split(/\s+/);
  if (classes.some((value) => SKIP_CLASSES.includes(value))) return true;
  const id = attribute(attrs, "id");
  if (id === "coordinates") return true;
  return /display\s*:\s*none/i.test(attribute(attrs, "style"));
}

function cleanParagraph(text) {
  return text
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?)\]])/g, "$1")
    .replace(/([(\[])\s+/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Collects text only from <p> elements that are direct children of the
// parser output root. Everything nested in skipped subtrees is ignored.
function leadParagraphsFromParseHtml(html) {
  if (typeof html !== "string") throw new BiographyTextError("Lead HTML is missing", "BIOGRAPHY_INVALID_RESPONSE");
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new BiographyTextError("Lead HTML is too large", "BIOGRAPHY_INVALID_RESPONSE");
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)|</g;
  const stack = [];
  let skipDepth = 0;
  let paragraph = null;
  const paragraphs = [];
  let match;
  while ((match = tokens.exec(html)) !== null) {
    const [, closing, rawTag, attrs = "", selfClosing, text] = match;
    if (text !== undefined || (!rawTag && match[0] === "<")) {
      if (paragraph !== null && skipDepth === 0) paragraph.push(text === undefined ? "<" : text);
      continue;
    }
    if (!rawTag) continue; // comment or CDATA
    const tag = rawTag.toLowerCase();
    if (closing) {
      // Pop to the matching open element; tolerate stray closing tags.
      const index = stack.map((entry) => entry.tag).lastIndexOf(tag);
      if (index === -1) continue;
      while (stack.length > index) {
        const entry = stack.pop();
        if (entry.skip) skipDepth -= 1;
        if (entry.paragraph && paragraph !== null) {
          const value = cleanParagraph(decodeEntities(paragraph.join("")));
          if (value) paragraphs.push(value);
          paragraph = null;
        }
      }
      continue;
    }
    if (VOID_ELEMENTS.has(tag) || selfClosing) {
      if (tag === "br" && paragraph !== null && skipDepth === 0) paragraph.push(" ");
      continue;
    }
    // The root is the parser output wrapper; a top-level <p> sits directly in it.
    const isRoot = stack.length === 0 && tag === "div";
    const topLevelParagraph = tag === "p" && skipDepth === 0 && stack.length === 1 && stack[0].root;
    const skip = !isRoot && !topLevelParagraph && (skipDepth > 0 || skipsElement(tag, attrs) || (tag === "p" && stack.length !== 1));
    if (skip) skipDepth += 1;
    if (topLevelParagraph && skipsElement(tag, attrs)) {
      stack.push({ tag, skip: true });
      skipDepth += 1;
      continue;
    }
    stack.push({ tag, skip, root: isRoot, paragraph: topLevelParagraph });
    if (topLevelParagraph) paragraph = [];
  }
  return paragraphs;
}

function graphemes(text) {
  return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
}

function graphemeLength(text) {
  return graphemes(text).length;
}

function sentences(text) {
  return [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)].map((part) => part.segment.trim()).filter(Boolean);
}

// An excerpt of the first lead paragraph. Prefer the longest run of whole
// sentences that fits; if even the first sentence is longer than the cap,
// cut at a word boundary and mark it with an ellipsis. `shortened` is true
// whenever the excerpt is not the whole lead, `cut` says how.
function shortenBiography(paragraphs, { maxGraphemes = DEFAULT_MAX_GRAPHEMES } = {}) {
  if (!Number.isInteger(maxGraphemes) || maxGraphemes < 60 || maxGraphemes > 1000) throw new TypeError("maxGraphemes must be 60-1000");
  const lead = (Array.isArray(paragraphs) ? paragraphs : []).map(cleanParagraph).filter(Boolean);
  if (!lead.length) throw new BiographyTextError("The article lead has no prose");
  const first = lead[0];
  const wholeLead = lead.join(" ");
  let excerpt = "";
  for (const sentence of sentences(first)) {
    const next = excerpt ? `${excerpt} ${sentence}` : sentence;
    if (graphemeLength(next) > maxGraphemes) break;
    excerpt = next;
  }
  let cut = "sentence";
  if (!excerpt) {
    // First sentence alone exceeds the cap: last whole word that fits,
    // without trailing punctuation, then an ellipsis.
    const words = [...new Intl.Segmenter("en", { granularity: "word" }).segment(first)];
    let built = "";
    for (const part of words) {
      const next = built + part.segment;
      if (graphemeLength(next.trimEnd()) > maxGraphemes - 1) break;
      built = next;
    }
    built = built.trimEnd().replace(/[\s,;:–—\-(\[]+$/u, "");
    if (!built) throw new BiographyTextError("The lead cannot be shortened at a word boundary");
    excerpt = `${built}…`;
    cut = "word";
  }
  if (graphemeLength(excerpt) < MIN_GRAPHEMES || !/\p{L}/u.test(excerpt)) throw new BiographyTextError("The lead is too short to describe the artist");
  return { text: excerpt, shortened: excerpt !== wholeLead, cut, graphemes: graphemeLength(excerpt), extractionVersion: EXTRACTION_VERSION };
}

function textHash(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

// Moderator-corrected display text: plain, single paragraph, bounded.
function normalizeManualText(value, { maxGraphemes = DEFAULT_MAX_GRAPHEMES } = {}) {
  if (typeof value !== "string") throw new BiographyTextError("Corrected text must be a string", "INVALID_BIOGRAPHY_COMMAND");
  const text = cleanParagraph(value);
  if (/[<>]/.test(text)) throw new BiographyTextError("Corrected text must be plain text", "INVALID_BIOGRAPHY_COMMAND");
  const length = graphemeLength(text);
  if (length < MIN_GRAPHEMES || length > maxGraphemes) {
    throw new BiographyTextError(`Corrected text must be ${MIN_GRAPHEMES}-${maxGraphemes} characters`, "INVALID_BIOGRAPHY_COMMAND");
  }
  return text;
}

module.exports = {
  BiographyTextError,
  DEFAULT_MAX_GRAPHEMES,
  EXTRACTION_VERSION,
  graphemeLength,
  leadParagraphsFromParseHtml,
  normalizeManualText,
  shortenBiography,
  textHash,
};
