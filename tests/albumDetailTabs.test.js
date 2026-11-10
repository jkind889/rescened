const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

// Exercise the page's actual tab handler; rendered QA covers the JSX and focus.
const source = fs.readFileSync(path.join(__dirname, "../frontend/src/Components/AlbumDetail.jsx"), "utf8");
const tabSource = source.slice(source.indexOf("    const albumTabs ="), source.indexOf("    const hasMultipleDiscs ="));

function tabs({ activeTab = "artist", genresEnabled = true, tracks = [{}] } = {}) {
    const result = { activated: null, focused: null, prevented: false };
    const context = { activeTab, genresEnabled, sortedTracks: tracks, setActiveTab: (value) => { result.activated = value; } };
    const page = vm.runInNewContext(`(() => { ${tabSource}; return { albumTabs, selectedTab, handleTabKeyDown }; })()`, context);
    return {
        ...page,
        press(key) {
            page.handleTabKeyDown({
                key,
                preventDefault: () => { result.prevented = true; },
                currentTarget: { parentElement: { querySelectorAll: () => page.albumTabs.map((tab) => ({ focus: () => { result.focused = tab; } })) } },
            });
            return result;
        },
    };
}

test("album tabs leave genres in the header and retain the optional ranking tab", () => {
    assert.deepEqual(Array.from(tabs().albumTabs), ["artist", "release", "format", "tracks", "ranking"]);
    assert.deepEqual(Array.from(tabs({ tracks: [], genresEnabled: false }).albumTabs), ["artist", "release", "format", "tracks"]);
    assert.equal(tabs({ tracks: [] }).albumTabs.at(-1), "tracks");
});

test("a removed album section falls back to the artist tab", () => {
    assert.equal(tabs({ activeTab: "genres", genresEnabled: false }).selectedTab, "artist");
    assert.equal(tabs({ activeTab: "ranking", tracks: [] }).selectedTab, "artist");
});

test("arrow keys activate and focus adjacent tabs with wraparound", () => {
    for (const [activeTab, key, expected] of [["artist", "ArrowRight", "release"], ["artist", "ArrowLeft", "ranking"], ["ranking", "ArrowRight", "artist"], ["ranking", "ArrowLeft", "tracks"]]) {
        assert.deepEqual(tabs({ activeTab }).press(key), { activated: expected, focused: expected, prevented: true });
    }
});

test("Home and End focus the first and last available tab", () => {
    assert.equal(tabs({ activeTab: "ranking" }).press("Home").focused, "artist");
    assert.equal(tabs().press("End").focused, "ranking");
    assert.equal(tabs({ genresEnabled: false, tracks: [] }).press("End").focused, "tracks");
});

test("Tab and ordinary keys retain native focus behavior", () => {
    for (const key of ["Tab", "Enter", " ", "a"]) {
        assert.deepEqual(tabs().press(key), { activated: null, focused: null, prevented: false });
    }
});

// Keep the genre metadata independent of the selected tab and reviews route.
// Browser QA exercises the rendered links, sign-in prompt, and notice states.
const headerSource = source.slice(source.indexOf('<div className="album-title-block">'), source.indexOf('<div className="album-tabs"'));

test("genre metadata lives in the album header rather than a conditional tab panel", () => {
    assert.match(headerSource, /genresEnabled &&/);
    assert.match(headerSource, /aria-labelledby="album-genres-heading"/);
    assert.match(headerSource, /album\.genres\.map/);
    assert.doesNotMatch(headerSource, /selectedTab|isReviewsRoute/);
    assert.doesNotMatch(source, /selectedTab === "genres"/);
    assert.match(source, /const genresEnabled = Array\.isArray\(album\?\.genres\)/);
});

test("genre links retain catalog order, browse destinations, and an accessible primary label", () => {
    assert.match(headerSource, /album\.genres\.map\(\(genre, index\)/);
    assert.ok(headerSource.includes('to={`/genre/${genre.slug}`}'));
    assert.ok(headerSource.includes('aria-label={index === 0 ? `${genre.name} (primary genre)` : undefined}'));
    assert.match(headerSource, /No genres yet\./);
});

test("the header retains suggestion, signed-out, pending, and revision entry points", () => {
    assert.match(headerSource, /!openGenreSuggestion && \(canUseAuthenticatedActions/);
    assert.ok(headerSource.includes('to={`/suggestions/genres/${album.albumId}`}'));
    assert.match(headerSource, /<SignInButton mode="modal">/);
    assert.ok(headerSource.includes('openGenreSuggestion.status === "needs_changes"'));
    assert.ok(headerSource.includes('to={`/suggestions/${openGenreSuggestion.submissionId}/revise`}'));
    assert.ok(headerSource.includes('to={`/suggestions/${openGenreSuggestion.submissionId}`}'));
});
