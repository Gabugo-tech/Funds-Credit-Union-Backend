import { Response, NextFunction } from "express";
import { z } from "zod";
import { getSupabase } from "../services/supabase";
import { AuthRequest } from "../middleware/auth";
import { successResponse, errorResponse } from "../utils/response";
import { AppError } from "../middleware/errorHandler";
import { logger } from "../utils/logger";

// Admin check uses role from JWT — not a hardcoded email
function isAdmin(req: AuthRequest): boolean {
  return req.user?.role === "admin";
}

// ─── Admin stats — real counts from the DB ────────────────────────────────────
export async function getStats(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!isAdmin(req)) return errorResponse(res, "Forbidden", 403);
    const supabase = getSupabase();

    const [usersCount, txCount, txVolume, visitorsCount] = await Promise.all([
      supabase.from("users").select("id", { count: "exact", head: true }),
      supabase.from("transactions").select("id", { count: "exact", head: true }),
      supabase.from("transactions").select("amount"),
      supabase.from("visitor_logs").select("id", { count: "exact", head: true }),
    ]);

    const volume = (txVolume.data ?? []).reduce(
      (sum: number, t: { amount: number | string }) => sum + Math.abs(Number(t.amount)), 0
    );

    return successResponse(res, {
      total_users:        usersCount.count   ?? 0,
      total_transactions: txCount.count      ?? 0,
      total_volume:       volume,
      total_visitors:     visitorsCount.count ?? 0,
    });
  } catch (err) { next(err); }
}

// ─── Users (admin) ────────────────────────────────────────────────────────────
export async function listUsers(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!isAdmin(req)) return errorResponse(res, "Forbidden", 403);
    const limit = Number(req.query.limit ?? 100);
    const { data, error } = await getSupabase()
      .from("users")
      .select("id, email, full_name, phone, account_type, kyc_status, is_active, country, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new AppError(error.message, 500);
    return successResponse(res, data ?? []);
  } catch (err) { next(err); }
}

// ─── All transactions (admin) ─────────────────────────────────────────────────
export async function listAllTransactions(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!isAdmin(req)) return errorResponse(res, "Forbidden", 403);
    const limit = Number(req.query.limit ?? 200);

    const { data, error } = await getSupabase()
      .from("transactions")
      .select("id, description, amount, currency, type, status, reference, recipient_name, category, created_at, user_id")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw new AppError(error.message, 500);

    // Enrich with user emails
    const userIds = [...new Set((data ?? []).map((t: { user_id: string }) => t.user_id))];
    let emailMap: Record<string, string> = {};
    if (userIds.length > 0) {
      const { data: users } = await getSupabase()
        .from("users")
        .select("id, email")
        .in("id", userIds);
      emailMap = Object.fromEntries((users ?? []).map((u: { id: string; email: string }) => [u.id, u.email]));
    }

    const flat = (data ?? []).map((t: { user_id: string }) => ({
      ...t,
      user_email: emailMap[t.user_id] ?? null,
    }));

    return successResponse(res, flat);
  } catch (err) { next(err); }
}

// ─── Visitor logs (admin) ─────────────────────────────────────────────────────
export async function listVisitors(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!isAdmin(req)) return errorResponse(res, "Forbidden", 403);
    const limit = Number(req.query.limit ?? 100);

    const { data, error } = await getSupabase()
      .from("visitor_logs")
      .select("id, ip_address, page, user_email, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw new AppError(error.message, 500);
    return successResponse(res, data ?? []);
  } catch (err) { next(err); }
}

// ─── Admin account — looks up by logged-in admin user's ID ───────────────────
export async function getAdminAccount(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!isAdmin(req)) return errorResponse(res, "Forbidden", 403);

    // Find the admin's primary account
    const { data, error } = await getSupabase()
      .from("bank_accounts")
      .select("id, account_number, account_name, balance, currency, is_primary")
      .eq("user_id", req.user!.id)
      .order("is_primary", { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      // Fallback: search by the known admin account number
      const { data: fallback, error: fallbackErr } = await getSupabase()
        .from("bank_accounts")
        .select("id, account_number, account_name, balance, currency")
        .eq("account_number", "0000000001")
        .single();

      if (fallbackErr || !fallback) {
        return errorResponse(res, "Admin account not found. Please ensure the admin bank account exists in the database.", 404);
      }

      return successResponse(res, fallback);
    }

    return successResponse(res, data);
  } catch (err) { next(err); }
}

