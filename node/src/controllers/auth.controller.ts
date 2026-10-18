import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { timingSafeEqual } from "crypto";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { getSupabase } from "../services/supabase";
import { sendPinResetOtp, sendPasswordResetOtp } from "../services/email";
import { successResponse, errorResponse } from "../utils/response";
import { AppError } from "../middleware/errorHandler";
import { AuthRequest } from "../middleware/auth";
import { logger } from "../utils/logger";

// ─── Schemas ──────────────────────────────────────────────────────────────────
const registerSchema = z.object({
  full_name:    z.string().min(2),
  email:        z.string().email(),
  phone:        z.string().min(7),
  password:     z.string().min(8).regex(/[A-Z]/).regex(/[0-9]/),
  account_type: z.enum(["personal", "business"]).default("personal"),
  payment_pin:  z.string().length(4).regex(/^\d{4}$/, "PIN must be 4 digits"),
});

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function signToken(userId: string, email: string, role = "user", tokenVersion = 0): string {
  const secret = process.env.JWT_SECRET!;
  const expiresIn = (process.env.JWT_EXPIRES_IN ?? "7d") as string;
  return jwt.sign({ sub: userId, email, role, token_version: tokenVersion }, secret, { expiresIn } as jwt.SignOptions);
}

/** Generate a unique 10-digit numeric account number */
function generateAccountNumber(): string {
  // First digit 1-9 (no leading zero), rest 0-9
  const first = Math.floor(Math.random() * 9 + 1).toString();
  const rest = Math.floor(Math.random() * 1_000_000_000)
    .toString()
    .padStart(9, "0");
  return `${first}${rest}`;
}

/** Ensure account number is unique — retry up to 10 times */
async function uniqueAccountNumber(): Promise<string> {
  const supabase = getSupabase();
  for (let i = 0; i < 10; i++) {
    const num = generateAccountNumber();
    const { data } = await supabase
      .from("bank_accounts")
      .select("id")
      .eq("account_number", num)
      .maybeSingle();
    if (!data) return num;
  }
  const ts = Date.now().toString().slice(-10).padStart(10, "1");
  return ts;
}

/** Generate a 6-digit numeric OTP */
function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ─── OTP helpers ─────────────────────────────────────────────────────────────
const MAX_OTP_ATTEMPTS = 5;

/** Timing-safe OTP comparison */
function safeCompareOtp(stored: string, provided: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(stored, "utf8"), Buffer.from(provided, "utf8"));
  } catch {
    return false;
  }
}
export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const body     = registerSchema.parse(req.body);
    const supabase = getSupabase();

    // Check existing user
    const { data: existing } = await supabase
      .from("users")
      .select("id")
      .eq("email", body.email)
      .maybeSingle();

    if (existing) return errorResponse(res, "Email already registered", 409);

    const password_hash    = await bcrypt.hash(body.password, 12);
    const payment_pin_hash = await bcrypt.hash(body.payment_pin, 12);
    const userId           = uuidv4();

    // Create user — payment_pin_hash stored alongside password_hash
    const { data: user, error: userErr } = await supabase
      .from("users")
      .insert({
        id:               userId,
        email:            body.email,
        full_name:        body.full_name,
        phone:            body.phone,
        account_type:     body.account_type,
        password_hash,
        payment_pin_hash,
        kyc_status:       "pending",
      })
      .select("id, email, full_name, account_type, kyc_status, created_at")
      .single();

    if (userErr) throw new AppError(userErr.message, 500);

    const adminEmail = (process.env.ADMIN_EMAIL ?? "").toLowerCase();
    const isAdminEmail = adminEmail && body.email.toLowerCase() === adminEmail;
    let accountNumber = "";

    if (!isAdminEmail) {
      accountNumber = await uniqueAccountNumber();
      const { error: accErr } = await supabase
        .from("bank_accounts")
        .insert({
          user_id:           userId,
          account_number:    accountNumber,
          account_name:      `${body.full_name} — Checking`,
          account_type:      "checking",
          currency:          "USD",
          balance:           0,
          available_balance: 0,
          is_primary:        true,
        });

      if (accErr) throw new AppError(accErr.message, 500);
    }

    const token = signToken(user.id, user.email, "user", 0);
    return successResponse(res, { token, user, account_number: accountNumber || null }, "Account created", 201);
  } catch (err) {
    next(err);
  }
}

