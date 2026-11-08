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

No provider credentials, moderator allowlists, production settings, or arbitrary environment variables are accepted. Frontend processes receive only the publishable Clerk key and their paired API URL, plus a small operating-system environment allowlist. Inherited `NODE_OPTIONS`, database credentials, `VITE_*` values, feature flags, and production settings are not forwarded.

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

`create` defaults to the existing `origin/main` ref. It prints the exact source commit and creates a non-tracking `work/my-change` branch in `../rescened-worktrees/my-change`, relative to the primary checkout. It does not fetch automatically or update the primary branch. Use `--base <ref>` for an explicitly chosen local base. Existing destinations and branches are never overwritten. If a later setup step fails, the new tree is preserved; inspect it and run `setup` there.

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

Every optional provider/listening/moderation/submission feature is disabled in this initial narrow profile. No listening worker is launched. Existing workers elsewhere are not inspected, stopped, or restarted, so any independently running development worker can still affect the shared database. Worker/provider or feature-specific testing requires a separate, deliberate workflow.

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

`npm run test:worktree` is offline and uses disposable Git repositories, fake credential strings, loopback sockets, and mock API/Vite processes. It covers profile restrictions, environment isolation, idempotent setup, port collisions, safe removal, and process shutdown without connecting to MongoDB, Clerk, or a provider. Run `npm test` for the broader backend test suite; see [repository verification guidance](../AGENTS.md) for the full gate.
