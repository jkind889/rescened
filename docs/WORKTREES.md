# Short-lived worktrees with a shared development database

Use one approved development database across worktrees. Creating/removing a tree changes local Git files and port metadata only: it never creates, copies, resets, seeds, migrates, or deletes a database. Schema experiments and destructive tests need a separately authorized disposable database, not this workflow.

The implementation uses built-in Node APIs. Node 22 or later and Git are required. Root and frontend dependencies remain separate installs with their existing lockfiles.

## One-time development profile

Before connecting an app, verify the intended MongoDB database, the database user's roles, replica-set/transaction support, and a dedicated Clerk development instance/test account. A URI's database name is not proof of least privilege. The Mongo user must have `readWrite` only on the named development database, not production or `readWriteAnyDatabase`. Transactional application flows require a replica set or sharded deployment.

`config/worktrees/shared-development.example.json` is a placeholder template, not a working credential file. After the necessary credential/access approval, configure one private JSON profile outside **all** repository checkouts, for example `~/.config/rescened/shared-development.json`, with file permissions `0600`. Do not copy an existing `.env` wholesale, put credentials in a command line, commit them, or make a frontend env file from server settings. This helper does not create, copy, save, discover, or modify credentials.

The profile accepts only:

- `environment: "shared-development"`.
- `database`: `rescened_dev` or a name beginning `rescened_dev_` with lowercase alphanumeric suffixes separated by underscores.
- `mongoHost`: the exact development host, including a port when present in the URI.
- `server.MONGO_URI`: one `mongodb://` or `mongodb+srv://` URI with the exact pinned host and database. Atlas SRV and single-host local replica-set URIs are supported. Multi-host seed lists are not supported by this first version. Supported options are `retryWrites`, `w`, `authSource`, `replicaSet`, `appName`, and `tls=true`; insecure TLS options are rejected.
- `server.CLERK_SECRET_KEY` and `server.CLERK_PUBLISHABLE_KEY`: matching test-instance keys (`sk_test_` / `pk_test_`), never live keys. Matching the same Clerk instance must be verified by the operator.
- Optional `preview.listeningPilotUserIds`: an array of approved Clerk development/test user IDs. A nonempty list enables `LISTENING_DETECTION_ENABLED` and supplies `LASTFM_PILOT_USER_IDS` for only those accounts.
- Optional `preview.moderatorUserIds`: an array of approved Clerk development/test moderator IDs. A nonempty list supplies `MODERATOR_USER_IDS` and enables `COMMUNITY_MODERATION_ENABLED`, `ALBUM_MAPPING_MODERATION_ENABLED`, and `TRACKLIST_BASELINE_MODERATION_ENABLED` together. This allows actual moderation commands, not just queue viewing.

Replace `user_REPLACE` in the example with an approved test user ID in the private profile only. Each list accepts at most 100 unique `user_` IDs with an alphanumeric suffix, up to 128 characters total, without whitespace or wildcards. The two lists are independent: an account can be a detection pilot without being a moderator, or vice versa. Use `[]` or omit a list to disable its feature group. Older profiles with no `preview` object retain all features disabled. These local validations cannot prove which Clerk instance owns an ID; the operator must verify that the account belongs to the configured development instance.

No provider credentials, production settings, arbitrary feature switches, or other environment variables are accepted. User allowlists remain server-only and are not logged. Frontend processes receive only the publishable Clerk key and their paired API URL, plus a small operating-system environment allowlist. Inherited `NODE_OPTIONS`, database credentials, `VITE_*` values, user allowlists, feature flags, and production settings are not forwarded.

This is a shared **writable development** database, not read-only mode. Ordinary app actions and API startup's model/index initialization can write to it. Other worktrees see those changes immediately. Use a development-only account and deliberate test data. Removing a worktree never undoes its database changes.

## Create, enroll, and install

Once this helper is in the base branch:

```sh
# In the main repository checkout. Fetching updates refs, not the checkout.
git fetch origin main
npm run worktree -- create my-change
cd ../rescened-worktrees/my-change
npm ci
npm --prefix frontend ci
```

