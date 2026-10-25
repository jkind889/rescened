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

test("album tabs include genres independently of the optional ranking tab", () => {
    assert.deepEqual(Array.from(tabs().albumTabs), ["artist", "release", "format", "tracks", "ranking", "genres"]);
    assert.deepEqual(Array.from(tabs({ tracks: [], genresEnabled: false }).albumTabs), ["artist", "release", "format", "tracks"]);
    assert.equal(tabs({ tracks: [] }).albumTabs.at(-1), "genres");
});

test("a removed album section falls back to the artist tab", () => {
    assert.equal(tabs({ activeTab: "genres", genresEnabled: false }).selectedTab, "artist");
    assert.equal(tabs({ activeTab: "ranking", tracks: [] }).selectedTab, "artist");
});

test("arrow keys activate and focus adjacent tabs with wraparound", () => {
    for (const [activeTab, key, expected] of [["artist", "ArrowRight", "release"], ["artist", "ArrowLeft", "genres"], ["genres", "ArrowRight", "artist"], ["genres", "ArrowLeft", "ranking"]]) {
        assert.deepEqual(tabs({ activeTab }).press(key), { activated: expected, focused: expected, prevented: true });
    }
});

test("Home and End focus the first and last available tab", () => {
    assert.equal(tabs({ activeTab: "genres" }).press("Home").focused, "artist");
    assert.equal(tabs().press("End").focused, "genres");
    assert.equal(tabs({ genresEnabled: false, tracks: [] }).press("End").focused, "tracks");
});

test("Tab and ordinary keys retain native focus behavior", () => {
    for (const key of ["Tab", "Enter", " ", "a"]) {
        assert.deepEqual(tabs().press(key), { activated: null, focused: null, prevented: false });
    }
});
