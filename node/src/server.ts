import "dotenv/config";
import app from "./app";
import { logger } from "./utils/logger";

const PORT = process.env.PORT || 4000;

const server = app.listen(PORT, () => {
  logger.info(`Funds Credit Union API gateway running on port ${PORT}`);
  logger.info(`   Environment: ${process.env.NODE_ENV ?? "development"}`);
  logger.info(`   API docs:    http://localhost:${PORT}/api/health`);
});

// Graceful shutdown
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
