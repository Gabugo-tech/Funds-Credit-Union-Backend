import { Response, NextFunction } from "express";
import { z } from "zod";
import { getSupabase } from "../services/supabase";
import { AuthRequest } from "../middleware/auth";
import { paginatedResponse, successResponse, errorResponse } from "../utils/response";
import { AppError } from "../middleware/errorHandler";

const listSchema = z.object({
  page:     z.coerce.number().min(1).default(1),
  per_page: z.coerce.number().min(1).max(100).default(20),
  type:     z.enum(["credit","debit","transfer","all"]).default("all"),
  status:   z.enum(["completed","pending","failed","cancelled","all"]).default("all"),
  category: z.string().optional(),
  from:     z.string().optional(),
  to:       z.string().optional(),
  account_id: z.string().uuid().optional(),
  search:   z.string().max(100).optional(),
});

export async function listTransactions(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const params = listSchema.parse(req.query);
    const supabase = getSupabase();
    const offset = (params.page - 1) * params.per_page;

    let query = supabase
      .from("transactions")
      .select("*", { count: "exact" })
      .eq("user_id", req.user!.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + params.per_page - 1);

    if (params.type     !== "all") query = query.eq("type",     params.type);
    if (params.status   !== "all") query = query.eq("status",   params.status);
    if (params.category)           query = query.eq("category", params.category);
    if (params.account_id)         query = query.eq("account_id", params.account_id);
    if (params.from)               query = query.gte("created_at", params.from);
    if (params.to)                 query = query.lte("created_at", params.to + "T23:59:59");
    if (params.search)             query = query.ilike("description", `%${params.search}%`);

    const { data, count, error } = await query;
    if (error) throw new AppError(error.message, 500);

    return paginatedResponse(res, data ?? [], count ?? 0, params.page, params.per_page);
  } catch (err) {
    next(err);
  }
}

export async function getTransaction(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { data, error } = await getSupabase()
      .from("transactions")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", req.user!.id)
      .single();

    if (error || !data) return errorResponse(res, "Transaction not found", 404);
    return successResponse(res, data);
  } catch (err) {
    next(err);
  }
}

export async function getSummary(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // Limit to current month by default to avoid loading all-time data into memory.
    // Callers can pass ?from=&to= to override the window.
    const now       = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const { from = firstOfMonth, to = now.toISOString() } =
      req.query as { from?: string; to?: string };

    const { data, error } = await getSupabase()
      .from("transactions")
      .select("type, amount, currency, category, created_at")
      .eq("user_id", req.user!.id)
      .eq("status", "completed")
      .gte("created_at", from)
      .lte("created_at", to)
      .limit(1000); // safety cap — aggregate queries should stay bounded

    if (error) throw new AppError(error.message, 500);

    // Use type field for direction — amount is always stored as a positive number
    const totalIn  = data?.filter(t => t.type === "credit") .reduce((s, t) => s + Number(t.amount), 0) ?? 0;
    const totalOut = data?.filter(t => t.type === "debit")  .reduce((s, t) => s + Number(t.amount), 0) ?? 0;

    return successResponse(res, { totalIn, totalOut, net: totalIn - totalOut, count: data?.length ?? 0 });
  } catch (err) {
    next(err);
  }
}

export async function disputeTransaction(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { reason } = z.object({ reason: z.string().min(10) }).parse(req.body);
    // TODO: create dispute record and notify ops team
    return successResponse(res, { dispute_id: crypto.randomUUID() }, "Dispute submitted");
  } catch (err) {
    next(err);
  }
}