`create` uses an explicit `--base <ref>` first, then the repository-local `rescened.worktreeBase` setting, otherwise the existing `origin/main` ref. It prints the exact source commit and creates a non-tracking `work/my-change` branch in `../rescened-worktrees/my-change`, relative to the primary checkout. It does not fetch automatically or update the primary branch. An invalid configured base fails instead of silently falling back. Existing destinations and branches are never overwritten. If a later setup step fails, the new tree is preserved; inspect it and run `setup` there.

To make a committed setup branch the basis for new trees before it is merged:

```sh
git config --local rescened.worktreeBase refs/heads/chore/reusable-worktree-setup
git config --local --get rescened.worktreeBase
```

This setting is shared by the linked worktrees of this local repository, contains no credentials, and changes only this helper's creation default. New helper-created trees inherit the setup branch's committed files; uncommitted edits are never copied. It does not change another checkout, set an upstream, or change removal's default merge check against `origin/main`. A persistent branch base will not pick up later `main` changes automatically. Once the setup commits are merged into `main`, fetch the reviewed base and remove this temporary setting to resume creating from current `origin/main`:

```sh
git config --local --unset-all rescened.worktreeBase
```

Direct `git worktree add` and editor/Codex worktree creation do not consult this helper setting. Choose the configured ref explicitly in those workflows, then run `setup` in the resulting tree. The repository's `AGENTS.md` records this convention, but it cannot intercept arbitrary worktree creation. A reviewed merge into the normal base branch is still needed to make these files available by default to other clones, machines, and tools that use `main`. Do not push or merge merely to enforce this convention without the user's authorization.

For a linked worktree already created by Codex or `git worktree add`, run:

```sh
npm run worktree -- setup
```

Setup is idempotent. It reserves an available API/frontend pair in the ranges 3100–3199 and 5200–5299. State is stored under the repository's common Git directory, outside tracked files; no `.env` is generated. All enrolled trees share that reservation registry. Busy loopback ports are skipped. No servers, workers, installs, or database connections start during create/setup.

Before the helper is merged into your base branch, use the absolute path to `scripts/worktree.cjs` in the implementation checkout from your desired working directory, rather than `npm run worktree`. The commands inspect the current working directory, not the helper's directory. `create` does not copy uncommitted helper files into a new tree.

## Run one paired app

```sh
npm run worktree -- start --profile "$HOME/.config/rescened/shared-development.json"
```

The command runs in the foreground. It starts only the API and Vite, bound to `127.0.0.1`, using the printed ports. Vite uses `--strictPort`, the frontend API URL points to the matching API, and CORS permits that exact frontend origin. Use the printed `127.0.0.1` URL, not a different localhost origin. Verify that your Clerk development setup accepts that origin; the helper never changes Clerk settings.

Only detection and moderation are enabled by the profile's explicit user allowlists. Last.fm connection, sync, discovery and deep sweep, automatic diary publication, provider/tracklist enrichment, contributor editions, community submissions, and all other optional feature flags remain off. The helper offers no switch to enable them, except the artist pages switch below. No listening worker is launched. Existing workers elsewhere are not inspected, stopped, or restarted, so any independently running development worker can still affect the shared database.

### Artist pages preview

```sh
npm run worktree -- start --profile "$HOME/.config/rescened/shared-development.json" --artist-pages
```

`--artist-pages` is the only switch for an optional flag. It is per run, and the profile cannot set it. It sets `ARTIST_PAGES_ENABLED=true` for the API only. With it, the API wrapper (`scripts/worktree-server.cjs`):

1. turns off Mongoose automatic collection and index creation for every model, before any model loads and on connect;
2. checks that the connected database name equals the profile's `database`, and stops before any write if it does not;
3. ensures only `albumcatalogs` index `artistCredits.artistId_1` (sparse, non-unique). An existing matching index is reused. A conflicting index stops startup and is never dropped or changed.