// ─── Login ────────────────────────────────────────────────────────────────────
export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const supabase = getSupabase();

    const { data: user, error } = await supabase
      .from("users")
      .select("id, email, full_name, account_type, kyc_status, password_hash, token_version")
      .eq("email", email)
      .single();

    if (error || !user) return errorResponse(res, "Invalid credentials", 401);

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return errorResponse(res, "Invalid credentials", 401);

    const { password_hash: _, token_version: tv, ...safeUser } = user;
    const token = signToken(user.id, user.email, "user", tv ?? 0);
    return successResponse(res, { token, user: safeUser }, "Login successful");
  } catch (err) {
    next(err);
  }
}

// ─── Logout ───────────────────────────────────────────────────────────────────
export async function logout(_req: Request, res: Response) {
  return successResponse(res, null, "Logged out successfully");
}

// ─── Refresh token ────────────────────────────────────────────────────────────
export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const { token: oldToken } = req.body as { token: string };
    if (!oldToken) return errorResponse(res, "Token required", 400);

    const secret = process.env.JWT_SECRET!;

    // Never accept expired tokens — verify normally (will throw if expired)
    let payload: { sub: string; email: string; role: string; token_version?: number };
    try {
      payload = jwt.verify(oldToken, secret) as typeof payload;
    } catch {
      return errorResponse(res, "Token invalid or expired", 401);
    }

    // Confirm user still exists, is active, and token_version matches
    const supabase = getSupabase();
    const { data: user } = await supabase
      .from("users")
      .select("id, email, is_active, token_version")
      .eq("id", payload.sub)
      .single();

    if (!user || user.is_active === false) {
      return errorResponse(res, "Account not found or disabled", 401);
    }

    // Reject tokens issued before a password/pin reset
    if (typeof user.token_version === "number" &&
        typeof payload.token_version === "number" &&
        payload.token_version !== user.token_version) {
      return errorResponse(res, "Session invalidated. Please log in again.", 401);
    }

    const token = signToken(user.id, user.email, payload.role, user.token_version ?? 0);
    return successResponse(res, { token }, "Token refreshed");
  } catch (err) {
    next(err);
  }
}

// ─── Forgot password ──────────────────────────────────────────────────────────
export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const supabase  = getSupabase();

    // Silently succeed even if the email doesn't exist (security: no enumeration)
    const { data: user } = await supabase
      .from("users")
      .select("id, email")
      .eq("email", email)
      .maybeSingle();

    if (user) {
      const otp     = generateOtp();
      const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

      await supabase
        .from("users")
        .update({
          pin_reset_otp:            otp,
          pin_reset_otp_expires_at: expires.toISOString(),
        })
        .eq("id", user.id);

      // Send OTP via Gmail (password reset template)
      try {
        await sendPasswordResetOtp(user.email, otp);
      } catch (emailErr) {
        logger.error("[forgotPassword] Failed to send OTP email", emailErr);
      }
    }

    return successResponse(res, null, "Reset code sent if account exists");
  } catch (err) {
    next(err);
  }
}

