const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../frontend/src/Components/AlbumMoreActions.jsx"), "utf8");
const handlers = source.slice(source.indexOf("export default function"), source.indexOf("\n    return ("))
    .replace("export default ", "") + "return { closeOnEscape, closeOnBlur, closeAndFocus }; }";

function disclosure() {
    let focused = false;
    let cleanup;
    const listeners = new Map();
    const inside = {};
    const details = { open: true, contains: (target) => target === inside, querySelector: () => ({ focus: () => { focused = true; } }) };
    const context = {
        useRef: () => ({ current: details }),
        useEffect: (effect) => { cleanup = effect(); },
        document: {
            addEventListener: (type, listener) => listeners.set(type, listener),
            removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); },
        },
    };
    const component = vm.runInNewContext(`${handlers}\nAlbumMoreActions({});`, context);
    return { ...component, details, inside, listeners, cleanup, focused: () => focused };
}

test("Escape closes More and restores focus to its trigger", () => {
    const menu = disclosure();
    let prevented = false;
    let stopped = false;
    menu.closeOnEscape({ key: "Escape", currentTarget: menu.details, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
    assert.equal(menu.details.open, false);
    assert.equal(menu.focused(), true);
    assert.equal(prevented && stopped, true);
});

test("ordinary keys and Escape on a closed disclosure retain native behavior", () => {
    const menu = disclosure();
    for (const key of ["Tab", "Enter", " "]) menu.closeOnEscape({ key, currentTarget: menu.details });
    assert.equal(menu.details.open, true);
    menu.details.open = false;
    menu.closeOnEscape({ key: "Escape", currentTarget: menu.details });
    assert.equal(menu.focused(), false);
});

test("focus can move within More; leaving closes it without stealing focus", () => {
    const menu = disclosure();
    menu.closeOnBlur({ currentTarget: menu.details, relatedTarget: menu.inside });
    assert.equal(menu.details.open, true);
    menu.closeOnBlur({ currentTarget: menu.details, relatedTarget: {} });
    assert.equal(menu.details.open, false);
    assert.equal(menu.focused(), false);
});

test("temporary focus loss to a native share sheet does not dismiss More", () => {
    const menu = disclosure();
    menu.closeOnBlur({ currentTarget: menu.details, relatedTarget: null });
    assert.equal(menu.details.open, true);
});

test("a dialog action can close More and set a visible focus return target", () => {
    const menu = disclosure();
    menu.closeAndFocus({ currentTarget: { closest: () => menu.details } });
    assert.equal(menu.details.open, false);
    assert.equal(menu.focused(), true);
});

test("outside pointers dismiss More and unmount removes its listener", () => {
    const menu = disclosure();
    menu.listeners.get("pointerdown")({ target: menu.inside });
    assert.equal(menu.details.open, true);
    menu.listeners.get("pointerdown")({ target: {} });
    assert.equal(menu.details.open, false);
    assert.equal(menu.focused(), false);
    menu.cleanup();
    assert.equal(menu.listeners.size, 0);
});
