# Review composer

Album pages open **Write review** inline above the review lists. The same composer is available on the full album-review feed and from the home page's review shortcut. It uses the existing inline-edit form styling and shows a live review-card preview. The preview is local draft content, not a review record; only **Post review** calls the creation API.

- Ratings remain required, from 1 to 5 in half steps. Review text is required and limited to 300 characters, with a visible counter.
- Opening or returning to the composer scrolls it into view and focuses the rating field. **Close** returns focus to the triggering action and keeps the draft. There is no overlay or focus trap.
- Drafts are stored in session storage, separately for each signed-in user and album. They survive closing, route navigation and refresh in the same tab, and are cleared after confirmed submission. If browser storage is unavailable, the in-memory draft still survives closing on the current page.
- Pending submissions disable editing and closing. The request payload and idempotency key are saved before sending. An uncertain failure keeps those exact values for manual retry, including after navigation or refresh. A definite rejection on the first attempt unlocks the draft; a later rejection cannot disprove an earlier uncertain write and retains the original request.
- Errors appear once, inside the composer. Successful publication closes it, announces success, updates the review feed, and reconciles community totals on a recovered response.
- Signed-out viewers still use the existing sign-in action. New reviews remain independent of listening-diary entries and boards. Editing existing reviews remains inline.

## Verification

Run `node --test tests/reviewDraftsClient.test.js`, frontend lint/build, and the catalog contract check for this album-bearing surface. Browser checks should cover preview-before-publication, half ratings, the text limit, close/reopen, navigation/refresh, home shortcuts, auth changes, failed requests/retry and narrow viewports. Use fixture responses for publication tests rather than posting a test review to a real account.
