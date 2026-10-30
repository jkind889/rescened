const assert = require("node:assert/strict");
const test = require("node:test");

const clerkPath = require.resolve("@clerk/express");
const rateLimitPath = require.resolve("../routes/utils/rateLimit");
const routePaths = {
  boards: require.resolve("../routes/boards"),
  dataExport: require.resolve("../routes/dataExport"),
  likes: require.resolve("../routes/likes"),
  notifications: require.resolve("../routes/notifications"),
  profile: require.resolve("../routes/profile"),
  reviews: require.resolve("../routes/reviews"),
  search: require.resolve("../routes/search"),
  trackRankings: require.resolve("../routes/trackRankings"),
};

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function routeLayer(router, method, path) {
  const layer = router.stack.find(
    (item) => item.route?.path === path && item.route.methods[method],
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} should be registered`);
  return layer;
}

async function callRoute(router, method, path, req = {}) {
  const res = response();
  const handlers = routeLayer(router, method, path).route.stack.map((layer) => layer.handle);

  for (const handler of handlers) {
    let nextCalled = false;
    await handler(req, res, () => {
      nextCalled = true;
    });
    if (!nextCalled) break;
  }

  return { status: res.statusCode, headers: res.headers, body: res.body };
}

function installBlockedRoutes(initialUserId = "user_rate_limit_test") {
  let userId = initialUserId;
  const calls = {
    albumSave: 0,
    boardMutation: 0,
    dataExport: 0,
    likeMutation: 0,
    notificationMutation: 0,
    profileStats: 0,
    queueMutation: 0,
    reviewCreate: 0,
    reviewMutation: 0,
    search: 0,
    trackRankingMutation: 0,
  };

  function blocker(name, retryAfterSeconds) {
    return (req, res) => {
      calls[name] += 1;
      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        error: `Rate limited by ${name}`,
        code: "RATE_LIMITED",
        retryAfterSeconds,
      });
    };
  }

  const limiters = {
    diaryMutationRateLimit: (req, res, next) => next(),
    albumSaveRateLimit: blocker("albumSave", 51),
    boardMutationRateLimit: blocker("boardMutation", 60),
    dataExportRateLimit: blocker("dataExport", 61),
    externalSearchRateLimit: (req, res, next) => next(),
    likeMutationRateLimit: blocker("likeMutation", 52),
    notificationMutationRateLimit: blocker("notificationMutation", 59),
    profileStatsRateLimit: blocker("profileStats", 57),
    queueMutationRateLimit: blocker("queueMutation", 58),
    reviewCreateRateLimit: blocker("reviewCreate", 53),
    reviewMutationRateLimit: blocker("reviewMutation", 54),
    searchRateLimit: blocker("search", 55),
    trackRankingMutationRateLimit: blocker("trackRankingMutation", 56),
  };

  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: {
      clerkClient: { users: { getUserList: async () => ({ data: [] }) } },
      getAuth: () => ({ userId }),
    },
  };
  require.cache[rateLimitPath] = {
    id: rateLimitPath,
    filename: rateLimitPath,
    loaded: true,
    exports: limiters,
  };

  Object.values(routePaths).forEach((path) => delete require.cache[path]);

  return {
    calls,
    limiters,
    routers: {
      boards: require("../routes/boards"),
      dataExport: require("../routes/dataExport"),
      likes: require("../routes/likes"),
      notifications: require("../routes/notifications"),
      profile: require("../routes/profile"),
      reviews: require("../routes/reviews"),
      search: require("../routes/search"),
      trackRankings: require("../routes/trackRankings"),
    },
    setUserId(value) {
      userId = value;
    },
  };
}

// The export route answers 503 before authentication while its flag is off.
const previousDataExportFlag = process.env.DATA_EXPORT_ENABLED;
test.beforeEach(() => {
  process.env.DATA_EXPORT_ENABLED = "true";
});

test.afterEach(() => {
  if (previousDataExportFlag === undefined) delete process.env.DATA_EXPORT_ENABLED;
  else process.env.DATA_EXPORT_ENABLED = previousDataExportFlag;
  Object.values(routePaths).forEach((path) => delete require.cache[path]);
  delete require.cache[clerkPath];
  delete require.cache[rateLimitPath];
});

test("rate limit middleware emits the stable 429 payload and Retry-After header", async () => {
  delete require.cache[rateLimitPath];
  const {
    createRateLimitMiddleware,
    createRateLimiter,
  } = require("../routes/utils/rateLimit");
  const limiter = createRateLimiter({
    keyPrefix: `test:route-rate-limit:${Date.now()}`,
    points: 1,
    duration: 60,
  });
  const middleware = createRateLimitMiddleware(limiter, {
    keyGenerator: () => "client-a",
    message: "Too many test requests.",
  });
  let nextCalls = 0;

  await middleware({ headers: {}, ip: "127.0.0.1" }, response(), () => {
    nextCalls += 1;
  });
  const blocked = response();
  await middleware({ headers: {}, ip: "127.0.0.1" }, blocked, () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 1);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.body.code, "RATE_LIMITED");
  assert.equal(blocked.body.error, "Too many test requests.");
  assert.ok(blocked.body.retryAfterSeconds >= 1);
  assert.equal(blocked.headers["Retry-After"], String(blocked.body.retryAfterSeconds));
});

test("a points option charges one point per unit of work before the request runs", async () => {
  delete require.cache[rateLimitPath];
  const { createRateLimitMiddleware, createRateLimiter } = require("../routes/utils/rateLimit");
  const limiter = createRateLimiter({ keyPrefix: `test:bulk-rate-limit:${Date.now()}`, points: 5, duration: 60 });
  const middleware = createRateLimitMiddleware(limiter, {
    keyGenerator: () => "moderator-a",
    points: (req) => req.items.length,
  });
  let nextCalls = 0;
  await middleware({ items: [1, 2, 3], headers: {} }, response(), () => { nextCalls += 1; });
  const blocked = response();
  await middleware({ items: [1, 2, 3], headers: {} }, blocked, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1, "the second three-item request exceeds the five points left");
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers["Retry-After"], String(blocked.body.retryAfterSeconds));
});

test("routes register the intended limiter after authentication where required", () => {
  const { limiters, routers } = installBlockedRoutes();
  const cases = [
    [routers.search, "get", "/search", 0, limiters.searchRateLimit],
    [routers.reviews, "post", "/review", 1, limiters.reviewCreateRateLimit],
    [routers.reviews, "patch", "/review/user/:id", 1, limiters.reviewMutationRateLimit],
    [routers.reviews, "delete", "/review/user/:id", 1, limiters.reviewMutationRateLimit],
    [routers.likes, "put", "/album/:albumId", 1, limiters.likeMutationRateLimit],
    [routers.likes, "put", "/review/:reviewId", 1, limiters.likeMutationRateLimit],
    [routers.boards, "post", "/:boardId/albums", 1, limiters.albumSaveRateLimit],
    [routers.boards, "patch", "/:boardId", 1, limiters.boardMutationRateLimit],
    [routers.boards, "put", "/:boardId/order", 1, limiters.boardMutationRateLimit],
    [routers.trackRankings, "put", "/album/:albumId", 1, limiters.trackRankingMutationRateLimit],
    [routers.trackRankings, "delete", "/album/:albumId", 1, limiters.trackRankingMutationRateLimit],
    [routers.profile, "get", "/me/stats", 1, limiters.profileStatsRateLimit],
    [routers.dataExport, "get", "/:dataset.:format", 3, limiters.dataExportRateLimit],
    [routers.profile, "get", "/:userId/stats", 0, limiters.profileStatsRateLimit],
    [routers.profile, "post", "/me/queue", 1, limiters.queueMutationRateLimit],
    [routers.profile, "put", "/me/queue", 1, limiters.queueMutationRateLimit],
    [routers.profile, "delete", "/me/queue/:albumId", 1, limiters.queueMutationRateLimit],
    [routers.profile, "patch", "/me/notification-preferences", 1, limiters.notificationMutationRateLimit],
    [routers.notifications, "post", "/read", 1, limiters.notificationMutationRateLimit],
    [routers.notifications, "post", "/clear", 1, limiters.notificationMutationRateLimit],
  ];

  for (const [router, method, path, limiterIndex, expectedLimiter] of cases) {
    const handlers = routeLayer(router, method, path).route.stack.map((layer) => layer.handle);
    assert.equal(handlers[limiterIndex], expectedLimiter, `${method.toUpperCase()} ${path}`);
  }
});

test("route-specific limiters stop work and preserve 429 response metadata", async () => {
  const { calls, routers } = installBlockedRoutes();
  const cases = [
    [routers.search, "get", "/search", { query: { q: "album" }, headers: {}, ip: "127.0.0.1" }, "search", 55],
    [routers.reviews, "post", "/review", { body: {}, headers: {} }, "reviewCreate", 53],
    [routers.reviews, "patch", "/review/user/:id", { body: {}, headers: {}, params: { id: "review" } }, "reviewMutation", 54],
    [routers.reviews, "delete", "/review/user/:id", { headers: {}, params: { id: "review" } }, "reviewMutation", 54],
    [routers.likes, "put", "/album/:albumId", { body: {}, headers: {}, params: { albumId: "album" } }, "likeMutation", 52],
    [routers.likes, "put", "/review/:reviewId", { body: {}, headers: {}, params: { reviewId: "review" } }, "likeMutation", 52],
    [routers.boards, "post", "/:boardId/albums", { body: {}, headers: {}, params: { boardId: "board" } }, "albumSave", 51],
    [routers.boards, "patch", "/:boardId", { body: {}, headers: {}, params: { boardId: "board" } }, "boardMutation", 60],
    [routers.boards, "put", "/:boardId/order", { body: {}, headers: {}, params: { boardId: "board" } }, "boardMutation", 60],
    [routers.trackRankings, "put", "/album/:albumId", { body: {}, headers: {}, params: { albumId: "album" } }, "trackRankingMutation", 56],
    [routers.trackRankings, "delete", "/album/:albumId", { headers: {}, params: { albumId: "album" } }, "trackRankingMutation", 56],
    [routers.profile, "get", "/me/stats", { query: {}, headers: {} }, "profileStats", 57],
    [routers.dataExport, "get", "/:dataset.:format", { query: {}, headers: {}, params: { dataset: "reviews", format: "csv" } }, "dataExport", 61],
    [routers.profile, "get", "/:userId/stats", { query: {}, headers: {}, params: { userId: "user_public" } }, "profileStats", 57],
    [routers.profile, "post", "/me/queue", { body: {}, headers: {} }, "queueMutation", 58],
    [routers.profile, "put", "/me/queue", { body: {}, headers: {} }, "queueMutation", 58],
    [routers.profile, "delete", "/me/queue/:albumId", { headers: {}, params: { albumId: "album" } }, "queueMutation", 58],
    [routers.profile, "patch", "/me/notification-preferences", { body: {}, headers: {} }, "notificationMutation", 59],
    [routers.notifications, "post", "/read", { body: {}, headers: {} }, "notificationMutation", 59],
    [routers.notifications, "post", "/clear", { body: {}, headers: {} }, "notificationMutation", 59],
  ];

  for (const [router, method, path, req, limiterName, retryAfterSeconds] of cases) {
    const result = await callRoute(router, method, path, req);
    assert.equal(result.status, 429, `${method.toUpperCase()} ${path}`);
    assert.equal(result.body.code, "RATE_LIMITED", `${method.toUpperCase()} ${path}`);
    assert.equal(result.body.retryAfterSeconds, retryAfterSeconds, `${method.toUpperCase()} ${path}`);
    assert.equal(result.headers["Retry-After"], String(retryAfterSeconds), `${method.toUpperCase()} ${path}`);
    assert.ok(calls[limiterName] >= 1, `${method.toUpperCase()} ${path}`);
  }
});

test("authentication rejects mutations before consuming their route-specific limits", async () => {
  const installed = installBlockedRoutes();
  installed.setUserId("");
  const cases = [
    [installed.routers.reviews, "post", "/review", { body: {}, headers: {} }],
    [installed.routers.reviews, "patch", "/review/user/:id", { body: {}, headers: {}, params: { id: "review" } }],
    [installed.routers.reviews, "delete", "/review/user/:id", { headers: {}, params: { id: "review" } }],
    [installed.routers.likes, "put", "/album/:albumId", { body: {}, headers: {}, params: { albumId: "album" } }],
    [installed.routers.likes, "put", "/review/:reviewId", { body: {}, headers: {}, params: { reviewId: "review" } }],
    [installed.routers.boards, "post", "/:boardId/albums", { body: {}, headers: {}, params: { boardId: "board" } }],
    [installed.routers.boards, "patch", "/:boardId", { body: {}, headers: {}, params: { boardId: "board" } }],
    [installed.routers.boards, "put", "/:boardId/order", { body: {}, headers: {}, params: { boardId: "board" } }],
    [installed.routers.trackRankings, "put", "/album/:albumId", { body: {}, headers: {}, params: { albumId: "album" } }],
    [installed.routers.profile, "post", "/me/queue", { body: {}, headers: {} }],
    [installed.routers.profile, "delete", "/me/queue/:albumId", { headers: {}, params: { albumId: "album" } }],
    [installed.routers.trackRankings, "delete", "/album/:albumId", { headers: {}, params: { albumId: "album" } }],
    [installed.routers.profile, "get", "/me/stats", { query: {}, headers: {} }],
    [installed.routers.dataExport, "get", "/:dataset.:format", { query: {}, headers: {}, params: { dataset: "reviews", format: "csv" } }],
    [installed.routers.profile, "patch", "/me/notification-preferences", { body: {}, headers: {} }],
    [installed.routers.notifications, "post", "/read", { body: {}, headers: {} }],
    [installed.routers.notifications, "post", "/clear", { body: {}, headers: {} }],
  ];

  for (const [router, method, path, req] of cases) {
    const result = await callRoute(router, method, path, req);
    assert.equal(result.status, 401, `${method.toUpperCase()} ${path}`);
  }
  assert.deepEqual(installed.calls, {
    albumSave: 0,
    boardMutation: 0,
    dataExport: 0,
    likeMutation: 0,
    notificationMutation: 0,
    profileStats: 0,
    queueMutation: 0,
    reviewCreate: 0,
    reviewMutation: 0,
    search: 0,
    trackRankingMutation: 0,
  });
});
