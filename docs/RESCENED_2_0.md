# Rescened 2.0 roadmap

A living list of feature ideas and optimizations for Rescened 2.0. Add items as they come up and refine their scope before implementation. Items here describe planned work, not shipped behavior; release scope and timing remain open.

## Suggestion drafts

**Direction:** Start with browser-local drafts, then move to server-side drafts in 2.0 so people can finish a suggestion across devices.

### Initial approach: localStorage

- Save one in-progress suggestion per signed-in user on the current browser.
- Autosave text and suggestion metadata after a short typing pause, and restore it when the user returns.
- Show “Draft saved on this device” after a successful save and provide a “Discard draft” action.
- Clear the draft only after the server confirms successful submission or the user explicitly discards it. Preserve it when submission fails.
- Include a format version and last-updated timestamp; handle malformed, outdated, or unavailable storage without breaking the form.
- Keep draft loading, saving, and clearing behind a small interface so the form can later use server storage.

This is the agreed starting approach, not a claim that local drafts are already implemented. Drafts stay on that browser/device and can be lost when site data is cleared. Uploaded files need a separate storage approach.

### 2.0: server-side drafts

- [ ] Let signed-in users resume an unfinished suggestion on another browser or device.
- [ ] Add authenticated draft loading, saving, and deletion with server-side ownership checks and validation.
- [ ] Keep drafts private and separate from submitted suggestions, moderation history, and public catalog records.
- [ ] Preserve work when saving or submitting fails; clear a draft after confirmed submission or explicit discard.
- [ ] Define how concurrent edits from multiple tabs or devices are handled.
- [ ] Decide whether to offer importing an existing local draft when server-side drafts launch.

**Open decisions:** One draft or multiple drafts per user, retention/cleanup policy, save frequency, conflict handling, and attachment support.

## Community contributions to the search evaluation dataset

**Problem:** The existing 30-query evaluation set covers exact artists, exact album titles, mixed artist/title input, and other search behaviors. Users need a way to contribute concrete examples when actual searches disappoint. This supports the [search relevance investigation](../BUGS.md) before choosing matching or ranking changes.

**Direction:** Add “Suggest a search improvement” to the results page. Accepted suggestions become reviewed search test cases. Acceptance does not immediately change rankings, create artist search entries, or publish catalog albums.

### Initial contribution and review workflow

- [ ] Let signed-in users open a form with the search query prefilled and the displayed result order captured as explicitly submitted diagnostic context. Distinguish local results from external discovery candidates.
- [ ] Ask what they expected: an artist's albums, a specific album, or an artist-plus-album match, with a short explanation and existing public album references where available. Allow a description when the expected album cannot be selected.
- [ ] Store search feedback separately from album submissions, with a public UUID, private contributor history, and a moderator queue. Reuse the existing Clerk authentication, server-side ownership/moderator checks, mutation flags, validation, rate limits, and audited, conflict-safe decision patterns.
- [ ] Let moderators classify missing catalog content, matching failures, ranking problems, ambiguous intent, and duplicate reports. Route missing albums through the existing album-suggestion workflow.
- [ ] Treat acceptance as agreement that an example belongs in the evaluation dataset. Track its later inclusion separately so an accepted report is not mistaken for a shipped search fix.

Examples include `bjork` expecting albums credited to Björk, `Daft Punk Discovery` expecting *Discovery*, and `Discovery` expecting exact titles ahead of longer partial matches. Ambiguous artist/title searches may have several valid results; one contributor's preference must not establish a universal ranking rule.

### Dataset integration and acceptance

- [ ] Start with maintainer-reviewed, manual promotion into the checked-in corpus. Each case needs a stable ID, explicit intent, relevant albums, justified preferred results where appropriate, and minimal fixture records including competing results.
- [ ] Preserve the original 30-case baseline and report community cases separately. Extend the harness to support a growing, versioned community set instead of silently changing the fixed-count assertions or comparing different datasets as equivalent.
- [ ] Keep exported fixtures free of contributor identities and private notes. Evaluations remain reproducible and offline, without live database dependencies, provider calls, or downloaded artwork.
- [ ] Verify ownership/privacy, moderation access, validation, rate limits, conflicting decisions, and the boundary between acceptance and dataset inclusion. Verify repeatable scores and version/checksum compatibility when community cases are evaluated.

The [benchmark guide](../benchmarks/README.md#initial-baseline-and-adding-cases) remains the source of truth for fixture judgments, metrics, versioning, and baseline procedures. Future search changes should be evaluated against both sets; reported submissions are diagnostic examples, not a representative production accuracy sample.

**Outside the initial scope:** Automatic ranking overrides, artist aliases/dictionaries, new public artist pages, automatic catalog imports, passive search-history collection, public voting, and automatic writes to repository fixtures from moderator actions.

**Open decisions:** Feedback status names and revision/withdrawal behavior, retention of submitted result context, duplicate grouping, and who owns promotion of accepted examples into a released dataset version.

## Other feature ideas

Add future ideas here with the user problem, proposed behavior, and any open questions.

## Optimizations

Add optimization candidates here with the observed problem, affected area, and how improvement will be measured.
