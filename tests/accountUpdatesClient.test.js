const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { ClerkRuntimeError, isReverificationCancelledError } = require("../frontend/node_modules/@clerk/react/dist/errors.js");

// Exercise the real hooks/state/handlers without a live Clerk account, following
// boardDetailPage.test.js. The mocked SDK hook models its documented retry flow.
const source = fs.readFileSync(path.join(__dirname, "../frontend/src/Pages/EditProfile.jsx"), "utf8");
const helpers = source.slice(source.indexOf("const MAX_BIO_LENGTH"), source.indexOf("function getAlbumId"));
const component = source.slice(source.indexOf("export function EditProfile"), source.indexOf("  async function handleSearch"))
  .replace("export function", "function");
const renderSource = `(() => { ${helpers}\n${component}
  return { handleUsernameSubmit, handleEmailStart, handleEmailVerify, handlePasswordSubmit,
    setUsername, setNewEmail, setEmailCode, setCurrentPassword, setNewPassword,
    usernameStatus, usernameError, emailStatus, emailError, passwordStatus, passwordError,
    pendingEmailAddress, isEmailVerified, emailCode, newEmail, currentPassword, newPassword, isAccountBusy };
} return EditProfile(); })()`;
const event = { preventDefault() {} };
const clone = (value) => JSON.parse(JSON.stringify(value));
const reverifyError = { status: 403, errors: [{ code: "session_reverification_required", longMessage: "Reverification required" }] };
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const slots = [];
  let hook = 0;
  const calls = [];
  const failures = new Map();
  const prompts = [];
  const ask = deferred();
  let cancel = false;
  let hold = null;
  const invoke = async (operation, payload, result) => {
    calls.push({ operation, payload: payload && clone(payload) });
    const failure = failures.get(operation);
    if (failure) { failures.delete(operation); throw failure; }
    return typeof result === "function" ? result() : result;
  };
  const email = {
    id: "email_fixture", emailAddress: "new@example.invalid", verification: { status: "unverified" },
    prepareVerification: (params) => invoke("prepare", params, email),
    attemptVerification: (params) => invoke("verify", params, () => ({ ...email, verification: { status: "verified" } })),
  };
  const user = {
    username: "original", passwordEnabled: true,
    update: (params) => invoke(params.username ? "username" : "primary", params, user),
    createEmailAddress: (params) => invoke("create", params, email),
    updatePassword: (params) => invoke("password", params, user),
    reload: () => invoke("reload", null, user),
  };
  const context = vm.createContext({
    useNavigate: () => () => {}, useAuth: () => ({ isSignedIn: true, getToken: async () => "fixture" }),
    useUser: () => ({ user, isLoaded: true }), useEffect: () => {},
    useState(initial) {
      const index = hook++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(current) {
      const index = hook++;
      if (!(index in slots)) slots[index] = { current };
      return slots[index];
    },
    useReverification: (operation) => async (...args) => {
      try { return await operation(...args); }
      catch (error) {
        if (error.errors?.[0]?.code !== "session_reverification_required") throw error;
        prompts.push("reverification");
        ask.resolve();
        if (hold) await hold.promise;
        if (cancel) throw new ClerkRuntimeError("Cancelled", { code: "reverification_cancelled" });
        return operation(...args);
      }
    },
    isReverificationCancelledError,
  });
  const render = () => { hook = 0; return vm.runInContext(renderSource, context); };
  const page = render();
  page.setUsername("next_user"); page.setNewEmail("new@example.invalid"); page.setEmailCode("123456");
  page.setCurrentPassword("fixture-old"); page.setNewPassword("fixture-new");
  return {
    render, calls, prompts, user, email,
    fail(operation, error = reverifyError) { failures.set(operation, error); },
    cancel(value = true) { cancel = value; },
    holdPrompt() { hold = deferred(); return { reached: ask.promise, release: hold.resolve }; },
    count(operation) { return calls.filter((call) => call.operation === operation).length; },
  };
}

const actions = [
  { name: "username", operation: "username", handler: "handleUsernameSubmit", status: "usernameStatus", error: "usernameError", success: "Username updated." },
  { name: "email creation", operation: "create", handler: "handleEmailStart", status: "emailStatus", error: "emailError", success: "Check your new email for a verification code." },
  { name: "primary email", operation: "primary", handler: "handleEmailVerify", status: "emailStatus", error: "emailError", success: "Primary email updated." },
  { name: "password", operation: "password", handler: "handlePasswordSubmit", status: "passwordStatus", error: "passwordError", success: "Password updated." },
];
async function prepare(action) {
  const h = harness();
  if (action.operation === "primary") await h.render().handleEmailStart(event);
  return h;
}

