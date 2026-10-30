const DEFAULT_PORT = 3000;
const DEFAULT_DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

function parsePort(env = process.env) {
  const parsedPort = Number.parseInt(env.PORT || `${DEFAULT_PORT}`, 10);

  return Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
}

function isExternalAlbumSearchEnabled(env = process.env) {
  return String(env.EXTERNAL_ALBUM_SEARCH_ENABLED || "").trim().toLowerCase() === "true";
}

function isGenresEnabled(env = process.env) {
  return String(env.GENRES_ENABLED || "").trim().toLowerCase() === "true";
}

function isDataExportEnabled(env = process.env) {
  return String(env.DATA_EXPORT_ENABLED || "").trim().toLowerCase() === "true";
}

function parseOriginList(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function normalizeOrigin(origin) {
  const trimmedOrigin = String(origin || "").trim();

  if (!trimmedOrigin) {
    return "";
  }

  if (trimmedOrigin.startsWith("http://") || trimmedOrigin.startsWith("https://")) {
    return trimmedOrigin.replace(/\/+$/, "");
  }

  return `https://${trimmedOrigin.replace(/\/+$/, "")}`;
}

function getConfiguredOrigins(env = process.env) {
  return [
    ...parseOriginList(env.CORS_ALLOWED_ORIGINS),
    env.FRONTEND_URL,
    env.FRONTEND_ORIGIN,
    env.CLIENT_ORIGIN,
    env.VERCEL_URL,
  ]
    .map(normalizeOrigin)
    .filter(Boolean);
}

function uniqueOrigins(origins) {
  return [...new Set(origins)];
}

function getAllowedOrigins(env = process.env) {
  const configuredOrigins = getConfiguredOrigins(env);

  if (configuredOrigins.length > 0) {
    return uniqueOrigins(configuredOrigins);
  }

  return env.NODE_ENV === "production" ? [] : DEFAULT_DEV_ORIGINS;
}

function validateServerEnv(env = process.env) {
  const missing = [];

  if (!env.MONGO_URI) {
    missing.push("MONGO_URI");
  }

  if (!env.CLERK_SECRET_KEY) {
    missing.push("CLERK_SECRET_KEY");
  }

  if (!env.CLERK_PUBLISHABLE_KEY && !env.VITE_CLERK_PUBLISHABLE_KEY) {
    missing.push("CLERK_PUBLISHABLE_KEY or VITE_CLERK_PUBLISHABLE_KEY");
  }

  if (env.NODE_ENV === "production" && getAllowedOrigins(env).length === 0) {
    missing.push("CORS_ALLOWED_ORIGINS or FRONTEND_URL");
  }

  if (missing.length > 0) {
    throw new Error(`Missing required server environment variables: ${missing.join(", ")}.`);
  }

  if (!env.CLERK_PUBLISHABLE_KEY && env.VITE_CLERK_PUBLISHABLE_KEY) {
    env.CLERK_PUBLISHABLE_KEY = env.VITE_CLERK_PUBLISHABLE_KEY;
  }
}

function buildCorsOptions(env = process.env) {
  const allowedOrigins = getAllowedOrigins(env);

  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.includes(normalizeOrigin(origin))) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin is not allowed by CORS."));
    },
    // Authorized API calls need a preflight; browsers may reuse one for 10 minutes.
    maxAge: 600,
  };
}

module.exports = {
  DEFAULT_DEV_ORIGINS,
  DEFAULT_PORT,
  buildCorsOptions,
  getAllowedOrigins,
  getConfiguredOrigins,
  isDataExportEnabled,
  isExternalAlbumSearchEnabled,
  isGenresEnabled,
  normalizeOrigin,
  parseOriginList,
  parsePort,
  validateServerEnv,
};