// ─── Verify OTP ───────────────────────────────────────────────────────────────
export async function verifyOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, otp } = z.object({
      email: z.string().email(),
      otp:   z.string().length(6),
    }).parse(req.body);

    const supabase = getSupabase();
    const { data: user } = await supabase
      .from("users")
      .select("pin_reset_otp, pin_reset_otp_expires_at, otp_attempts")
      .eq("email", email)
      .single();

    if (!user?.pin_reset_otp) return errorResponse(res, "No OTP requested", 400);

    // Brute-force lockout
    if ((user.otp_attempts ?? 0) >= MAX_OTP_ATTEMPTS) {
      return errorResponse(res, "Too many attempts. Request a new OTP.", 429);
    }

    const expired = user.pin_reset_otp_expires_at
      ? new Date(user.pin_reset_otp_expires_at) < new Date()
      : true;

    if (expired) return errorResponse(res, "OTP has expired", 400);

    if (!safeCompareOtp(user.pin_reset_otp, otp)) {
      // Increment attempt counter
      await supabase.from("users").update({ otp_attempts: (user.otp_attempts ?? 0) + 1 }).eq("email", email);
      return errorResponse(res, "Invalid OTP", 400);
    }

    // Reset attempt counter on success
    await supabase.from("users").update({ otp_attempts: 0 }).eq("email", email);
    return successResponse(res, { verified: true }, "OTP verified");
  } catch (err) {
    next(err);
  }
}

// ─── Reset password ───────────────────────────────────────────────────────────
export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, otp, password } = z.object({
      email:    z.string().email(),
      otp:      z.string().length(6),
      password: z.string().min(8),
    }).parse(req.body);

    const supabase = getSupabase();
    const { data: user } = await supabase
      .from("users")
      .select("pin_reset_otp, pin_reset_otp_expires_at")
      .eq("email", email)
      .single();

    if (!user?.pin_reset_otp || !safeCompareOtp(user.pin_reset_otp, otp)) {
      return errorResponse(res, "Invalid or expired OTP", 400);
    }

    const expired = user.pin_reset_otp_expires_at
      ? new Date(user.pin_reset_otp_expires_at) < new Date()
      : true;
    if (expired) return errorResponse(res, "OTP has expired", 400);

    // Fetch current token_version before update
    const { data: currentUser } = await supabase
      .from("users")
      .select("token_version")
      .eq("email", email)
      .single();

    const password_hash = await bcrypt.hash(password, 12);
    const { error } = await supabase
      .from("users")
      .update({
        password_hash,
        pin_reset_otp:            null,
        pin_reset_otp_expires_at: null,
        token_version:            (currentUser?.token_version ?? 0) + 1, // invalidate all existing sessions
      })
      .eq("email", email);

    if (error) throw new AppError(error.message, 500);
    return successResponse(res, null, "Password reset successfully");
  } catch (err) {
    next(err);
  }
}

// ─── Set payment PIN (for existing users who registered before PIN feature) ───
export async function setPaymentPin(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { pin } = z.object({
      pin: z.string().length(4).regex(/^\d{4}$/, "PIN must be 4 digits"),
    }).parse(req.body);

    const supabase = getSupabase();

    // Check if PIN is already set
    const { data: user } = await supabase
      .from("users")
      .select("payment_pin_hash")
      .eq("id", req.user!.id)
      .single();

    if (user?.payment_pin_hash) {
      return errorResponse(res, "Payment PIN already set. Use reset to change it.", 400);
    }

    const payment_pin_hash = await bcrypt.hash(pin, 12);
    const { error } = await supabase
      .from("users")
      .update({ payment_pin_hash })
      .eq("id", req.user!.id);

    if (error) throw new AppError(error.message, 500);
    return successResponse(res, null, "Payment PIN set successfully");
  } catch (err) {
    next(err);
  }
}
// Lightweight check — used by the frontend before submitting a transfer.
// The sendMoney endpoint also re-verifies server-side for security.
export async function verifyPaymentPin(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { pin } = z.object({
      pin: z.string().length(4).regex(/^\d{4}$/),
    }).parse(req.body);

    const supabase = getSupabase();
    const { data: user } = await supabase
      .from("users")
      .select("payment_pin_hash")
      .eq("id", req.user!.id)
      .single();

    if (!user?.payment_pin_hash) return errorResponse(res, "No payment PIN set", 400);

    const valid = await bcrypt.compare(pin, user.payment_pin_hash);
    if (!valid) return errorResponse(res, "Incorrect payment PIN", 401);

    return successResponse(res, { verified: true }, "PIN verified");
  } catch (err) {
    next(err);
  }
}

