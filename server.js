require("dotenv").config();

const express = require("express");
const app = express();
const cors = require("cors");
const mongoose = require("mongoose");
const { clerkMiddleware } = require("@clerk/express");
const healthRoutes = require("./routes/health");
const {
  getTrustProxyHops,
  globalApiRateLimit,
} = require("./routes/utils/rateLimit");
const {
  buildCorsOptions,
  parsePort,
  validateServerEnv,
} = require("./routes/utils/serverConfig");

validateServerEnv();

app.use(express.json())
app.use("/health", healthRoutes);
app.use(cors(buildCorsOptions()))
const trustProxyHops = getTrustProxyHops();
if (trustProxyHops > 0) {
  app.set("trust proxy", trustProxyHops);
}
app.use(globalApiRateLimit);
app.use(clerkMiddleware());


app.get("/", (req,res) =>
{
    console.log("Here")
    res.send("Hey")
})

const authRoutes = require("./routes/auth");
const albumRoutes = require("./routes/album");
const searchRoutes = require("./routes/search");
const reviewRoutes = require("./routes/reviews");
const profileRoutes = require("./routes/profile")
const boardRoutes = require("./routes/boards")
const likeRoutes = require("./routes/likes")
const notificationRoutes = require("./routes/notifications")
const suggestionRoutes = require("./routes/suggestions")
const moderationRoutes = require("./routes/moderation")

app.use("/auth", authRoutes);
app.use("/search", searchRoutes);
app.use("/albums", albumRoutes);
app.use("/reviews", reviewRoutes);
app.use("/profile", profileRoutes)
app.use("/boards", boardRoutes)
app.use("/diary", require("./routes/diary"));
app.use("/likes", likeRoutes)
app.use("/notifications", notificationRoutes)
app.use("/suggestions", suggestionRoutes)
app.use("/moderation/album-suggestions", moderationRoutes)

async function startServer({
  connect = mongoose.connect.bind(mongoose),
  initializeDiary = async () => Promise.all([
    require("./models/Listen").init(),
    require("./models/BoardListen").init(),
    require("./models/ListenCreation").init(),
  ]),
  listen = app.listen.bind(app),
  mongoUri = process.env.MONGO_URI,
  port = parsePort(),
} = {}) {
  await connect(mongoUri);
  await initializeDiary();
  console.log("MongoDB Connected");
  return listen(port, () => {
    console.log(`server running on port ${port}`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("MongoDB connection failed; server did not start", error);
    process.exitCode = 1;
  });
}

module.exports = { app, startServer };
