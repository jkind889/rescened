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

## Other feature ideas

Add future ideas here with the user problem, proposed behavior, and any open questions.

## Optimizations

Add optimization candidates here with the observed problem, affected area, and how improvement will be measured.
