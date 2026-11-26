export const SUGGESTION_CREATE_PATH = "/suggestions/new";

const SEARCH_PATH = "/search";
const RELEASE_GROUP_MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeReleaseGroupMbid(value) {
  if (typeof value !== "string") return "";
  const mbid = value.trim().toLowerCase();
  return RELEASE_GROUP_MBID.test(mbid) ? mbid : "";
}

export function buildSuggestionCreatePath(mbid) {
  const normalized = normalizeReleaseGroupMbid(mbid);
  return normalized ? `${SUGGESTION_CREATE_PATH}?mbid=${normalized}` : SUGGESTION_CREATE_PATH;
}

export function getSupportedSuggestionReturnPath(location) {
  if (location?.pathname !== SUGGESTION_CREATE_PATH) return null;
  const mbids = new URLSearchParams(location.search).getAll("mbid");
  return buildSuggestionCreatePath(mbids.length === 1 ? mbids[0] : "");
}

export function getSupportedSearchBackPath(source) {
  const queryStart = typeof source === "string" ? source.indexOf("?") : -1;
  const location = queryStart === -1 ? source : {
    pathname: source.slice(0, queryStart),
    search: source.slice(queryStart),
  };
  if (location?.pathname !== SEARCH_PATH || location.hash) return SEARCH_PATH;

  const { search } = location;
  if (typeof search !== "string" || search.length <= 1 || !search.startsWith("?") || search.includes("#")) {
    return SEARCH_PATH;
  }
  return `${SEARCH_PATH}${search}`;
}

function isCanonicalSuggestionPath(returnPath) {
  if (typeof returnPath !== "string") return false;
  const [pathname, search] = returnPath.split("?", 2);
  return getSupportedSuggestionReturnPath({ pathname, search }) === returnPath;
}

export function buildSuggestionSignInRedirectProps(returnPath) {
  if (!isCanonicalSuggestionPath(returnPath)) return {};
  return {
    forceRedirectUrl: returnPath,
    fallbackRedirectUrl: returnPath,
    signUpForceRedirectUrl: returnPath,
    signUpFallbackRedirectUrl: returnPath,
  };
}

export function buildSuggestionSignUpRedirectProps(returnPath) {
  if (!isCanonicalSuggestionPath(returnPath)) return {};
  return {
    forceRedirectUrl: returnPath,
    fallbackRedirectUrl: returnPath,
    signInForceRedirectUrl: returnPath,
    signInFallbackRedirectUrl: returnPath,
  };
}
