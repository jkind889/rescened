# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## Authoring patch notes

The public patch notes page is available at `/patch-notes` from the navbar. Add entries to [`src/content/patchNotes.json`](src/content/patchNotes.json), which must remain an array of objects with this shape:

```json
{
  "id": "stable-kebab-case-id",
  "date": "2026-09-28",
  "title": "Short user-facing title",
  "summary": "One-sentence summary for the patch notes page.",
  "changes": ["Plain-language change description"]
}
```

Use a unique, stable kebab-case `id`, a timezone-independent `YYYY-MM-DD` date, and a nonempty array of plain-string `changes`. Keep entries sorted newest date first; entries with the same date keep their array order, so prepend a new entry. Add one user-facing summary per PR as it lands on `main`, preferably in the PR that ships the change, and verify the date when it merges. Preserve older entries and IDs. Updates deploy with the frontend; there is no automatic GitHub sync or in-browser authoring.