// ─── Admin transfers — recent transfers made FROM admin account ───────────────
export async function listAdminTransfers(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!isAdmin(req)) return errorResponse(res, "Forbidden", 403);

    const { data: account } = await getSupabase()
      .from("bank_accounts")
      .select("id")
      .eq("user_id", req.user!.id)
      .order("is_primary", { ascending: false })
      .limit(1)
      .single();

    if (!account) return successResponse(res, []);

    const { data, error } = await getSupabase()
      .from("transactions")
      .select("id, reference, amount, currency, recipient_name, recipient_account, description, status, created_at")
      .eq("account_id", account.id)
      .eq("type", "debit")
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) throw new AppError(error.message, 500);
    return successResponse(res, data ?? []);
  } catch (err) { next(err); }
}

// ─── Visitor log ──────────────────────────────────────────────────────────────
export async function logVisitor(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const body = z.object({
      page:       z.string().default("/"),
      user_id:    z.string().uuid().optional().nullable(),
      user_email: z.string().email().optional().nullable(),
    }).parse(req.body);

    const ip = (
      (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() ??
      req.socket?.remoteAddress ??
      "unknown"
    );

    const ua = req.headers["user-agent"] ?? "";

    await getSupabase()
      .from("visitor_logs")
      .insert({
        ip_address: ip,
        user_agent: ua.slice(0, 500),
        page:       body.page,
        user_id:    body.user_id  ?? null,
        user_email: body.user_email ?? null,
      });

    return successResponse(res, null, "Logged");
  } catch (err) { next(err); }
}

// ─── Delete user (admin) ──────────────────────────────────────────────────────
export async function deleteUser(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!isAdmin(req)) return errorResponse(res, "Forbidden", 403);

    const { id } = req.params;
    if (!id) return errorResponse(res, "User ID required", 400);

    const supabase = getSupabase();

    // Confirm the user exists
    const { data: target, error: findErr } = await supabase
      .from("users")
      .select("id, email")
      .eq("id", id)
      .single();

    if (findErr || !target) return errorResponse(res, "User not found", 404);

    // Prevent admin from deleting themselves
    if (target.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
      return errorResponse(res, "Cannot delete the admin account", 403);
    }

    // Delete all related data in dependency order.
    // App uses custom JWT auth (no Supabase Auth entries), so only DB cleanup is needed.
    await supabase.from("transactions")  .delete().eq("user_id", id);
    await supabase.from("bank_accounts") .delete().eq("user_id", id);
    await supabase.from("notifications") .delete().eq("user_id", id);
    await supabase.from("visitor_logs")  .delete().eq("user_id", id);
    await supabase.from("users")         .delete().eq("id", id);

    logger.info(`[deleteUser] Deleted user ${target.email} (${id}) by admin`);
    return successResponse(res, { id, email: target.email }, "User deleted successfully");
  } catch (err) { next(err); }
}

// ─── Test email config (admin only) ──────────────────────────────────────────
export async function testEmail(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!isAdmin(req)) return errorResponse(res, "Forbidden", 403);

    const gmailUser     = process.env.GMAIL_USER;
    const gmailPassword = process.env.GMAIL_APP_PASSWORD;

    if (!gmailUser || !gmailPassword) {
      return errorResponse(res, "Email service not configured", 500);
    }

    const { sendPasswordResetOtp } = await import("../services/email");
    const testOtp = "123456";
    await sendPasswordResetOtp(gmailUser, testOtp);

    // Do NOT return credentials in the response
    return successResponse(res, { sent_to: gmailUser }, `Test email sent successfully to ${gmailUser}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(res, `Email failed: ${msg}`, 500);
  }
}
