import express, { Application, Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import rateLimit from "express-rate-limit";

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
// Required so express-rate-limit can read the real client IP from X-Forwarded-For
app.set("trust proxy", 1);
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    const allowed = [
      process.env.FRONTEND_URL ?? "http://localhost:3000",
      "http://localhost:3000",
      "http://localhost:3001",
      "https://fundscreditunion.vercel.app",
      "https://funds-credit-union.vercel.app",
      "https://fundscreditunion-frontend.vercel.app",
    ];
    // Scope the CORS wildcard to Funds Credit Union Vercel deployments only
    if (allowed.includes(origin) || /https:\/\/fundscreditunion[-a-z0-9]*\.vercel\.app$/.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","X-Request-ID"],
}));

// ─── Rate limiting ────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }, // suppress Railway proxy warning
  message: { error: "Too many requests. Please try again later." },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  validate: { xForwardedForHeader: false },
  message: { error: "Too many auth attempts. Please try again in 15 minutes." },
});

app.use(globalLimiter);

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── Logging ──────────────────────────────────────────────────────────────────
app.use(morgan("combined", {
  stream: { write: (msg) => logger.http(msg.trim()) },
}));

// ─── Request ID ──────────────────────────────────────────────────────────────
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.headers["x-request-id"] = req.headers["x-request-id"] ?? crypto.randomUUID();
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({
    status:  "healthy",
    service: "funds-credit-union-api-gateway",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/auth",          authLimiter, authRoutes);
app.use("/api/users",         userRoutes);
app.use("/api/accounts",      accountRoutes);
app.use("/api/transactions",  transactionRoutes);
app.use("/api/payments",      paymentRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/admin",         adminRoutes);

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, error: "Route not found" });
});

// ─── Global error handler ────────────────────────────────────────────────────
app.use(errorHandler);

export default app;
