# Frontend typography

## Current fonts

| Token | Value | Used for |
| --- | --- | --- |
| `--app-font` | `"Fragment Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace` | Body text, navigation, lists, forms: nearly all UI text |
| `--app-display-font` | `"Avenir Next Condensed", "Helvetica Neue", Arial, sans-serif` | A few display headings (album detail, patch notes) |

Both tokens are defined on `:root` at the top of `frontend/src/App.css`. Component CSS should reference `var(--app-font)` rather than repeating a font stack.

Fragment Mono (SIL Open Font License 1.1) is self-hosted through the `@fontsource/fragment-mono` npm package and imported in `frontend/src/main.jsx` (`400.css` and `400-italic.css`). No request goes to Google Fonts or any other third-party font host.

Fragment Mono ships only a regular (400) weight and its italic. Rules that ask for `font-weight: 500` or `600` render as regular, or as browser-synthesized bold where the weight reaches bold. Prefer size, case, letter-spacing, or color over weight for emphasis.

## Previous monospace font (before 2026-09-30)

Before the 2.0 frontend redesign the app used the platform's system monospace, with no web font:

```css
--app-font: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
```

That resolves to SF Mono on macOS and iOS, Consolas on Windows, and the default monospace elsewhere. Twelve rules in `App.css` repeated this stack inline, and one used the shorthand `font: 0.58rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;`. All of them now use `var(--app-font)`, so the token is the only place to change.

## Reverting to the system monospace

1. In `frontend/src/App.css`, set `--app-font` back to the previous value above.
2. In `frontend/src/main.jsx`, remove the two `@fontsource/fragment-mono` imports.
3. From `frontend/`, run `npm uninstall @fontsource/fragment-mono` so both `package.json` and `package-lock.json` drop it.
4. Run `npm --prefix frontend run lint` and `npm --prefix frontend run build`.
