import { Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { getSupabase } from "../services/supabase";
import { sendCreditAlert } from "../services/email";
import { AuthRequest } from "../middleware/auth";
import { successResponse, errorResponse } from "../utils/response";
import { AppError } from "../middleware/errorHandler";
import { logger } from "../utils/logger";

// Static FX rates relative to USD (in production: fetch from live rate provider)
const FX_RATES: Record<string, number> = {
  USD:1, EUR:0.92, GBP:0.79, NGN:1620, CAD:1.36, AUD:1.53,
  JPY:157, CHF:0.90, INR:84, CNY:7.27, BRL:5.05, MXN:17.1,
  ZAR:18.6, SGD:1.34, AED:3.67, THB:35.1, TWD:32.4,
};

const sendSchema = z.object({
  from_account_id:    z.string().min(1, "Account ID required"),
  to_account_number:  z.string().min(5),
  recipient_name:     z.string().min(2),
  amount:             z.coerce.number().positive(),
  from_currency:      z.string().length(3),
  to_currency:        z.string().length(3),
  description:        z.string().min(1).max(120),
  transfer_type:      z.enum(["local", "international"]),
  payment_pin:        z.string().length(4).regex(/^\d{4}$/, "PIN must be 4 digits"),
  recipient_email:    z.string().email().optional().or(z.literal("")), // optional credit alert email
});

export async function sendMoney(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const body = sendSchema.parse(req.body);
    const supabase = getSupabase();

    // Verify account ownership
    const { data: account, error: accErr } = await supabase
      .from("bank_accounts")
      .select("id, balance, available_balance, currency")
      .eq("id", body.from_account_id)
      .eq("user_id", req.user!.id)
      .single();

    if (accErr || !account) return errorResponse(res, "Account not found", 404);

    // Verify payment PIN before touching any balances
    const { data: userPinData } = await supabase
      .from("users")
      .select("payment_pin_hash")
      .eq("id", req.user!.id)
      .single();

    if (!userPinData?.payment_pin_hash) {
      return errorResponse(res, "No payment PIN set. Please set a PIN in your settings.", 400);
    }
    const pinValid = await bcrypt.compare(body.payment_pin, userPinData.payment_pin_hash);
    if (!pinValid) return errorResponse(res, "Incorrect payment PIN", 401);

    const balance          = typeof account.balance === "string" ? parseFloat(account.balance) : Number(account.balance);
    const availableBalance = typeof account.available_balance === "string" ? parseFloat(account.available_balance) : Number(account.available_balance ?? account.balance);

    // Fee is always $2.50 USD for international — convert to account's native currency
    const feeUSD              = body.transfer_type === "international" ? 2.5 : 0;
    const accountCurrency     = (account.currency as string).toUpperCase();
    const fromCurrencyUC      = body.from_currency.toUpperCase();
    const accountRate         = FX_RATES[accountCurrency] ?? 1;
    const fromRate            = FX_RATES[fromCurrencyUC]  ?? 1;
    // Convert: amount (in from_currency) → USD → account currency
    const conversionRatio         = accountRate / fromRate;
    const amountInAccountCurrency = body.amount * conversionRatio;
    // Fee: always USD-denominated, convert to account currency
    const feeInAccountCurrency    = feeUSD * accountRate; // feeUSD * (accountRate / USD_rate=1)
    const totalDebit              = amountInAccountCurrency + feeInAccountCurrency;

    logger.info(
      `[sendMoney] balance=${balance} ${accountCurrency} | ` +
      `send=${body.amount} ${fromCurrencyUC} → ${amountInAccountCurrency.toFixed(4)} ${accountCurrency} | ` +
      `fee=$${feeUSD} USD → ${feeInAccountCurrency.toFixed(4)} ${accountCurrency} | ` +
      `totalDebit=${totalDebit.toFixed(4)} | type=${body.transfer_type}`
    );

    // Only block local transfers for insufficient funds.
    // Round to 2 decimal places to avoid floating-point precision issues
    // (e.g. balance stored as 29.589999 displayed as 29.59).
      if (body.transfer_type === "local" && Math.round(balance * 100) < Math.round(totalDebit * 100)) {
        logger.warn(`[sendMoney] INSUFFICIENT: balance(${balance}) < totalDebit(${totalDebit.toFixed(4)})`);
        return errorResponse(res, "Insufficient balance", 422);
      }

    // Generate collision-proof references using UUID segments
    const baseRef     = uuidv4().replace(/-/g, "").slice(0, 16).toUpperCase();
    const reference   = `FCU${baseRef}`;
    const referenceCR = `${reference}CR`;
    const referenceDR = `${reference}DR`;

    // Look up recipient before touching balances
    const { data: recipientAccount } = await supabase
      .from("bank_accounts")
      .select("id, balance, available_balance, currency, user_id")
      .eq("account_number", body.to_account_number)
      .maybeSingle();

    const txStatus = recipientAccount ? "completed" : "pending";

    // 1. Insert the debit transaction record FIRST — validates DB constraints
    //    (e.g. status check) before any money moves. If this fails, no debit occurs.
    const { data: tx, error: txErr } = await supabase
      .from("transactions")
      .insert({
        id:                uuidv4(),
        user_id:           req.user!.id,
        account_id:        body.from_account_id,
        type:              "debit",
        status:            txStatus,
        amount:            body.amount,   // positive — type field signals direction
        currency:          fromCurrencyUC,
        description:       body.description,
        reference:         referenceDR,
        recipient_name:    body.recipient_name,
        recipient_account: body.to_account_number,
        category:          "Transfer",
      })
      .select()
      .single();

    if (txErr) throw new AppError(txErr.message, 500);

    // 2. Debit sender balance — only after transaction record is confirmed
    const newBalance          = balance          - totalDebit;
    const newAvailableBalance = availableBalance - totalDebit;
    const { error: debitErr } = await supabase
      .from("bank_accounts")
      .update({ balance: newBalance, available_balance: newAvailableBalance })
      .eq("id", body.from_account_id);

    if (debitErr) throw new AppError(debitErr.message, 500);

    // 3. Credit recipient if they have a Funds Credit Union account
    if (recipientAccount) {
      const recipientCurrency         = (recipientAccount.currency as string).toUpperCase();
      const recipientRate             = FX_RATES[recipientCurrency] ?? 1;
      // amount (in from_currency) → USD → recipient currency
      const creditAmount              = (body.amount / fromRate) * recipientRate;
      const recipientBalance          = typeof recipientAccount.balance === "string" ? parseFloat(recipientAccount.balance) : Number(recipientAccount.balance);
      const recipientAvailableBalance = typeof recipientAccount.available_balance === "string" ? parseFloat(recipientAccount.available_balance) : Number(recipientAccount.available_balance ?? recipientAccount.balance);

      await supabase
        .from("bank_accounts")
        .update({
          balance:           recipientBalance          + creditAmount,
          available_balance: recipientAvailableBalance + creditAmount,
        })
        .eq("id", recipientAccount.id);

      try {
        await supabase
          .from("transactions")
          .insert({
            id:                uuidv4(),
            user_id:           recipientAccount.user_id,
            account_id:        recipientAccount.id,
            type:              "credit",
            status:            "completed",
            amount:            creditAmount,
            currency:          recipientCurrency,
            description:       body.description,
            reference:         referenceCR,
            recipient_name:    body.recipient_name,
            recipient_account: body.to_account_number,
            category:          "Transfer",
          });
      } catch (creditErr) {
        logger.warn("[sendMoney] Credit transaction insert failed", creditErr);
      }
    }

    // 4. Send credit alert email if recipient email was provided
    //    Runs after the response is built — never blocks or fails the transfer.
    const recipientEmail = body.recipient_email?.trim();
    if (recipientEmail) {
      const toAmount = recipientAccount
        ? (body.amount / fromRate) * (FX_RATES[(recipientAccount.currency as string).toUpperCase()] ?? 1)
        : (body.amount / fromRate) * (FX_RATES[body.to_currency.toUpperCase()] ?? 1);

      // Look up sender's name
      const { data: senderUser } = await supabase
        .from("users")
        .select("full_name")
        .eq("id", req.user!.id)
        .single();

      sendCreditAlert({
        toEmail:      recipientEmail,
        senderName:   senderUser?.full_name ?? "Funds Credit Union User",
        amount:       body.amount,
        fromCurrency: fromCurrencyUC,
        toCurrency:   body.to_currency.toUpperCase(),
        toAmount:     +toAmount.toFixed(2),
        reference,
        description:  body.description,
        transferType: body.transfer_type,
        date:         new Date().toISOString(),
        recipientNewBalance: recipientAccount
          ? +(((typeof recipientAccount.balance === "string" ? parseFloat(recipientAccount.balance) : Number(recipientAccount.balance)) + (body.amount / fromRate) * (FX_RATES[(recipientAccount.currency as string).toUpperCase()] ?? 1))).toFixed(2)
          : undefined,
        recipientCurrency: recipientAccount
          ? (recipientAccount.currency as string).toUpperCase()
          : undefined,
      }).catch(err => logger.warn("[sendMoney] Credit alert email failed", err));
    }

    return successResponse(res, { transaction: tx, reference, fee: feeUSD }, "Transfer initiated", 201);
  } catch (err) {
    next(err);
  }
}

