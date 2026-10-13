import { Router } from "express";
import { authenticate } from "../middleware/auth";
import * as ctrl from "../controllers/transactions.controller";

const router = Router();
router.use(authenticate);

// GET  /api/transactions/summary     — totals by category / period
router.get("/summary",   ctrl.getSummary);

// GET  /api/transactions             — paginated, filterable list
router.get("/",          ctrl.listTransactions);

// GET  /api/transactions/:id         — single transaction
router.get("/:id",       ctrl.getTransaction);

// POST /api/transactions/:id/dispute — raise a dispute
router.post("/:id/dispute", ctrl.disputeTransaction);

export default router;
