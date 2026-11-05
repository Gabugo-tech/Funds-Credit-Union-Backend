import { Response, NextFunction, Request } from "express";
import multer from "multer";
import { z } from "zod";
import { getSupabase } from "../services/supabase";
import { AuthRequest } from "../middleware/auth";
import { successResponse, errorResponse } from "../utils/response";
import { AppError } from "../middleware/errorHandler";

// ─── Multer: memory storage, 5 MB limit, images only ─────────────────────────
export const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

export async function getProfile(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { data, error } = await getSupabase()
      .from("users")
      .select("id, email, full_name, phone, avatar_url, account_type, kyc_status, created_at")
      .eq("id", req.user!.id)
      .single();

    if (error || !data) return errorResponse(res, "User not found", 404);
    return successResponse(res, data);
  } catch (err) {
    next(err);
  }
}

export async function updateProfile(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const body = z.object({
      full_name: z.string().min(2).optional(),
      phone:     z.string().optional(),
      address:   z.string().optional(),
    }).parse(req.body);

    const { data, error } = await getSupabase()
      .from("users")
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq("id", req.user!.id)
      .select("id, email, full_name, phone, avatar_url, account_type, kyc_status")
      .single();

    if (error) throw new AppError(error.message, 500);
    return successResponse(res, data, "Profile updated");
  } catch (err) {
    next(err);
  }
}

export async function uploadAvatar(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
    if (!file) return errorResponse(res, "No file uploaded", 400);

    const supabase  = getSupabase();
    const userId    = req.user!.id;
    const ext       = file.mimetype.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
    const path      = `avatars/${userId}.${ext}`;

    // Check if bucket exists, create if not
    const { data: buckets } = await supabase.storage.listBuckets();
    const bucketExists = buckets?.some(b => b.name === "avatars");
    
    if (!bucketExists) {
      const { error: createErr } = await supabase.storage.createBucket("avatars", {
        public: true,
        fileSizeLimit: 5242880, // 5MB
        allowedMimeTypes: ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"],
      });
      if (createErr) {
        console.error("[uploadAvatar] Bucket creation failed:", createErr);
        throw new AppError("Storage bucket unavailable", 500);
      }
    }

    // Upsert into Supabase Storage bucket "avatars"
    const { error: uploadErr } = await supabase.storage
      .from("avatars")
      .upload(path, file.buffer, {
        contentType: file.mimetype,
        upsert:      true,         // overwrite previous avatar
      });

    if (uploadErr) throw new AppError(uploadErr.message, 500);

    // Get the public URL
    const { data: urlData } = supabase.storage
      .from("avatars")
      .getPublicUrl(path);

    const avatar_url = urlData.publicUrl;

    // Persist to users table
    const { data, error: updateErr } = await supabase
      .from("users")
      .update({ avatar_url, updated_at: new Date().toISOString() })
      .eq("id", userId)
      .select("id, email, full_name, avatar_url, account_type, kyc_status")
      .single();

    if (updateErr) throw new AppError(updateErr.message, 500);

    return successResponse(res, data, "Avatar updated");
  } catch (err) {
    next(err);
  }
}

export async function getKycStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { data, error } = await getSupabase()
      .from("users")
      .select("kyc_status")
      .eq("id", req.user!.id)
      .single();

    if (error || !data) return errorResponse(res, "User not found", 404);
    return successResponse(res, data);
  } catch (err) {
    next(err);
  }
}

export async function submitKyc(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // TODO: validate document uploads, store in Supabase Storage, trigger review
    const { error } = await getSupabase()
      .from("users")
      .update({ kyc_status: "pending" })
      .eq("id", req.user!.id);

    if (error) throw new AppError(error.message, 500);
    return successResponse(res, { kyc_status: "pending" }, "KYC documents submitted");
  } catch (err) {
    next(err);
  }
}
