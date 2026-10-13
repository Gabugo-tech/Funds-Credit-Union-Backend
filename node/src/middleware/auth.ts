import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { errorResponse } from "../utils/response";
import { getSupabase } from "../services/supabase";

export interface AuthRequest extends Request {
  user?: { id: string; email: string; role: string };
}

export async function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    errorResponse(res, "Missing or invalid authorization header", 401);
    return;
  }

  const token = header.split(" ")[1];

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET not configured");

    const payload = jwt.verify(token, secret) as {
      sub: string;
      email: string;
      role: string;
      token_version?: number;
    };

    // Validate user is still active and token_version matches (catches post-reset sessions)
    const { data: user } = await getSupabase()
      .from("users")
      .select("id, is_active, token_version, role")
      .eq("id", payload.sub)
      .single();

    if (!user || user.is_active === false) {
      errorResponse(res, "Account not found or disabled", 401);
      return;
    }

    if (
      typeof user.token_version === "number" &&
      typeof payload.token_version === "number" &&
      payload.token_version !== user.token_version
    ) {
      errorResponse(res, "Session invalidated. Please log in again.", 401);
      return;
    }

    // Use role from DB (source of truth), not from JWT claim
    req.user = { id: payload.sub, email: payload.email, role: user.role ?? payload.role };
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      errorResponse(res, "Token expired", 401);
    } else if (err instanceof jwt.JsonWebTokenError) {
      errorResponse(res, "Invalid token", 401);
    } else {
      errorResponse(res, "Authentication failed", 401);
    }
  }
}

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      errorResponse(res, "Unauthorized", 401);
      return;
    }
    if (!roles.includes(req.user.role)) {
      errorResponse(res, "Insufficient permissions", 403);
      return;
    }
    next();
  };
}
