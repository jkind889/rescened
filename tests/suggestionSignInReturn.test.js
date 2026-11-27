const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const frontend = path.join(__dirname, '../frontend/src');
const helpers = import('../frontend/src/features/community/suggestionReturn.js');
const mbid = '83096042-3785-481e-8843-dee69f1aad12';
const createPath = '/suggestions/new';
const albumPath = `${createPath}?mbid=${mbid}`;
const otherPaths = [
  '/', '/notifications', '/viewreviews', '/moderation/album-suggestions', '/account/edit',
  '/suggestions', '/suggestions/123/revise', '/suggestions/new/', '/suggestions/new/extra',
  '//evil.com', 'https://evil.com/suggestions/new', '/suggestions/%2e%2e/suggestions/new',
  '/suggestions/new%2f..', '/suggestions/../suggestions/new', '/Suggestions/new',
];

test('release-group MBIDs must match the provider UUID shape', async () => {
  const { normalizeReleaseGroupMbid, buildSuggestionCreatePath, SUGGESTION_CREATE_PATH } = await helpers;
  assert.equal(SUGGESTION_CREATE_PATH, createPath);
  for (const value of [mbid, mbid.toUpperCase(), ` \t${mbid} \n`]) {
    assert.equal(normalizeReleaseGroupMbid(value), mbid);
    assert.equal(buildSuggestionCreatePath(value), albumPath);
  }
  for (const value of [null, undefined, 123, [mbid], {}, '', 'wrong', 'https://evil.com', `${mbid}&next=//evil.com`, `${mbid}#extra`]) {
    assert.equal(normalizeReleaseGroupMbid(value), '', String(value));
    assert.equal(buildSuggestionCreatePath(value), createPath, String(value));
  }
});

test('suggestion auth return keeps only one valid MBID and drops the hash', async () => {
  const { getSupportedSuggestionReturnPath } = await helpers;
  for (const search of [
    `?mbid=${mbid}`,
    `?mbid=%20${mbid.toUpperCase()}%20&next=https://evil.com&redirect=%2Faccount%2Fedit`,
  ]) {
    assert.equal(getSupportedSuggestionReturnPath({ pathname: createPath, search, hash: '#untrusted' }), albumPath);
  }
  for (const search of [
    undefined, '', '?mbid=', '?mbid=not-a-uuid', '?mbid=%2F%2Fevil.com', '?redirect=https://evil.com',
    `?mbid=${mbid}&mbid=${mbid}`, `?mbid=invalid&mbid=${mbid}`, `?mbid=${mbid}&mbid=`,
  ]) {
    assert.equal(getSupportedSuggestionReturnPath({ pathname: createPath, search, hash: '#untrusted' }), createPath, search);
  }
});

test('only the exact suggestion creation pathname is eligible', async () => {
  const { getSupportedSuggestionReturnPath } = await helpers;
  assert.equal(getSupportedSuggestionReturnPath(null), null);
  for (const pathname of otherPaths) {
    assert.equal(getSupportedSuggestionReturnPath({ pathname, search: `?mbid=${mbid}` }), null, pathname);
  }
});

test('the search back link keeps the query only for the exact search route', async () => {
  const { getSupportedSearchBackPath } = await helpers;
  const search = '?q=album&view=list';
  for (const source of [
    '/search' + search,
    { pathname: '/search', search },
    { pathname: '/search', search, hash: '' },
  ]) {
    assert.equal(getSupportedSearchBackPath(source), '/search' + search);
  }
  assert.equal(getSupportedSearchBackPath('/search?q=Rock+%26+Roll%23live&extra=a?b'), '/search?q=Rock+%26+Roll%23live&extra=a?b');

  for (const source of [
    '/search', '/search?', '/search/#extra', '/search#extra', '/search' + search + '#extra',
    '/search/' + search, '/searching' + search, '/other/../search' + search,
    '/other/%2e%2e/search' + search, '/%73earch' + search,
    '//evil.com/search' + search, 'https://evil.com/search' + search, 'search' + search,
    '/suggestions/new' + search, '/notifications' + search,
    null, undefined, 123, ['/search' + search], {},
    { pathname: '/search', search: ['?q=album'] },
    { pathname: '/search', search: 'q=album' },
    { pathname: '/search', search, hash: '#extra' },
    { pathname: '/search', search: search + '#extra' },
    { pathname: '/search/', search },
    { pathname: 'https://evil.com/search', search },
  ]) {
    assert.equal(getSupportedSearchBackPath(source), '/search', JSON.stringify(source));
  }
});

test('Clerk redirect props use the canonical destination for both auth outcomes', async () => {
  const { buildSuggestionSignInRedirectProps, buildSuggestionSignUpRedirectProps } = await helpers;
  for (const target of [createPath, albumPath]) {
    assert.deepEqual(buildSuggestionSignInRedirectProps(target), {
      forceRedirectUrl: target, fallbackRedirectUrl: target,
      signUpForceRedirectUrl: target, signUpFallbackRedirectUrl: target,
    });
    assert.deepEqual(buildSuggestionSignUpRedirectProps(target), {
      forceRedirectUrl: target, fallbackRedirectUrl: target,
      signInForceRedirectUrl: target, signInFallbackRedirectUrl: target,
    });
  }
  for (const target of [
    null, undefined, {}, ...otherPaths, `${createPath}?`, `${createPath}#x`,
    `${createPath}?mbid=${mbid.toUpperCase()}`, `${createPath}?mbid=invalid`,
    `${albumPath}&mbid=${mbid}`, `${albumPath}&next=//evil.com`, `${albumPath}?mbid=${mbid}`,
    `${albumPath}&backToSearch=%2Fsearch%3Fq%3Dalbum`, '/search?q=album&view=list',
  ]) {
    assert.deepEqual(buildSuggestionSignInRedirectProps(target), {}, String(target));
    assert.deepEqual(buildSuggestionSignUpRedirectProps(target), {}, String(target));
  }
});

test('only the new-suggestion route opts in and external cards use ordinary links', () => {
  const app = fs.readFileSync(path.join(frontend, 'App.jsx'), 'utf8');
  const card = fs.readFileSync(path.join(frontend, 'Components/ExternalAlbumCard.jsx'), 'utf8');
  assert.equal(app.match(/\bpreserveSuggestionReturn\b/g)?.length, 1);
  assert.match(app, /<Route path="\/suggestions\/new" element=\{\s*<ProtectedRoute preserveSuggestionReturn>/);
  assert.doesNotMatch(card, /@clerk\/react/);
  assert.match(card, /<Link className="external-album-suggest" to=\{suggestionUrl\} state=\{suggestionState\}>\s*Suggest this album/);
});
