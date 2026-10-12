import { BrevoClient } from "@getbrevo/brevo";

if (!process.env.BREVO_API_KEY) {
  console.warn("[email] BREVO_API_KEY not set — emails will fail");
}

const client = new BrevoClient({ apiKey: process.env.BREVO_API_KEY ?? "" });

const FROM_EMAIL = process.env.BREVO_FROM_EMAIL ?? "noreply@fundscreditunion.com";
const FROM_NAME  = "Funds Credit Union";

async function send(to: string, subject: string, htmlContent: string, textContent: string) {
  await client.transactionalEmails.sendTransacEmail({
    sender:      { name: FROM_NAME, email: FROM_EMAIL },
    to:          [{ email: to }],
    subject,
    htmlContent,
    textContent,
  });
}

function buildOtpEmail(subtitle: string, message: string, otp: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
    body{font-family:sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:0}
    .c{max-width:480px;margin:40px auto;background:#1e293b;border-radius:16px;overflow:hidden;border:1px solid #334155}
    .h{background:linear-gradient(135deg,#2563eb,#1d4ed8);padding:32px 40px;text-align:center}
    .h h1{color:#fff;font-size:24px;margin:0;font-weight:700}
    .h p{color:rgba(255,255,255,.7);margin:6px 0 0;font-size:14px}
    .b{padding:36px 40px}
    .otp{background:#0f172a;border:2px solid #2563eb;border-radius:12px;padding:24px;text-align:center;margin:24px 0}
    .code{font-size:40px;font-weight:800;letter-spacing:12px;color:#60a5fa;font-family:monospace}
    .note{font-size:13px;color:#94a3b8;margin-top:8px}
    .warn{background:#451a03;border:1px solid #92400e;border-radius:8px;padding:12px 16px;font-size:13px;color:#fbbf24;margin-top:20px}
    .f{padding:20px 40px;border-top:1px solid #334155;font-size:12px;color:#475569;text-align:center}
  </style></head><body><div class="c">
    <div class="h"><h1>Funds Credit Union</h1><p>${subtitle}</p></div>
    <div class="b">
      <p>${message}</p>
      <div class="otp"><div class="code">${otp}</div><div class="note">Expires in 15 minutes</div></div>
      <div class="warn">⚠️ Never share this code. Funds Credit Union staff will never ask for your OTP.</div>
    </div>
    <div class="f">© 2026 Funds Credit Union</div>
  </div></body></html>`;
}

export async function sendPasswordResetOtp(toEmail: string, otp: string): Promise<void> {
  await send(toEmail, "Your Funds Credit Union Password Reset Code",
    buildOtpEmail("Reset your password", "Use the code below to reset your Funds Credit Union account password:", otp),
    `Your Funds Credit Union password reset code is: ${otp}\n\nExpires in 15 minutes.`
  );
}

export async function sendPinResetOtp(toEmail: string, otp: string): Promise<void> {
  await send(toEmail, "Your Funds Credit Union Payment PIN Reset Code",
    buildOtpEmail("Reset your payment PIN", "Use the code below to reset your Funds Credit Union payment PIN:", otp),
    `Your Funds Credit Union payment PIN reset code is: ${otp}\n\nExpires in 15 minutes.`
  );
}

export async function sendCreditAlert(params: {
  toEmail: string; senderName: string; amount: number; fromCurrency: string;
  toCurrency: string; toAmount: number; reference: string; description: string;
  transferType: "local" | "international"; date: string;
  recipientNewBalance?: number; recipientCurrency?: string;
}): Promise<void> {
  const { toEmail, senderName, amount, fromCurrency, toCurrency, toAmount, reference, description, transferType, date, recipientNewBalance, recipientCurrency } = params;
  const isIntl     = transferType === "international";
  const amountStr  = `${amount.toLocaleString(undefined, { minimumFractionDigits: 2 })} ${fromCurrency}`;
  const receiveStr = isIntl && toCurrency !== fromCurrency
    ? `${toAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })} ${toCurrency}`
    : amountStr;

  const balanceRow = (recipientNewBalance !== undefined && recipientCurrency)
    ? `<tr><td style="color:#94a3b8">Your New Balance</td><td style="text-align:right;font-weight:700;color:#4ade80;font-size:16px">${recipientNewBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })} ${recipientCurrency}</td></tr>`
    : "";

  const htmlContent = `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
    body{font-family:sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:0}
    .c{max-width:520px;margin:40px auto;background:#1e293b;border-radius:16px;overflow:hidden;border:1px solid #334155}
    .h{background:linear-gradient(135deg,#2563eb,#1d4ed8);padding:32px 40px;text-align:center}
    .h h1{color:#fff;font-size:24px;margin:0;font-weight:700}
    .h p{color:rgba(255,255,255,.7);margin:6px 0 0;font-size:14px}
    .b{padding:36px 40px}
    table{width:100%;border-collapse:collapse;font-size:14px}
    td{padding:10px 0;border-bottom:1px solid #334155}
    .f{padding:20px 40px;border-top:1px solid #334155;font-size:12px;color:#475569;text-align:center}
  </style></head><body><div class="c">
    <div class="h"><h1>Funds Credit Union</h1><p>You've received a transfer</p></div>
    <div class="b">
      <p>You have received a transfer from <strong>${senderName}</strong> via Funds Credit Union.</p>
      <table>
        <tr><td style="color:#94a3b8">Amount Sent</td><td style="text-align:right;font-weight:600">${amountStr}</td></tr>
        <tr><td style="color:#94a3b8">Amount to Receive</td><td style="text-align:right;font-weight:700;color:#60a5fa;font-size:18px">${receiveStr}</td></tr>
        <tr><td style="color:#94a3b8">From</td><td style="text-align:right;font-weight:600">${senderName}</td></tr>
        <tr><td style="color:#94a3b8">Reference</td><td style="text-align:right;font-family:monospace">${reference}</td></tr>
        <tr><td style="color:#94a3b8">Description</td><td style="text-align:right">${description}</td></tr>
        <tr><td style="color:#94a3b8">Date</td><td style="text-align:right">${new Date(date).toLocaleString()}</td></tr>
        ${balanceRow}
      </table>
      ${isIntl
        ? `<div style="margin-top:20px;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:14px;font-size:13px;color:#94a3b8">⏳ <strong style="color:#e2e8f0">International Transfer:</strong> Funds typically arrive within 1–3 business days.</div>`
        : `<div style="margin-top:20px;background:#052e16;border:1px solid #166534;border-radius:8px;padding:14px;font-size:13px;color:#86efac">✅ <strong>Local Transfer:</strong> Funds have been processed.</div>`}
    </div>
    <div class="f">© 2026 Funds Credit Union · Automated notification.</div>
  </div></body></html>`;

  await send(toEmail, `You've received ${receiveStr} from ${senderName}`, htmlContent,
    `You received ${receiveStr} from ${senderName}.\n\nRef: ${reference}\nDesc: ${description}\n${isIntl ? "Arrives in 1–3 business days." : "Funds processed."}`
  );
}
