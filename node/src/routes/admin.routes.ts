import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { visitorLimiter } from "../app";
import * as ctrl from "../controllers/admin.controller";

const router = Router();

// Visitor logging — no auth required but tightly rate-limited
router.post("/visitors", visitorLimiter, ctrl.logVisitor);

// All routes below require JWT authentication
router.use(authenticate);

// Stats
router.get("/stats",        ctrl.getStats);

// Users
router.get("/users",        ctrl.listUsers);

// Transactions
router.get("/transactions", ctrl.listAllTransactions);

// Visitors (read)
router.get("/visitors",     ctrl.listVisitors);

// Admin account
router.get("/account",      ctrl.getAdminAccount);

// Admin transfer history
router.get("/transfers",    ctrl.listAdminTransfers);

// Test email
router.post("/test-email",  ctrl.testEmail);

// Delete user
router.delete("/users/:id", ctrl.deleteUser);

export default router;