The log says whether the index was created or already present. Because automatic initialization is off, this run relies on the collections and indexes that already exist in the development database, including those for moderation features. Without the switch, startup behaves as before and `ARTIST_PAGES_ENABLED` is forced to `false`. See [artist pages](ARTIST_IDENTITY.md#artist-pages-prototype).

Detection access does not ingest plays, run detection jobs, or publish new diary listens. Its view requires an existing active/paused Last.fm connection and stored detection records for the approved test account; without those, the view can be empty. Changing a connected account's time zone still writes shared connection state and queues detection work. Automatic diary opt-in, confirmation and publication stay disabled. Ordinary app actions, including manually recording a listen, are not made read-only by these flags.

Moderators can review stored queues and perform submission, album-mapping, and tracklist-baseline decisions. Approvals/revocations can change the shared catalog, mappings, baselines and audit history, and enqueue reprocessing/discovery jobs for an independently running worker. Disabling provider flags in this API does not stop that worker. Tracklist candidate discovery/refresh that requires provider enrichment remains unavailable; existing candidate snapshots may still be reviewed. Use deliberate shared-dev fixtures, and do not approve real records merely to test the setup.

Editing a private profile does not reconfigure an already running preview. Stop its owning terminal with Ctrl+C, then run the same start command to apply the new profile. Startup can initialize listening/baseline indexes when their flags are enabled. Profile changes do not authorize a database copy, production access, seed, reset, or worker launch. Any production-to-development data refresh is a separate, reviewed operation.

The launcher refuses existing root/frontend `.env` variants, rather than letting dotenv or Vite silently load different settings. It never overwrites those files. Preserve and move them yourself if enrolling an older tree. `.env*` files are ignored by Git except explicit example/sample/template files, but ignored does not mean safe to delete.

After startup, open the printed API's `/health`; it must report `status: "ok"`. A listening port or a successful setup is not proof of database health. The helper does not claim to have verified roles, transaction support, or authentication.

**Ctrl+C stops this invocation's two child processes.** If either exits, the other is stopped too. There is no global `pkill`, kill-by-port, saved-PID stop, or worker shutdown. Child handles belong to the foreground supervisor; it waits for both children before releasing the run marker. A hung child gets SIGKILL after a five-second grace period.

```sh
npm run worktree -- status
```

Status prints the assigned ports and whether a run marker exists. A marker is not a liveness check. A hard crash can leave a marker or registry lock behind; cleanup fails closed. Inspect the exact owning terminal/process, its command and working directory, and both ports before manually removing stale metadata. Never kill a process just because its PID appears in an old marker. Do not delete another tree's reservation.

Port availability is checked at setup and again at launch. Reservations coordinate this helper, not unrelated applications. An external process can still take a port between the check and bind; the app then fails rather than taking an alternate port or killing the occupant.

## Finish and remove

1. Stop the paired apps with Ctrl+C in their owning terminal.
2. Commit/preserve work and merge it through the normal review process. Refresh the chosen base ref.
3. From a different checkout, explicitly remove the finished tree:

```sh
npm run worktree -- remove /absolute/path/to/rescened-worktrees/my-change
# If only generated package/build files remain:
npm run worktree -- remove /absolute/path/to/rescened-worktrees/my-change --discard-generated
```

Removal requires an enrolled linked worktree in the same repository, no run marker, both reserved ports free, no tracked/untracked changes, and HEAD contained in `origin/main` (or `--base <ref>`). Ignored user files such as `.env`, reports, datasets, or notes block removal too. Only ignored `node_modules/`, `frontend/node_modules/`, `dist/`, and `frontend/dist/` may be discarded, and only with the explicit flag. Git's normal non-force safety check still applies. No branch deletion, force removal, global pruning, or database operation occurs.

Squash/rebase merges may not preserve commit ancestry. The conservative check can therefore refuse an already-merged tree; review that case manually rather than forcing deletion. The original branch stays available even after a successful removal. Automatic delete-on-chat-close is intentionally not enabled because unfinished files and merge status need this check.

## Verification

`npm run test:worktree` is offline and uses disposable Git repositories, fake credential strings, loopback sockets, and mock API/Vite processes. It covers profile restrictions, the artist pages switch and its guarded database setup (with stubs), independent user scopes, detection access for approved/unapproved users, disabled ingestion/publication flags, frontend isolation, configured/explicit creation bases, idempotent setup, port collisions, safe removal, and process shutdown without connecting to MongoDB, Clerk, or a provider. Run `npm test` for the broader backend test suite; see [repository verification guidance](../AGENTS.md) for the full gate. A read-only UI check can verify signed-in queue access and existing detections after an approved restart; do not perform a moderation command, time-zone update, or diary mutation unless that specific shared-dev test is authorized.
