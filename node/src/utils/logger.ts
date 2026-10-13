import winston from "winston";

const { combine, timestamp, colorize, printf, json } = winston.format;

// Custom log levels including http
const levels = {
  error: 0,
  warn:  1,
  info:  2,
  http:  3,
  debug: 4,
};

const devFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  return `${timestamp} [${level}] ${message}${metaStr}`;
});

const isProduction = process.env.NODE_ENV === "production";

export const logger = winston.createLogger({
  // Use custom levels so 'http' is recognized
  levels,
  level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "http"),
  format: combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), json()),
  transports: [
    // Console only — Railway is ephemeral, file writes will crash if /logs doesn't exist
    new winston.transports.Console({
      format: combine(
        colorize({ all: !isProduction }),
        timestamp({ format: "HH:mm:ss" }),
        devFormat
      ),
    }),
  ],
});
