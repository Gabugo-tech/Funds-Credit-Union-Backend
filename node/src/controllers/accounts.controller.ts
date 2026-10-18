import { Response, NextFunction } from "express";
import { z } from "zod";
import { getSupabase } from "../services/supabase";
import { AuthRequest } from "../middleware/auth";
import { successResponse, errorResponse } from "../utils/response";
import { AppError } from "../middleware/errorHandler";

/** Generate a unique 10-digit numeric account number (no prefix) */
async function generateUniqueAccountNumber(): Promise<string> {
  const supabase = getSupabase();
  for (let i = 0; i < 10; i++) {
    const first = Math.floor(Math.random() * 9 + 1).toString();
    const rest  = Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
    const num   = `${first}${rest}`;
    const { data } = await supabase
      .from("bank_accounts").select("id").eq("account_number", num).maybeSingle();
    if (!data) return num;
  }
  return Date.now().toString().slice(-10).padStart(10, "1");
}

export async function listAccounts(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { data, error } = await getSupabase()
      .from("bank_accounts")
      .select("*")
      .eq("user_id", req.user!.id)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true }); // fallback: oldest first if no primary

    if (error) throw new AppError(error.message, 500);

    // If no account has is_primary=true, mark the first one as primary
    if (data && data.length > 0 && !data.some((a: { is_primary: boolean }) => a.is_primary)) {
      await getSupabase()
        .from("bank_accounts")
        .update({ is_primary: true })
        .eq("id", data[0].id);
      data[0].is_primary = true;
    }

    return successResponse(res, data ?? []);
  } catch (err) {
    next(err);
  }
}

/**
 * Resolve external bank account name.
 * Query params: account_number, bank_code, country (ISO2, e.g. "NG", "GH", "KE")
 *
 * Routing:
 *   NG (Nigeria)                  → Paystack name enquiry
 *   GH/KE/ZA/TZ/UG/RW/ZM/CM/SN  → Flutterwave name enquiry
 *   Everything else               → Returns {can_resolve: false} so UI shows manual entry
 */