export async function exchange(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { from_currency, to_currency, amount } = z.object({
      from_currency: z.string().length(3),
      to_currency:   z.string().length(3),
      amount:        z.coerce.number().positive(),  // coerce handles string inputs from forms
    }).parse(req.body);

    const fromRate  = FX_RATES[from_currency] ?? 1;
    const toRate    = FX_RATES[to_currency]   ?? 1;
    const converted = (amount / fromRate) * toRate;

    return successResponse(res, {
      from: { currency: from_currency, amount },
      to:   { currency: to_currency,   amount: +converted.toFixed(6) },
      rate: +(toRate / fromRate).toFixed(6),
      fee:  0,
    }, "Exchange preview");
  } catch (err) {
    next(err);
  }
}

export async function getFxRates(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    return successResponse(res, {
      base: "USD",
      rates: FX_RATES,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
}

export async function getPairRate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { from, to } = req.params;
    const fromRate = FX_RATES[from.toUpperCase()];
    const toRate   = FX_RATES[to.toUpperCase()];
    if (!fromRate || !toRate) return errorResponse(res, "Unsupported currency pair", 400);
    return successResponse(res, { from, to, rate: +(toRate / fromRate).toFixed(6) });
  } catch (err) {
    next(err);
  }
}

export async function getPaymentHistory(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { data, error } = await getSupabase()
      .from("transactions")
      .select("*")
      .eq("user_id", req.user!.id)
      .in("type", ["debit", "credit", "transfer"])
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw new AppError(error.message, 500);
    return successResponse(res, data ?? []);
  } catch (err) {
    next(err);
  }
}

export async function cancelPayment(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // Cancel pending (external) transfers only — completed internal transfers cannot be reversed
    const { data, error } = await getSupabase()
      .from("transactions")
      .update({ status: "cancelled" })
      .eq("id", req.params.id)
      .eq("user_id", req.user!.id)
      .in("status", ["pending"])
      .select()
      .single();

    if (error || !data) return errorResponse(res, "Payment not found or cannot be cancelled", 404);
    return successResponse(res, data, "Payment cancelled");
  } catch (err) {
    next(err);
  }
}
