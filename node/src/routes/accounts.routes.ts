import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { lookupLimiter } from "../middleware/limiters";
import * as ctrl from "../controllers/accounts.controller";

const router = Router();

// All routes require authentication
router.use(authenticate);

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
