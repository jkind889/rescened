const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCorsOptions,
  getAllowedOrigins,
  normalizeOrigin,
  parsePort,
  validateServerEnv,
} = require("../routes/utils/serverConfig");

function validEnv(overrides = {}) {
  return {
    CLERK_PUBLISHABLE_KEY: "pk_test_123",
    CLERK_SECRET_KEY: "sk_test_123",
    MONGO_URI: "mongodb://localhost:27017/rescened",
    NODE_ENV: "development",
    SPOTIFY_CLIENT_ID: "spotify_client",
    SPOTIFY_CLIENT_SECRET: "spotify_secret",
    ...overrides,
  };
}

function checkCors(corsOptions, origin) {
  return new Promise((resolve, reject) => {
    corsOptions.origin(origin, (error, allowed) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(allowed);
    });
  });
}

test("parsePort reads deployment PORT and falls back for invalid values", () => {
  assert.equal(parsePort({ PORT: "8080" }), 8080);
  assert.equal(parsePort({ PORT: "not-a-port" }), 3000);
  assert.equal(parsePort({}), 3000);
});

test("getAllowedOrigins reads comma-separated and single frontend origins", () => {
  const origins = getAllowedOrigins(validEnv({
    CORS_ALLOWED_ORIGINS: "https://www.rescened.com, http://localhost:5173/",
    FRONTEND_URL: "rescened.vercel.app",
  }));

  assert.deepEqual(origins, [
    "https://www.rescened.com",
    "http://localhost:5173",
    "https://rescened.vercel.app",
  ]);
});

test("getAllowedOrigins defaults to local dev origins outside production", () => {
  const origins = getAllowedOrigins(validEnv());

  assert.ok(origins.includes("http://localhost:5173"));
  assert.ok(origins.includes("http://127.0.0.1:5173"));
});

test("validateServerEnv fails fast for missing required deploy config", () => {
  assert.throws(
    () => validateServerEnv({
      NODE_ENV: "production",
      CLERK_SECRET_KEY: "sk_test_123",
      MONGO_URI: "mongodb://localhost:27017/rescened",
    }),
    /CLERK_PUBLISHABLE_KEY or VITE_CLERK_PUBLISHABLE_KEY/,
  );
});

test("validateServerEnv requires an allowed frontend origin in production", () => {
  assert.throws(
    () => validateServerEnv(validEnv({ NODE_ENV: "production" })),
    /CORS_ALLOWED_ORIGINS or FRONTEND_URL/,
  );
});

test("validateServerEnv accepts Vite Clerk publishable key fallback", () => {
  const env = validEnv({
    CLERK_PUBLISHABLE_KEY: "",
    VITE_CLERK_PUBLISHABLE_KEY: "pk_test_vite",
  });

  validateServerEnv(env);

  assert.equal(env.CLERK_PUBLISHABLE_KEY, "pk_test_vite");
});

test("buildCorsOptions allows configured origins and rejects unknown origins", async () => {
  const corsOptions = buildCorsOptions(validEnv({
    CORS_ALLOWED_ORIGINS: "https://rescened.vercel.app",
  }));

  assert.equal(corsOptions.maxAge, 600, "preflights are reusable for 10 minutes");
  assert.equal(await checkCors(corsOptions, "https://rescened.vercel.app"), true);
  assert.equal(await checkCors(corsOptions), true);
  await assert.rejects(
    () => checkCors(corsOptions, "https://example.com"),
    /Origin is not allowed by CORS/,
  );
});

test("normalizeOrigin trims trailing slashes and defaults bare hosts to https", () => {
  assert.equal(normalizeOrigin("https://example.com/"), "https://example.com");
  assert.equal(normalizeOrigin("example.com"), "https://example.com");
});
