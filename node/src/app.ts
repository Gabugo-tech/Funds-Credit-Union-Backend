import express, { Application, Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import { randomUUID } from "crypto";
import { globalLimiter, authLimiter, adminLimiter } from "./middleware/limiters";

import authRoutes         from "./routes/auth.routes";
import accountRoutes      from "./routes/accounts.routes";
import transactionRoutes  from "./routes/transactions.routes";
import paymentRoutes      from "./routes/payments.routes";
import notificationRoutes from "./routes/notifications.routes";
import userRoutes         from "./routes/users.routes";
import adminRoutes        from "./routes/admin.routes";
import { errorHandler }   from "./middleware/errorHandler";
import { logger }         from "./utils/logger";

const app: Application = express();

// ─── Trust Railway's reverse proxy ───────────────────────────────────────────
app.set("trust proxy", 1);

// ─── Security headers (Helmet + strict CSP) ──────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:              ["'self'"],
      scriptSrc:               ["'self'"],
      styleSrc:                ["'self'", "'unsafe-inline'"],
      imgSrc:                  ["'self'", "data:", "https:"],
      connectSrc:              ["'self'"],
      fontSrc:                 ["'self'"],
      objectSrc:               ["'none'"],
      frameSrc:                ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  hsts: {
    maxAge:            31536000,
    includeSubDomains: true,
    preload:           true,
  },
  frameguard:     { action: "deny" },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
}));

app.use(compression());

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = [
      process.env.FRONTEND_URL ?? "http://localhost:3000",
      "http://localhost:3000",
      "http://localhost:3001",
      "https://fundscreditunion.vercel.app",
      "https://funds-credit-union.vercel.app",
      "https://fundscreditunion-frontend.vercel.app",
      "https://funds-credit-union-bank.vercel.app",
    ];
    if (allowed.includes(origin) || /https:\/\/fundscreditunion[-a-z0-9]*\.vercel\.app$/.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","X-Request-ID"],
}));

app.use(globalLimiter);

// ─── Body parsing — intentionally small limit for a banking API ───────────────
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

// ─── Logging — short format avoids leaking query strings ─────────────────────
app.use(morgan("short", {
  stream: { write: (msg) => logger.http(msg.trim()) },
}));

// ─── Request ID ──────────────────────────────────────────────────────────────
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.headers["x-request-id"] = req.headers["x-request-id"] ?? randomUUID();
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({
    status:    "healthy",
    service:   "funds-credit-union-api-gateway",
    version:   "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/auth",          authLimiter,    authRoutes);
app.use("/api/users",                         userRoutes);
app.use("/api/accounts",                      accountRoutes);
app.use("/api/transactions",                  transactionRoutes);
app.use("/api/payments",                      paymentRoutes);
app.use("/api/notifications",                 notificationRoutes);
app.use("/api/admin",         adminLimiter,   adminRoutes);

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, error: "Route not found" });
});

// ─── Global error handler ────────────────────────────────────────────────────
app.use(errorHandler);

export default app;
