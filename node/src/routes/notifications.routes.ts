import { Router } from "express";
import { authenticate } from "../middleware/auth";
import * as ctrl from "../controllers/notifications.controller";

const router = Router();
router.use(authenticate);

// GET   /api/notifications/unread-count
router.get("/unread-count", ctrl.getUnreadCount);

// PATCH /api/notifications/read-all  — mark all as read
router.patch("/read-all", ctrl.markAllRead);

// DELETE /api/notifications          — clear all
router.delete("/",        ctrl.clearAll);

// GET   /api/notifications           — list notifications
router.get("/",           ctrl.listNotifications);

// PATCH /api/notifications/:id/read  — mark single as read
router.patch("/:id/read", ctrl.markRead);

// DELETE /api/notifications/:id      — delete
router.delete("/:id",     ctrl.deleteNotification);

export default router;
