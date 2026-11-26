export const SUGGESTION_CREATE_PATH = "/suggestions/new";

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
