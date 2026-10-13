import "dotenv/config";
import app from "./app";
import { logger } from "./utils/logger";

// ─── Startup security checks ──────────────────────────────────────────────────
const PLACEHOLDER = "your_super_secret_jwt_key_min_32_chars_here";
const jwtSecret   = process.env.JWT_SECRET ?? "";

if (!jwtSecret) {
  logger.error("FATAL: JWT_SECRET is not set. Server will not start.");
  process.exit(1);
}
if (jwtSecret.length < 32) {
  logger.error("FATAL: JWT_SECRET must be at least 32 characters.");
  process.exit(1);
}
if (jwtSecret === PLACEHOLDER) {
  logger.error("FATAL: JWT_SECRET is still the default placeholder. Set a real secret.");
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  logger.error("FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;

const server = app.listen(PORT, () => {
  logger.info(`Funds Credit Union API gateway running on port ${PORT}`);
  logger.info(`   Environment: ${process.env.NODE_ENV ?? "development"}`);
  logger.info(`   API docs:    http://localhost:${PORT}/api/health`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
const shutdown = (signal: string) => {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("uncaughtException",  (err) => { logger.error("Uncaught exception",  err); process.exit(1); });
process.on("unhandledRejection", (err) => { logger.error("Unhandled rejection", err); process.exit(1); });
