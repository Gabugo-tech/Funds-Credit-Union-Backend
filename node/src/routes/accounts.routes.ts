import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate } from "../middleware/auth";
import * as ctrl from "../controllers/accounts.controller";

const router = Router();

// All routes require authentication
router.use(authenticate);

// Tight rate limit on account lookup to prevent enumeration
const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  validate: { xForwardedForHeader: false },
  message: { error: "Too many lookup requests. Please slow down." },
});

// GET /api/accounts/lookup/:account_number
router.get("/lookup/:account_number", lookupLimiter, ctrl.lookupAccount);

// GET /api/accounts/resolve?account_number=&bank_code=&country=
router.get("/resolve", ctrl.resolveExternalAccount);

// GET  /api/accounts          — list user's accounts
router.get("/",          ctrl.listAccounts);

// POST /api/accounts          — create a new account
router.post("/",         ctrl.createAccount);

// GET  /api/accounts/:id      — account detail
router.get("/:id",       ctrl.getAccount);

// PATCH /api/accounts/:id     — update account settings
router.patch("/:id",     ctrl.updateAccount);

// GET  /api/accounts/:id/balance — live balance
router.get("/:id/balance", ctrl.getBalance);

// GET  /api/accounts/:id/statement — downloadable statement
router.get("/:id/statement", ctrl.getStatement);

export default router;