export async function resolveExternalAccount(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const {
      account_number,
      bank_code,
      country = "NG",
    } = req.query as { account_number?: string; bank_code?: string; country?: string };

    if (!account_number || !bank_code) {
      return errorResponse(res, "account_number and bank_code are required", 400);
    }

    const clean      = account_number.replace(/\D/g, "");
    const countryUC  = country.toUpperCase();

    if (clean.length < 5) {
      return errorResponse(res, "Account number must be at least 5 digits", 400);
    }

    // ── Nigeria: Paystack ──────────────────────────────────────────────────
    if (countryUC === "NG") {
      const paystackKey = process.env.PAYSTACK_SECRET_KEY;
      if (!paystackKey) {
        return errorResponse(res, "Paystack not configured", 503);
      }

      const paystackRes = await fetch(
        `https://api.paystack.co/bank/resolve?account_number=${clean}&bank_code=${bank_code}`,
        { headers: { Authorization: `Bearer ${paystackKey}` } }
      );
      const json = await paystackRes.json().catch(() => ({})) as {
        status: boolean; message: string;
        data?: { account_name: string; account_number: string };
      };

      if (!paystackRes.ok || !json.status || !json.data) {
        return errorResponse(res, json.message ?? "Could not resolve account", 422);
      }

      return successResponse(res, {
        account_number: json.data.account_number,
        account_name:   json.data.account_name,
        bank_code, country: countryUC, source: "paystack", can_resolve: true,
      });
    }

    // ── African countries: Flutterwave ────────────────────────────────────
    const flutterwaveCountries = ["GH","KE","ZA","TZ","UG","RW","ZM","CM","SN","CI","ET","MZ"];
    if (flutterwaveCountries.includes(countryUC)) {
      const flwKey = process.env.FLUTTERWAVE_SECRET_KEY;
      if (!flwKey) {
        // No key configured — return unresolvable so UI shows manual entry
        return successResponse(res, {
          account_number: clean, account_name: null,
          bank_code, country: countryUC, source: "none", can_resolve: false,
          message: "Flutterwave not configured — please enter the recipient name manually",
        });
      }

      const flwRes = await fetch(
        `https://api.flutterwave.com/v3/accounts/resolve`,
        {
          method:  "POST",
          headers: {
            Authorization:  `Bearer ${flwKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ account_number: clean, account_bank: bank_code }),
        }
      );
      const flwJson = await flwRes.json().catch(() => ({})) as {
        status: string; message: string;
        data?: { account_name: string; account_number: string };
      };

      if (!flwRes.ok || flwJson.status !== "success" || !flwJson.data) {
        return errorResponse(res, flwJson.message ?? "Could not resolve account", 422);
      }

      return successResponse(res, {
        account_number: flwJson.data.account_number,
        account_name:   flwJson.data.account_name,
        bank_code, country: countryUC, source: "flutterwave", can_resolve: true,
      });
    }

    // ── All other countries: no auto-resolution available ─────────────────
    // (USA requires Plaid OAuth, Europe/Korea don't expose name APIs, etc.)
    return successResponse(res, {
      account_number: clean, account_name: null,
      bank_code, country: countryUC, source: "none", can_resolve: false,
      message: "Automatic name lookup is not available for this country. Please enter the recipient name manually.",
    });
  } catch (err) {
    next(err);
  }
}

/** Lookup account by number — pure 10-digit format only.
 *  Strips spaces/dashes from input before querying. Requires auth. */
export async function lookupAccount(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const raw = req.params.account_number?.trim() ?? "";

    // Strip spaces, dashes; keep only digits
    const normalised = raw.replace(/[\s\-]/g, "").replace(/\D/g, "");

    if (!normalised || normalised.length < 5) {
      return errorResponse(res, "Account number too short", 400);
    }

    const supabase = getSupabase();

    const { data: account, error } = await supabase
      .from("bank_accounts")
      .select("account_number, account_name, currency, account_type, user_id")
      .eq("account_number", normalised)
      .maybeSingle();

    if (error) throw new AppError(error.message, 500);
    if (!account) return errorResponse(res, "Account not found", 404);

    // Fetch owner's full name
    const { data: owner } = await supabase
      .from("users")
      .select("full_name")
      .eq("id", account.user_id)
      .single();

    return successResponse(res, {
      account_number: account.account_number,
      account_name:   owner?.full_name ?? "Account Holder",
      account_type:   account.account_type,
      currency:       account.currency,
    });
  } catch (err) {
    next(err);
  }
}

export async function getAccount(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { data, error } = await getSupabase()
      .from("bank_accounts")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", req.user!.id)
      .single();

    if (error || !data) return errorResponse(res, "Account not found", 404);
    return successResponse(res, data);
  } catch (err) {
    next(err);
  }
}

export async function createAccount(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const body = z.object({
      account_name: z.string().min(2),
      account_type: z.enum(["checking","savings","investment"]),
      currency:     z.string().length(3).default("USD"),
    }).parse(req.body);

    const accountNumber = await generateUniqueAccountNumber();

    const { data, error } = await getSupabase()
      .from("bank_accounts")
      .insert({
        user_id:          req.user!.id,
        account_number:   accountNumber,
        account_name:     body.account_name,
        account_type:     body.account_type,
        currency:         body.currency,
        balance:          0,
        available_balance: 0,
        is_primary:       false,
      })
      .select()
      .single();

    if (error) throw new AppError(error.message, 500);
    return successResponse(res, data, "Account created", 201);
  } catch (err) {
    next(err);
  }
}

export async function updateAccount(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const body = z.object({
      account_name: z.string().min(2).optional(),
      is_primary:   z.boolean().optional(),
    }).parse(req.body);

    const { data, error } = await getSupabase()
      .from("bank_accounts")
      .update(body)
      .eq("id", req.params.id)
      .eq("user_id", req.user!.id)
      .select()
      .single();

    if (error || !data) return errorResponse(res, "Account not found", 404);
    return successResponse(res, data, "Account updated");
  } catch (err) {
    next(err);
  }
}

export async function getBalance(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { data, error } = await getSupabase()
      .from("bank_accounts")
      .select("balance, available_balance, currency")
      .eq("id", req.params.id)
      .eq("user_id", req.user!.id)
      .single();

    if (error || !data) return errorResponse(res, "Account not found", 404);
    return successResponse(res, { ...data, updated_at: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
}

export async function getStatement(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { from, to } = req.query as { from?: string; to?: string };
    let query = getSupabase()
      .from("transactions")
      .select("*")
      .eq("account_id", req.params.id)
      .eq("user_id", req.user!.id)
      .order("created_at", { ascending: false });

    if (from) query = query.gte("created_at", from);
    if (to)   query = query.lte("created_at", to + "T23:59:59");

    const { data, error } = await query;
    if (error) throw new AppError(error.message, 500);
    return successResponse(res, data ?? [], "Statement retrieved");
  } catch (err) {
    next(err);
  }
}
