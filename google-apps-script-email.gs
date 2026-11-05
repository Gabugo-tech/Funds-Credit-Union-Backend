/**
 * Google Apps Script — Email Sender for Funds Credit Union
 * 
 * SETUP:
 * 1. Go to https://script.google.com
 * 2. Create new project → paste this code
 * 3. Deploy → New deployment → Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4. Copy the Web App URL
 * 5. Add to Railway env: GOOGLE_APPS_SCRIPT_URL=<your-url>
 * 
 * This script receives POST requests from your backend and sends emails
 * via your Gmail account (free, no API key needed).
 */

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    
    const to = body.to;
    const from = body.from || "noreply@fundscreditunion.com";
    const fromName = body.fromName || "Funds Credit Union";
    const subject = body.subject;
    const htmlBody = body.htmlBody;
    const textBody = body.textBody || "";

    if (!to || !subject) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "Missing required fields: to, subject"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // Send email via Gmail
    GmailApp.sendEmail(to, subject, textBody, {
      htmlBody: htmlBody,
      name: fromName,
      replyTo: from,
    });

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      message: "Email sent successfully"
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// Test function — run this in the editor to verify it works
function testEmail() {
  const testData = {
    to: "your-email@example.com",  // Change this to your email
    subject: "Test Email from Funds Credit Union",
    htmlBody: "<h1>Test Email</h1><p>If you received this, the script is working!</p>",
    textBody: "Test Email - If you received this, the script is working!"
  };

  GmailApp.sendEmail(
    testData.to,
    testData.subject,
    testData.textBody,
    {
      htmlBody: testData.htmlBody,
      name: "Funds Credit Union"
    }
  );

  Logger.log("Test email sent to " + testData.to);
}