// ─── Verify PIN reset OTP (authenticated — uses stored OTP, no email needed) ──
export async function verifyPinResetOtp(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { otp } = z.object({
      otp: z.string().length(6),
    }).parse(req.body);

    const supabase = getSupabase();
    const { data: user } = await supabase
      .from("users")
      .select("pin_reset_otp, pin_reset_otp_expires_at, otp_attempts")
      .eq("id", req.user!.id)
      .single();

    if (!user?.pin_reset_otp) return errorResponse(res, "No OTP requested", 400);

    if ((user.otp_attempts ?? 0) >= MAX_OTP_ATTEMPTS) {
      return errorResponse(res, "Too many attempts. Request a new OTP.", 429);
    }

    const expired = user.pin_reset_otp_expires_at
      ? new Date(user.pin_reset_otp_expires_at) < new Date()
      : true;

    if (expired) return errorResponse(res, "OTP has expired", 400);

    if (!safeCompareOtp(user.pin_reset_otp, otp)) {
      await supabase.from("users").update({ otp_attempts: (user.otp_attempts ?? 0) + 1 }).eq("id", req.user!.id);
      return errorResponse(res, "Invalid OTP", 400);
    }

    await supabase.from("users").update({ otp_attempts: 0 }).eq("id", req.user!.id);
    return successResponse(res, { verified: true }, "OTP verified");
  } catch (err) {
    next(err);
  }
}


// Generates a 6-digit OTP, stores it hashed in the DB, and (in production)
// sends it to the user's email. For now the OTP is returned in the response
// so you can wire up a real email provider (Resend, SendGrid, etc.) later.
export async function requestPinReset(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const supabase = getSupabase();

    const { data: user } = await supabase
      .from("users")
      .select("email")
      .eq("id", req.user!.id)
      .single();

    if (!user) return errorResponse(res, "User not found", 404);

    const otp     = generateOtp();
    const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    await supabase
      .from("users")
      .update({
        pin_reset_otp:            otp,
        pin_reset_otp_expires_at: expires.toISOString(),
      })
      .eq("id", req.user!.id);

    // Send OTP via Gmail
    try {
      await sendPinResetOtp(user.email, otp);
    } catch (emailErr) {
      logger.error("[requestPinReset] Failed to send OTP email", emailErr);
      return errorResponse(res, "Failed to send OTP email. Please try again.", 500);
    }

    return successResponse(res, { email: user.email }, "OTP sent to your registered email");
  } catch (err) {
    next(err);
  }
}

// ─── Reset payment PIN ────────────────────────────────────────────────────────
export async function resetPaymentPin(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { otp, new_pin } = z.object({
      otp:     z.string().length(6),
      new_pin: z.string().length(4).regex(/^\d{4}$/, "PIN must be 4 digits"),
    }).parse(req.body);

    const supabase = getSupabase();

    const { data: user } = await supabase
      .from("users")
      .select("pin_reset_otp, pin_reset_otp_expires_at")
      .eq("id", req.user!.id)
      .single();

    if (!user?.pin_reset_otp) return errorResponse(res, "No PIN reset requested", 400);

    const expired = user.pin_reset_otp_expires_at
      ? new Date(user.pin_reset_otp_expires_at) < new Date()
      : true;

    if (expired)                              return errorResponse(res, "OTP has expired. Request a new one.", 400);
    if (!safeCompareOtp(user.pin_reset_otp, otp)) return errorResponse(res, "Invalid OTP", 400);

    const payment_pin_hash = await bcrypt.hash(new_pin, 12);

    // Also fetch token_version to increment (invalidates existing sessions)
    const { data: currentUser } = await supabase
      .from("users")
      .select("token_version")
      .eq("id", req.user!.id)
      .single();

    const { error } = await supabase
      .from("users")
      .update({
        payment_pin_hash,
        pin_reset_otp:            null,
        pin_reset_otp_expires_at: null,
        token_version:            (currentUser?.token_version ?? 0) + 1,
      })
      .eq("id", req.user!.id);

    if (error) throw new AppError(error.message, 500);
    return successResponse(res, null, "Payment PIN reset successfully");
  } catch (err) {
    next(err);
  }
}