for (const action of actions) {
  test(`${action.name}: recent verification succeeds without a prompt`, async () => {
    const h = await prepare(action);
    await h.render()[action.handler](event);
    assert.equal(h.count(action.operation), 1);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.render()[action.status], action.success);
    assert.equal(h.render().isAccountBusy, false);
  });
  test(`${action.name}: stale verification prompts and retries only its operation`, async () => {
    const h = await prepare(action);
    h.fail(action.operation);
    await h.render()[action.handler](event);
    assert.equal(h.prompts.length, 1);
    assert.equal(h.count(action.operation), 2);
    const attempts = h.calls.filter((call) => call.operation === action.operation);
    assert.deepEqual(attempts[0].payload, attempts[1].payload);
    assert.equal(h.render()[action.status], action.success);
    assert.equal(h.render()[action.error], "");
    if (action.operation === "primary") assert.equal(h.count("verify"), 1);
    if (action.operation === "create") assert.equal(h.count("prepare"), 1);
  });
  test(`${action.name}: cancellation leaves no success/error and releases the lock`, async () => {
    const h = await prepare(action);
    h.fail(action.operation); h.cancel();
    await h.render()[action.handler](event);
    assert.equal(h.count(action.operation), 1);
    assert.equal(h.count("reload"), 0);
    assert.equal(h.render()[action.status], "");
    assert.equal(h.render()[action.error], "");
    assert.equal(h.render().isAccountBusy, false);
    h.cancel(false);
    await h.render()[action.handler](event);
    assert.equal(h.render()[action.status], action.success);
    if (action.operation === "primary") assert.equal(h.count("verify"), 1, "cancelled promotion preserves the verified address");
  });
  test(`${action.name}: ordinary Clerk failures remain visible and are not retried`, async () => {
    const h = await prepare(action);
    h.fail(action.operation, { status: 403, errors: [{ code: "not_allowed", longMessage: "This action is disabled" }] });
    await h.render()[action.handler](event);
    assert.equal(h.count(action.operation), 1);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.render()[action.error], "This action is disabled");
    assert.equal(h.render().isAccountBusy, false);
  });
  test(`${action.name}: concurrent submits cannot create duplicate operations or prompts`, async () => {
    const h = await prepare(action);
    h.fail(action.operation);
    const prompt = h.holdPrompt();
    const page = h.render();
    const pending = page[action.handler](event);
    await page[action.handler](event); // Same render, before React could disable buttons.
    await prompt.reached;
    const busy = h.render();
    assert.equal(busy.isAccountBusy, true);
    const count = h.calls.length;
    await Promise.all(actions.map((other) => busy[other.handler](event)));
    assert.equal(h.calls.length, count, "other account actions also wait for the active verification");
    assert.equal(h.prompts.length, 1);
    prompt.release(); await pending;
    assert.equal(h.count(action.operation), 2);
    assert.equal(h.render().isAccountBusy, false);
  });
}

test("failed primary promotion can retry without replaying a consumed email code", async () => {
  const h = await prepare(actions[2]);
  h.fail("primary", new Error("Temporarily unavailable"));
  await h.render().handleEmailVerify(event);
  assert.equal(h.render().isEmailVerified, true);
  assert.equal(h.render().emailCode, "");
  await h.render().handleEmailStart(event);
  assert.equal(h.count("prepare"), 1, "a verified address cannot request another code");
  await h.render().handleEmailVerify(event);
  assert.equal(h.count("verify"), 1);
  assert.equal(h.count("primary"), 2);
  assert.equal(h.render().pendingEmailAddress, null);
});

test("failed email-code delivery reuses the created address on explicit retry", async () => {
  const h = harness();
  h.render().setNewEmail("New@example.invalid"); // Clerk may normalize the address.
  h.fail("prepare", new Error("Delivery unavailable"));
  await h.render().handleEmailStart(event);
  await h.render().handleEmailStart(event);
  assert.equal(h.count("create"), 1);
  assert.equal(h.count("prepare"), 2);
  assert.equal(h.render().emailError, "");
});

test("invalid email codes never promote an address, and a corrected code can retry", async () => {
  const h = await prepare(actions[2]);
  h.fail("verify", new Error("Invalid code"));
  await h.render().handleEmailVerify(event);
  assert.equal(h.count("primary"), 0);
  assert.equal(h.render().emailError, "Invalid code");
  h.render().setEmailCode("654321");
  await h.render().handleEmailVerify(event);
  assert.equal(h.count("primary"), 1);
});

test("incomplete verification never promotes an unverified address", async () => {
  const h = await prepare(actions[2]);
  h.email.attemptVerification = async () => h.email;
  await h.render().handleEmailVerify(event);
  assert.equal(h.count("primary"), 0);
  assert.equal(h.render().isEmailVerified, false);
  assert.match(h.render().emailError, /incomplete/);
});

test("password updates retain session revocation and clear passwords only after success", async () => {
  const h = harness();
  h.user.passwordEnabled = false;
  h.fail("password"); h.cancel();
  await h.render().handlePasswordSubmit(event);
  assert.equal(h.render().newPassword, "fixture-new");
  h.cancel(false);
  await h.render().handlePasswordSubmit(event);
  assert.deepEqual(h.calls.find((call) => call.operation === "password").payload, {
    newPassword: "fixture-new", signOutOfOtherSessions: true,
  });
  assert.equal(h.render().newPassword, "");
  assert.equal(h.render().currentPassword, "");
});
