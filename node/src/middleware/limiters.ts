import rateLimit from "express-rate-limit";

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: "Too many requests. Please try again later." },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  validate: { xForwardedForHeader: false },
  message: { error: "Too many auth attempts. Please try again in 15 minutes." },
});

export const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  validate: { xForwardedForHeader: false },
  message: { error: "Too many admin requests. Please try again later." },
});

export const visitorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  validate: { xForwardedForHeader: false },
  message: { error: "Too many requests." },
});

export const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  validate: { xForwardedForHeader: false },
  message: { error: "Too many lookup requests. Please slow down." },
});
