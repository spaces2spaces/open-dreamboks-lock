import sgMail from '@sendgrid/mail';
import { db } from './db';
import { settings as settingsTable } from '@shared/schema';
import { appendHotelSlug } from '@shared/boarding-pass-url';
import { eq, and } from 'drizzle-orm';

export interface PasscodeNotification {
  guestName: string;
  email?: string;
  mobile?: string;
  passcode: string;
  roomName: string;
  arrival: Date;
  departure: Date;
  confirmationCode?: string;
}

export interface NotificationResult {
  success: boolean;
  smsDelivered?: boolean;
  emailDelivered?: boolean;
  whatsappDelivered?: boolean;
  error?: string;
}

export type NotificationChannel = "email" | "sms" | "whatsapp";

// SendGrid integration via Replit Connectors
async function getSendGridCredentials(): Promise<{ apiKey: string; fromEmail: string } | null> {
  // Try Replit Connectors first
  try {
    const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
    if (hostname) {
      const xReplitToken = process.env.REPL_IDENTITY
        ? 'repl ' + process.env.REPL_IDENTITY
        : process.env.WEB_REPL_RENEWAL
        ? 'depl ' + process.env.WEB_REPL_RENEWAL
        : null;

      if (xReplitToken) {
        const response = await fetch(
          'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=sendgrid',
          {
            headers: {
              'Accept': 'application/json',
              'X_REPLIT_TOKEN': xReplitToken
            }
          }
        );

        const data = await response.json();
        const connectionSettings = data.items?.[0];

        if (connectionSettings?.settings?.api_key && connectionSettings?.settings?.from_email) {
          console.log('[SendGrid] Using Replit Connectors, from email:', connectionSettings.settings.from_email);
          return {
            apiKey: connectionSettings.settings.api_key,
            fromEmail: connectionSettings.settings.from_email
          };
        }
      }
    }
  } catch (error) {
    console.error('[SendGrid] Replit Connectors lookup failed:', error);
  }

  // Fall back to environment variables
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL;
  if (apiKey && fromEmail) {
    console.log('[SendGrid] Using env vars, from email:', fromEmail);
    return { apiKey, fromEmail };
  }

  // No tenant-specific creds and no env vars: fall back to credentials stored
  // in the settings table (same unscoped first-row lookup pattern as Twilio,
  // see loadTwilioCredentials below). This lets platform-level emails — e.g.
  // vendor setup invitations sent via `new NotificationClient({})` — go out
  // even when no global SENDGRID_* env vars are configured on the host (Railway).
  try {
    const [apiKeyRow] = await db
      .select({ value: settingsTable.value })
      .from(settingsTable)
      .where(eq(settingsTable.key, 'sendgrid_api_key'));
    const [fromEmailRow] = await db
      .select({ value: settingsTable.value })
      .from(settingsTable)
      .where(eq(settingsTable.key, 'sendgrid_from_email'));
    if (apiKeyRow?.value && fromEmailRow?.value) {
      console.log('[SendGrid] Using DB settings, from email:', fromEmailRow.value);
      return { apiKey: apiKeyRow.value, fromEmail: fromEmailRow.value };
    }
  } catch (error) {
    console.error('[SendGrid] DB settings lookup failed:', error);
  }

  return null;
}

// Factory: load all credentials from tenant storage and return a configured client
export async function createNotificationClient(storage: {
  getSetting(key: string): Promise<{ value: string } | null | undefined>;
}): Promise<NotificationClient> {
  const [twilioSid, twilioToken, twilioFrom, twilioMessagingServiceSid, whatsappEnabled, sgKey, sgFrom, brand] = await Promise.all([
    storage.getSetting("twilio_account_sid"),
    storage.getSetting("twilio_auth_token"),
    storage.getSetting("twilio_from_number"),
    storage.getSetting("twilio_messaging_service_sid"),
    storage.getSetting("whatsapp_enabled"),
    storage.getSetting("sendgrid_api_key"),
    storage.getSetting("sendgrid_from_email"),
    buildEmailBrand(storage),
  ]);
  return new NotificationClient({
    twilioAccountSid: twilioSid?.value,
    twilioAuthToken: twilioToken?.value,
    twilioFromNumber: twilioFrom?.value,
    twilioMessagingServiceSid: twilioMessagingServiceSid?.value,
    whatsappEnabled: whatsappEnabled?.value === "true",
    sendgridApiKey: sgKey?.value,
    sendgridFromEmail: sgFrom?.value,
    brand,
  });
}

// Build a per-tenant email brand, gated by the `boarding_email_branded` opt-in flag
// so only tenants that opt in (e.g. Capsule) get branded emails; others stay default.
export async function buildEmailBrand(storage: {
  getSetting(key: string): Promise<{ value: string } | null | undefined>;
}): Promise<EmailBrand | undefined> {
  const [emailBranded, brandColor, brandName, logoUrl, appBaseUrl] = await Promise.all([
    storage.getSetting("boarding_email_branded"),
    storage.getSetting("boarding_brand_color"),
    storage.getSetting("boarding_brand_name"),
    storage.getSetting("boarding_logo_url"),
    storage.getSetting("app_base_url"),
  ]);
  if (emailBranded?.value !== "true") return undefined;
  return {
    color: brandColor?.value || "#509E2F",
    name: brandName?.value || "DreamBoks",
    logoUrl: resolveAbsoluteLogo(logoUrl?.value, appBaseUrl?.value),
  };
}

// Build an absolute logo URL for email (email clients can't resolve relative paths).
function resolveAbsoluteLogo(logoUrl: string | undefined, appBaseUrl: string | undefined): string | null {
  if (!logoUrl) return null;
  if (/^https?:\/\//.test(logoUrl)) return logoUrl;
  const base = (appBaseUrl || "https://lock.dreamboks.net").replace(/\/$/, "");
  return `${base}${logoUrl.startsWith("/") ? "" : "/"}${logoUrl}`;
}

export interface EmailBrand {
  color: string;
  name: string;
  logoUrl: string | null;
}

export class NotificationClient {
  private twilioAccountSid?: string;
  private twilioAuthToken?: string;
  private twilioFromNumber?: string;
  // Optional Messaging Service SID (e.g. Capsule's "Capsuleinn" sender pool). When set,
  // plain SMS sends use MessagingServiceSid instead of From so the sender name/pool
  // configured in Twilio is used. WhatsApp always uses twilioFromNumber directly —
  // Twilio's WhatsApp senders aren't addressed via a plain Messaging Service SID here.
  private twilioMessagingServiceSid?: string;
  // Per-tenant WhatsApp opt-in. Default OFF: none of our Twilio numbers are registered
  // WhatsApp senders, so every WhatsApp attempt fails with 63007. Set the
  // `whatsapp_enabled` setting to "true" only once a number is registered as a WhatsApp
  // Business sender in Twilio.
  private whatsappEnabled = false;
  private twilioLoaded = false;
  private sendgridApiKey?: string;
  private sendgridFromEmail?: string;
  // Optional per-tenant email branding (green header + logo for Capsule, etc.).
  // When unset, emails render the default DreamBoks look — so other tenants are unaffected.
  private brand?: EmailBrand;

  constructor(config: {
    twilioAccountSid?: string;
    twilioAuthToken?: string;
    twilioFromNumber?: string;
    twilioMessagingServiceSid?: string;
    whatsappEnabled?: boolean;
    sendgridApiKey?: string;
    sendgridFromEmail?: string;
    brand?: EmailBrand;
  } = {}) {
    this.twilioAccountSid = config.twilioAccountSid;
    this.twilioAuthToken = config.twilioAuthToken;
    this.twilioFromNumber = config.twilioFromNumber;
    this.twilioMessagingServiceSid = config.twilioMessagingServiceSid;
    this.whatsappEnabled = config.whatsappEnabled ?? false;
    this.sendgridApiKey = config.sendgridApiKey;
    this.sendgridFromEmail = config.sendgridFromEmail;
    this.brand = config.brand;
    if (config.twilioAccountSid || config.twilioAuthToken || config.twilioFromNumber || config.twilioMessagingServiceSid) {
      this.twilioLoaded = true;
    }
  }

  private async resolveSendGridCredentials(): Promise<{ apiKey: string; fromEmail: string } | null> {
    // Use tenant-specific credentials if provided
    if (this.sendgridApiKey && this.sendgridFromEmail) {
      return { apiKey: this.sendgridApiKey, fromEmail: this.sendgridFromEmail };
    }
    // Fall back to global lookup (env vars / DB)
    return getSendGridCredentials();
  }

  private async loadTwilioCredentials(): Promise<void> {
    if (this.twilioLoaded) return;
    this.twilioLoaded = true;
    try {
      const rows = await db.select({ key: settingsTable.key, value: settingsTable.value })
        .from(settingsTable)
        .where(
          and(
            eq(settingsTable.key, 'twilio_account_sid'),
          )
        );
      const sidRow = rows[0];

      const tokenRows = await db.select({ key: settingsTable.key, value: settingsTable.value })
        .from(settingsTable)
        .where(eq(settingsTable.key, 'twilio_auth_token'));
      const tokenRow = tokenRows[0];

      const fromRows = await db.select({ key: settingsTable.key, value: settingsTable.value })
        .from(settingsTable)
        .where(eq(settingsTable.key, 'twilio_from_number'));
      const fromRow = fromRows[0];

      const messagingServiceRows = await db.select({ key: settingsTable.key, value: settingsTable.value })
        .from(settingsTable)
        .where(eq(settingsTable.key, 'twilio_messaging_service_sid'));
      const messagingServiceRow = messagingServiceRows[0];

      if (sidRow?.value) this.twilioAccountSid = sidRow.value;
      if (tokenRow?.value) this.twilioAuthToken = tokenRow.value;
      if (fromRow?.value) this.twilioFromNumber = fromRow.value;
      if (messagingServiceRow?.value) this.twilioMessagingServiceSid = messagingServiceRow.value;
    } catch (error) {
      console.error('[Twilio] Failed to load credentials from DB:', error);
    }
  }

  // Sender param for plain SMS sends: prefer the Messaging Service (lets Twilio show a
  // configured sender name like "Capsuleinn" and handle sender-pool rotation) and fall
  // back to the bare From number for tenants that only have a phone number configured.
  private smsSenderParams(): { MessagingServiceSid: string } | { From: string } {
    if (this.twilioMessagingServiceSid) {
      return { MessagingServiceSid: this.twilioMessagingServiceSid };
    }
    return { From: this.twilioFromNumber! };
  }

  // Whether we have enough Twilio config to send a plain SMS (From number OR Messaging Service).
  private hasSmsSender(): boolean {
    return !!(this.twilioFromNumber || this.twilioMessagingServiceSid);
  }

  // Normalize a recipient number to E.164 for Twilio: strip spaces/dashes/parens and
  // ensure a leading "+". Numbers imported from the PMS sometimes lack the "+", which
  // Twilio rejects as an invalid "To" (error 21211). The WhatsApp path already does this;
  // this keeps the SMS path consistent.
  private normalizeRecipient(number: string): string {
    const cleaned = number.replace(/[\s\-()]/g, "");
    return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
  }

  private formatMessage(notification: PasscodeNotification): string {
    const arrivalDate = notification.arrival.toLocaleDateString();
    const departureDate = notification.departure.toLocaleDateString();

    return `Welcome ${notification.guestName}!

Your DreamBoks access code: ${notification.passcode}
Room: ${notification.roomName}
Valid: ${arrivalDate} - ${departureDate}
${notification.confirmationCode ? `Confirmation: ${notification.confirmationCode}` : ''}

Have a great stay!`;
  }

  async sendSMS(notification: PasscodeNotification): Promise<{ success: boolean; error?: string }> {
    if (!notification.mobile) {
      return { success: false, error: "No mobile number provided" };
    }

    await this.loadTwilioCredentials();

    if (!this.twilioAccountSid || !this.twilioAuthToken || !this.hasSmsSender()) {
      return { success: false, error: "Twilio not configured (missing credentials)" };
    }

    try {
      const message = this.formatMessage(notification);

      const auth = Buffer.from(`${this.twilioAccountSid}:${this.twilioAuthToken}`).toString('base64');

      const params = new URLSearchParams({
        To: this.normalizeRecipient(notification.mobile),
        ...this.smsSenderParams(),
        Body: message,
      });

      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${this.twilioAccountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params,
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = `Twilio API error ${errorJson.code}: ${errorJson.message}`;
        } catch {
          errorMessage = `Twilio HTTP ${response.status}: ${errorText}`;
        }
        console.error("Twilio SMS error:", errorMessage);
        return { success: false, error: errorMessage };
      }

      const data = await response.json();
      console.log(`SMS sent successfully to ${notification.mobile}, SID: ${data.sid}`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Failed to send SMS:", errorMessage);
      return { success: false, error: `Network error: ${errorMessage}` };
    }
  }

  async sendEmail(notification: PasscodeNotification): Promise<{ success: boolean; error?: string }> {
    if (!notification.email) {
      return { success: false, error: "No email address provided" };
    }

    try {
      const credentials = await this.resolveSendGridCredentials();
      if (!credentials) {
        return { success: false, error: "SendGrid not configured" };
      }

      sgMail.setApiKey(credentials.apiKey);

      const arrivalDate = notification.arrival.toLocaleDateString('en-GB');
      const departureDate = notification.departure.toLocaleDateString('en-GB');

      const msg = {
        to: notification.email,
        from: credentials.fromEmail,
        subject: `Your DreamBoks Access Code - ${notification.roomName}`,
        text: this.formatMessage(notification),
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #cc352a;">Welcome ${notification.guestName}!</h2>
            <p>Here is your access code for DreamBoks:</p>
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #cc352a;">${notification.passcode}</span>
            </div>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee;"><strong>Room:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${notification.roomName}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee;"><strong>Check-in:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${arrivalDate}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee;"><strong>Check-out:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${departureDate}</td>
              </tr>
              ${notification.confirmationCode ? `
              <tr>
                <td style="padding: 8px 0;"><strong>Confirmation:</strong></td>
                <td style="padding: 8px 0;">${notification.confirmationCode}</td>
              </tr>
              ` : ''}
            </table>
            <p style="margin-top: 20px; color: #666;">Enjoy your stay!</p>
          </div>
        `,
      };

      await sgMail.send(msg);
      console.log(`Email sent successfully to ${notification.email}`);
      return { success: true };
    } catch (error: any) {
      const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || String(error);
      console.error("Failed to send email:", errorMessage);
      return { success: false, error: `SendGrid error: ${errorMessage}` };
    }
  }

  async sendInvitationEmail(params: {
    email: string;
    hotelName: string;
    setupUrl: string;
    expiresAt: Date;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const credentials = await this.resolveSendGridCredentials();
      if (!credentials) {
        return { success: false, error: "SendGrid not configured" };
      }

      sgMail.setApiKey(credentials.apiKey);

      const expiryDate = params.expiresAt.toLocaleDateString("en-GB", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });

      const msg = {
        to: params.email,
        from: credentials.fromEmail,
        subject: `Welcome to DreamBoks - Setup for ${params.hotelName}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff; color: #232321;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #cc352a; margin: 0; font-size: 28px;">DreamBoks</h1>
              <p style="color: #232321; margin: 5px 0; opacity: 0.7;">Smart Lock Management</p>
            </div>
            <h2 style="color: #232321;">Welcome to DreamBoks!</h2>
            <p style="color: #232321;">You have been invited to set up <strong>${params.hotelName}</strong> on the DreamBoks platform.</p>
            <p style="color: #232321;">Click the button below to start the setup:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${params.setupUrl}" style="background: #cc352a; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
                Start Setup
              </a>
            </div>
            <p style="color: #232321; font-size: 14px; opacity: 0.7;">
              This link expires on ${expiryDate}.
            </p>
            <p style="color: #232321; font-size: 14px; opacity: 0.7;">
              If you cannot click the button, copy this link to your browser:<br>
              <a href="${params.setupUrl}" style="color: #cc352a;">${params.setupUrl}</a>
            </p>
            <hr style="border: none; border-top: 1px solid #c8d5e9; margin: 30px 0;">
            <p style="color: #232321; font-size: 12px; text-align: center; opacity: 0.5;">
              This is an automated email from DreamBoks. Please do not reply to this email.
            </p>
          </div>
        `,
      };

      await sgMail.send(msg);
      console.log(`Invitation email sent successfully to ${params.email}`);
      return { success: true };
    } catch (error: any) {
      const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || String(error);
      console.error("Failed to send invitation email:", errorMessage);
      return { success: false, error: `SendGrid error: ${errorMessage}` };
    }
  }

  async sendCredentialsEmail(params: {
    email: string;
    name: string;
    hotelName: string;
    password: string;
    loginUrl: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const credentials = await this.resolveSendGridCredentials();
      if (!credentials) {
        return { success: false, error: "SendGrid not configured" };
      }

      sgMail.setApiKey(credentials.apiKey);

      const msg = {
        to: params.email,
        from: credentials.fromEmail,
        subject: `Your DreamBoks Login Credentials - ${params.hotelName}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff; color: #232321;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #cc352a; margin: 0; font-size: 28px;">DreamBoks</h1>
              <p style="color: #232321; margin: 5px 0; opacity: 0.7;">Smart Lock Management</p>
            </div>
            <h2 style="color: #232321;">Welcome, ${params.name}!</h2>
            <p style="color: #232321;">Your DreamBoks account for <strong>${params.hotelName}</strong> has been created.</p>
            <p style="color: #232321;">Here are your login credentials:</p>
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0;"><strong>Email:</strong></td>
                  <td style="padding: 8px 0;">${params.email}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0;"><strong>Password:</strong></td>
                  <td style="padding: 8px 0; font-family: monospace; font-size: 16px;">${params.password}</td>
                </tr>
              </table>
            </div>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${params.loginUrl}" style="background: #cc352a; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
                Login to Dashboard
              </a>
            </div>
            <p style="color: #232321; font-size: 14px; opacity: 0.7;">
              We recommend changing your password after your first login.
            </p>
            <hr style="border: none; border-top: 1px solid #c8d5e9; margin: 30px 0;">
            <p style="color: #232321; font-size: 12px; text-align: center; opacity: 0.5;">
              This is an automated email from DreamBoks. Please do not reply to this email.
            </p>
          </div>
        `,
      };

      await sgMail.send(msg);
      console.log(`Credentials email sent successfully to ${params.email}`);
      return { success: true };
    } catch (error: any) {
      const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || String(error);
      console.error("Failed to send credentials email:", errorMessage);
      return { success: false, error: `SendGrid error: ${errorMessage}` };
    }
  }

  async sendPreCheckInPlainTextEmail(params: {
    email: string;
    guestName: string;
    hotelName: string;
    checkInUrl: string;
    arrivalDate: string;
    departureDate: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const credentials = await this.resolveSendGridCredentials();
      if (!credentials) {
        return { success: false, error: "SendGrid not configured" };
      }

      sgMail.setApiKey(credentials.apiKey);

      // Plain text fallback for email clients that don't support HTML
      const plainTextContent = `IMPORTANT MESSAGE - ACTION REQUIRED

To receive your digital key with hotel access you MUST complete online check-in before arrival.

Click here: ${params.checkInUrl}`;

      // Simple HTML version with URL as clickable link text (Booking.com compatible)
      const htmlContent = `IMPORTANT MESSAGE - ACTION REQUIRED<br><br>To receive your digital key with hotel access you MUST complete online check-in before arrival.<br><br>Click here: <a href="${params.checkInUrl}">${params.checkInUrl}</a>`;

      const msg = {
        to: params.email,
        from: credentials.fromEmail,
        subject: `Pre-arrival: Your access code for ${params.hotelName}`,
        text: plainTextContent,
        html: htmlContent,
        // Disable all tracking to prevent URL rewriting
        trackingSettings: {
          clickTracking: {
            enable: false,
            enableText: false,
          },
          openTracking: {
            enable: false,
          },
          subscriptionTracking: {
            enable: false,
          },
        },
      };

      const [response] = await sgMail.send(msg);
      console.log(`[SendGrid] Pre-check-in response: status=${response.statusCode}, headers=${JSON.stringify(response.headers)}`);
      console.log(`Pre-check-in email sent successfully to ${params.email}`);
      return { success: true };
    } catch (error: any) {
      const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || String(error);
      console.error("[SendGrid] Pre-check-in email FULL error:", JSON.stringify(error?.response?.body || error?.message || error));
      return { success: false, error: `SendGrid error: ${errorMessage}` };
    }
  }

  async sendCheckInLinkEmail(params: {
    email: string;
    guestName: string;
    checkInUrl: string;
    arrivalDate?: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const credentials = await this.resolveSendGridCredentials();
      if (!credentials) {
        return { success: false, error: "SendGrid not configured" };
      }

      sgMail.setApiKey(credentials.apiKey);

      const msg = {
        to: params.email,
        from: credentials.fromEmail,
        subject: `Your Check-In Link - DreamBoks`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff; color: #232321;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #cc352a; margin: 0; font-size: 28px;">DreamBoks</h1>
              <p style="color: #232321; margin: 5px 0; opacity: 0.7;">Smart Sleep Capsules</p>
            </div>
            <h2 style="color: #232321;">Hello ${params.guestName}!</h2>
            <p style="color: #232321;">Your reservation is ready for online check-in.</p>
            ${params.arrivalDate ? `<p style="color: #232321;"><strong>Arrival:</strong> ${params.arrivalDate}</p>` : ''}
            <p style="color: #232321;">Click the button below to complete your check-in and receive your access code:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${params.checkInUrl}" style="background: #cc352a; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
                Complete Check-In
              </a>
            </div>
            <p style="color: #232321; font-size: 14px; opacity: 0.7;">
              If you cannot click the button, copy this link to your browser:<br>
              <a href="${params.checkInUrl}" style="color: #cc352a;">${params.checkInUrl}</a>
            </p>
            <hr style="border: none; border-top: 1px solid #c8d5e9; margin: 30px 0;">
            <p style="color: #232321; font-size: 12px; text-align: center; opacity: 0.5;">
              This is an automated email from DreamBoks. Please do not reply to this email.
            </p>
          </div>
        `,
      };

      await sgMail.send(msg);
      console.log(`Check-in link email sent successfully to ${params.email}`);
      return { success: true };
    } catch (error: any) {
      const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || String(error);
      console.error("Failed to send check-in link email:", errorMessage);
      return { success: false, error: `SendGrid error: ${errorMessage}` };
    }
  }

  async sendBoardingPassEmail(params: {
    email: string;
    guestName: string;
    reservationNumber: string;
    lastName: string;
    arrivalDate: string;
    departureDate: string;
    baseUrl: string;
    hotelSlug?: string;
    accessCode?: string | null;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const credentials = await this.resolveSendGridCredentials();
      if (!credentials) {
        return { success: false, error: "SendGrid not configured" };
      }

      sgMail.setApiKey(credentials.apiKey);

      // Build direct link with reservation number and last name as URL params.
      // Append the tenant slug so non-default tenants resolve correctly.
      const boardingPassUrl = appendHotelSlug(
        `${params.baseUrl}/boarding-pass?res=${encodeURIComponent(params.reservationNumber)}&name=${encodeURIComponent(params.lastName)}`,
        params.hotelSlug,
      );

      // Booking-platform fallback: Booking.com (and some OTAs) strip the unique
      // boarding-pass link (it carries res/name params) from the guest message.
      // So we also expose the STATIC, param-free PIN check-in page + the PIN as
      // plain text — the guest opens the fixed link and types the code.
      // Requires a slug (the /:hotel/checkin route is slug-scoped).
      const checkinUrl = params.hotelSlug ? `${params.baseUrl}/${params.hotelSlug}/checkin` : null;

      // Per-tenant branding (green header + acorn for Capsule); defaults to the
      // existing DreamBoks look when no brand is configured — other tenants unchanged.
      const brandColor = this.brand?.color || "#cc352a";
      const brandName = this.brand?.name || "DreamBoks";
      const brandLogo = this.brand?.logoUrl || null;
      const headerHtml = this.brand
        ? `<div style="background: ${brandColor}; border-radius: 14px; padding: 22px 24px; text-align: center; margin-bottom: 28px;">
              ${brandLogo ? `<img src="${brandLogo}" alt="${brandName}" height="46" style="display:inline-block; height:46px; width:auto; margin-bottom:8px;" />` : ""}
              <div style="color:#ffffff; font-size:22px; font-weight:bold; letter-spacing:0.2px;">${brandName}</div>
            </div>`
        : `<div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: ${brandColor}; margin: 0; font-size: 28px;">DreamBoks</h1>
              <p style="color: #232321; margin: 5px 0; opacity: 0.7;">Smart Sleep Capsules</p>
            </div>`;

      const msg = {
        to: params.email,
        from: credentials.fromEmail,
        subject: `Your Digital Key is Ready - ${brandName}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff; color: #232321;">
            ${headerHtml}
            <h2 style="color: #232321;">Check-in Complete!</h2>
            <p style="color: #232321;">Hello ${params.guestName},</p>
            <p style="color: #232321;">Your online check-in is complete. Your digital key is now available with your access code.</p>
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #ddd;"><strong>Reservation:</strong></td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #ddd;">${params.reservationNumber}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #ddd;"><strong>Arrival:</strong></td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #ddd;">${params.arrivalDate}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0;"><strong>Departure:</strong></td>
                  <td style="padding: 8px 0;">${params.departureDate}</td>
                </tr>
              </table>
            </div>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${boardingPassUrl}" style="background: ${brandColor}; color: white; padding: 18px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; font-size: 18px;">
                Digital Key
              </a>
            </div>
            <p style="color: #232321; font-size: 14px; opacity: 0.7;">
              Click the button above to view your access code and digital key details.
            </p>
            <p style="color: #232321; font-size: 14px; text-align: center; margin-top: 15px;">
              <a href="${boardingPassUrl}" style="color: ${brandColor}; text-decoration: underline;">Click here and get your digital key</a>
            </p>
            ${checkinUrl && params.accessCode ? `
            <div style="background: #ffffff; border: 2px solid ${brandColor}; border-radius: 10px; padding: 20px; margin: 28px 0;">
              <p style="color: #232321; margin: 0 0 10px; font-weight: bold;">Booked via Booking.com or another platform?</p>
              <p style="color: #232321; margin: 0 0 14px; font-size: 14px;">
                If the buttons above are missing (some booking platforms remove personal links), open this page and enter your access code:
              </p>
              <p style="margin: 0 0 16px; text-align: center;">
                <a href="${checkinUrl}" style="color: ${brandColor}; font-weight: bold; word-break: break-all;">${checkinUrl}</a>
              </p>
              <div style="background: #f5f5f5; border-radius: 8px; padding: 14px; text-align: center;">
                <div style="color: #232321; font-size: 13px; opacity: 0.7; margin-bottom: 4px;">Your access code (PIN)</div>
                <div style="color: ${brandColor}; font-size: 30px; font-weight: bold; letter-spacing: 4px;">${params.accessCode}</div>
              </div>
            </div>` : ""}
            <hr style="border: none; border-top: 1px solid #c8d5e9; margin: 30px 0;">
            <p style="color: #232321; font-size: 12px; text-align: center; opacity: 0.5;">
              This is an automated email from ${brandName}. Please do not reply to this email.
            </p>
          </div>
        `,
      };

      const [response] = await sgMail.send(msg);
      console.log(`[SendGrid] Digital key response: status=${response.statusCode}, headers=${JSON.stringify(response.headers)}`);
      console.log(`Digital key email sent successfully to ${params.email}`);
      return { success: true };
    } catch (error: any) {
      const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || String(error);
      console.error("[SendGrid] Digital key email FULL error:", JSON.stringify(error?.response?.body || error?.message || error));
      return { success: false, error: `SendGrid error: ${errorMessage}` };
    }
  }

  async sendCancellationEmail(params: {
    email: string;
    guestName: string;
    reservationNumber: string;
    hotelName: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const credentials = await this.resolveSendGridCredentials();
      if (!credentials) {
        return { success: false, error: "SendGrid not configured" };
      }

      sgMail.setApiKey(credentials.apiKey);

      const msg = {
        to: params.email,
        from: credentials.fromEmail,
        subject: `Reservation Cancelled - ${params.hotelName}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff; color: #232321;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #cc352a; margin: 0; font-size: 28px;">DreamBoks</h1>
              <p style="color: #232321; margin: 5px 0; opacity: 0.7;">Smart Sleep Capsules</p>
            </div>
            <h2 style="color: #232321;">Reservation Cancelled</h2>
            <p style="color: #232321;">Hello ${params.guestName},</p>
            <p style="color: #232321;">Your reservation <strong>${params.reservationNumber}</strong> has been cancelled. Any digital access codes have been deactivated.</p>
            <p style="color: #232321;">If you believe this is an error, please contact reception.</p>
            <hr style="border: none; border-top: 1px solid #c8d5e9; margin: 30px 0;">
            <p style="color: #232321; font-size: 12px; text-align: center; opacity: 0.5;">
              This is an automated email from DreamBoks. Please do not reply to this email.
            </p>
          </div>
        `,
      };

      await sgMail.send(msg);
      console.log(`Cancellation email sent to ${params.email}`);
      return { success: true };
    } catch (error: any) {
      const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || String(error);
      console.error("Failed to send cancellation email:", errorMessage);
      return { success: false, error: `SendGrid error: ${errorMessage}` };
    }
  }

  async sendRoomChangeNotification(
    email: string,
    mobile: string,
    guestName: string,
    newRoomName: string,
    pinCode: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const credentials = await this.resolveSendGridCredentials();
      if (!credentials) {
        return { success: false, error: "SendGrid not configured" };
      }

      if (!email) {
        return { success: false, error: "No email address provided" };
      }

      sgMail.setApiKey(credentials.apiKey);

      const msg = {
        to: email,
        from: credentials.fromEmail,
        subject: `Room Changed - DreamBoks`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff; color: #232321;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #cc352a; margin: 0; font-size: 28px;">DreamBoks</h1>
              <p style="color: #232321; margin: 5px 0; opacity: 0.7;">Smart Sleep Capsules</p>
            </div>
            <h2 style="color: #232321;">Hello ${guestName}!</h2>
            <p style="color: #232321;">Your room has been changed. Here are your updated details:</p>
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0;"><strong>New Room:</strong></td>
                  <td style="padding: 8px 0;">${newRoomName}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0;"><strong>Access Code:</strong></td>
                  <td style="padding: 8px 0; font-family: monospace; font-size: 20px; color: #cc352a; font-weight: bold;">${pinCode}</td>
                </tr>
              </table>
            </div>
            <p style="color: #232321; font-size: 14px;">Your access code remains the same - it now works on your new room.</p>
            <hr style="border: none; border-top: 1px solid #c8d5e9; margin: 30px 0;">
            <p style="color: #232321; font-size: 12px; text-align: center; opacity: 0.5;">
              This is an automated email from DreamBoks. Please do not reply to this email.
            </p>
          </div>
        `,
      };

      await sgMail.send(msg);
      console.log(`Room change notification sent to ${email}`);
      return { success: true };
    } catch (error: any) {
      const errorMessage = error?.response?.body?.errors?.[0]?.message || error?.message || String(error);
      console.error("Failed to send room change notification:", errorMessage);
      return { success: false, error: `SendGrid error: ${errorMessage}` };
    }
  }

  async sendWhatsApp(params: {
    to: string;
    message: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (!params.to) {
      return { success: false, error: "No mobile number provided" };
    }

    // Opt-in gate: skip WhatsApp entirely unless this tenant has it enabled. Avoids
    // hitting Twilio (and the guaranteed 63007 "no WhatsApp channel for From") when no
    // number is registered as a WhatsApp Business sender.
    if (!this.whatsappEnabled) {
      return { success: false, error: "WhatsApp not enabled for this tenant" };
    }

    await this.loadTwilioCredentials();

    if (!this.twilioAccountSid || !this.twilioAuthToken || !this.twilioFromNumber) {
      return { success: false, error: "Twilio not configured (missing credentials)" };
    }

    try {
      const normalizedNumber = params.to.replace(/[\s\-\(\)]/g, "");
      const whatsappTo = normalizedNumber.startsWith("+") ? `whatsapp:${normalizedNumber}` : `whatsapp:+${normalizedNumber}`;
      const whatsappFrom = `whatsapp:${this.twilioFromNumber}`;

      const auth = Buffer.from(`${this.twilioAccountSid}:${this.twilioAuthToken}`).toString('base64');

      const body = new URLSearchParams({
        To: whatsappTo,
        From: whatsappFrom,
        Body: params.message,
      });

      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${this.twilioAccountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = `Twilio WhatsApp error ${errorJson.code}: ${errorJson.message}`;
        } catch {
          errorMessage = `Twilio HTTP ${response.status}: ${errorText}`;
        }
        console.error("WhatsApp error:", errorMessage);
        return { success: false, error: errorMessage };
      }

      const data = await response.json();
      console.log(`WhatsApp sent successfully to ${params.to}, SID: ${data.sid}`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Failed to send WhatsApp:", errorMessage);
      return { success: false, error: `Network error: ${errorMessage}` };
    }
  }

  async sendPreCheckInSMS(params: {
    mobile: string;
    pin: string;
    checkInUrl: string;
    hotelName: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (!params.mobile) {
      return { success: false, error: "No mobile number" };
    }
    await this.loadTwilioCredentials();
    if (!this.twilioAccountSid || !this.twilioAuthToken || !this.hasSmsSender()) {
      return { success: false, error: "Twilio not configured" };
    }

    // Mirror the pre-check-in EMAIL text so SMS and email say the same thing.
    const message = `IMPORTANT MESSAGE - ACTION REQUIRED\n\nTo receive your digital key with hotel access you MUST complete online check-in before arrival.\n\n${params.checkInUrl}`;

    const sid = this.twilioAccountSid!.trim();
    const token = this.twilioAuthToken!.trim();
    const senderParams = this.smsSenderParams();
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const body = new URLSearchParams({
      To: this.normalizeRecipient(params.mobile),
      ...senderParams,
      Body: message,
    });

    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
      console.log(`[Twilio SMS] Sending to ${params.mobile}, sender ${JSON.stringify(senderParams)}, URL: ${url}`);
      const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        }
      );
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Twilio SMS] HTTP ${response.status} error:`, errorText);
        return { success: false, error: `SMS error: ${errorText}` };
      }
      const data = await response.json();
      console.log(`Pre-check-in SMS sent to ${params.mobile}, SID: ${data.sid}`);
      return { success: true };
    } catch (error) {
      return { success: false, error: `Network error: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async sendPreCheckInWhatsApp(params: {
    mobile: string;
    pin: string;
    checkInUrl: string;
    hotelName: string;
  }): Promise<{ success: boolean; error?: string }> {
    // Mirror the pre-check-in EMAIL text so WhatsApp and email say the same thing.
    const message = `*IMPORTANT MESSAGE - ACTION REQUIRED*\n\nTo receive your digital key with hotel access you MUST complete online check-in before arrival.\n\n${params.checkInUrl}`;

    return this.sendWhatsApp({
      to: params.mobile,
      message,
    });
  }

  async sendBoardingPassSMS(params: {
    mobile: string;
    guestName: string;
    boardingPassUrl: string;
    hotelName: string;
  }): Promise<{ success: boolean; error?: string }> {
    const message = `${params.hotelName}: Your digital key is ready! Open it here: ${params.boardingPassUrl}`;

    if (!params.mobile) {
      return { success: false, error: "No mobile number" };
    }
    await this.loadTwilioCredentials();
    if (!this.twilioAccountSid || !this.twilioAuthToken || !this.hasSmsSender()) {
      return { success: false, error: "Twilio not configured" };
    }

    const auth = Buffer.from(`${this.twilioAccountSid}:${this.twilioAuthToken}`).toString('base64');
    const body = new URLSearchParams({
      To: this.normalizeRecipient(params.mobile),
      ...this.smsSenderParams(),
      Body: message,
    });

    try {
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${this.twilioAccountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        }
      );
      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `SMS error: ${errorText}` };
      }
      const data = await response.json();
      console.log(`Digital key SMS sent to ${params.mobile}, SID: ${data.sid}`);
      return { success: true };
    } catch (error) {
      return { success: false, error: `Network error: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async sendBoardingPassWhatsApp(params: {
    mobile: string;
    guestName: string;
    boardingPassUrl: string;
    hotelName: string;
  }): Promise<{ success: boolean; error?: string }> {
    const message = `*${params.hotelName}*\n\nHello ${params.guestName}! Your digital key is ready.\n\nOpen your digital key here:\n${params.boardingPassUrl}`;

    return this.sendWhatsApp({
      to: params.mobile,
      message,
    });
  }

  // Generic free-text email (subject + body). Reuses the tenant SendGrid resolution so
  // Capsule sends from noreply@hotelcapsuleinn.com. Newlines in `text` are preserved in HTML.
  async sendPlainTextEmail(params: { to: string; subject: string; text: string; html?: string }): Promise<{ success: boolean; error?: string }> {
    if (!params.to) return { success: false, error: "No email address provided" };
    try {
      const credentials = await this.resolveSendGridCredentials();
      if (!credentials) return { success: false, error: "SendGrid not configured" };
      sgMail.setApiKey(credentials.apiKey);
      // Use the caller's HTML when given; otherwise wrap the plain text. The
      // `text` part is always sent as the plain-text fallback.
      const escaped = params.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const html = params.html ?? `<div style="font-family: Arial, sans-serif; font-size: 16px; white-space: pre-wrap;">${escaped}</div>`;
      await sgMail.send({
        to: params.to,
        from: credentials.fromEmail,
        subject: params.subject,
        text: params.text,
        html,
        // Click tracking rewrites every link through SendGrid's tracking
        // subdomain (url####.<domain>). The root domain enforces HSTS with
        // includeSubDomains and the tracking host has no valid TLS cert, so
        // browsers HARD-block the rewritten links ("You can't add an
        // exception"). These are operational/guest messages — keep links
        // direct and untracked.
        trackingSettings: {
          clickTracking: { enable: false, enableText: false },
        },
      });
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Failed to send plain-text email:", errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  // Generic free-text SMS. Reuses the sender resolution (Messaging Service / from-number)
  // and E.164 normalization. No WhatsApp (opt-in, off by default).
  async sendPlainSMS(params: { to: string; body: string }): Promise<{ success: boolean; error?: string }> {
    if (!params.to) return { success: false, error: "No mobile number provided" };
    await this.loadTwilioCredentials();
    if (!this.twilioAccountSid || !this.twilioAuthToken || !this.hasSmsSender()) {
      return { success: false, error: "Twilio not configured (missing credentials)" };
    }
    try {
      const auth = Buffer.from(`${this.twilioAccountSid}:${this.twilioAuthToken}`).toString('base64');
      const p = new URLSearchParams({
        To: this.normalizeRecipient(params.to),
        ...this.smsSenderParams(),
        Body: params.body,
      });
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${this.twilioAccountSid}/Messages.json`,
        { method: 'POST', headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: p }
      );
      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `SMS error: ${errorText}` };
      }
      const data = await response.json();
      console.log(`Plain SMS sent to ${params.to}, SID: ${data.sid}`);
      return { success: true };
    } catch (error) {
      return { success: false, error: `Network error: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  isTwilioConfigured(): boolean {
    return !!(this.twilioAccountSid && this.twilioAuthToken && (this.twilioFromNumber || this.twilioMessagingServiceSid));
  }

  async sendMultiChannel(params: {
    channels: NotificationChannel[];
    email?: string;
    mobile?: string;
    emailSender: () => Promise<{ success: boolean; error?: string }>;
    smsSender: () => Promise<{ success: boolean; error?: string }>;
    whatsappSender: () => Promise<{ success: boolean; error?: string }>;
  }): Promise<{ emailDelivered: boolean; smsDelivered: boolean; whatsappDelivered: boolean; errors: string[] }> {
    const result = { emailDelivered: false, smsDelivered: false, whatsappDelivered: false, errors: [] as string[] };

    for (const channel of params.channels) {
      try {
        if (channel === "email" && params.email) {
          const r = await params.emailSender();
          result.emailDelivered = r.success;
          if (!r.success && r.error) result.errors.push(`Email: ${r.error}`);
        } else if (channel === "sms" && params.mobile) {
          const r = await params.smsSender();
          result.smsDelivered = r.success;
          if (!r.success && r.error) result.errors.push(`SMS: ${r.error}`);
        } else if (channel === "whatsapp" && params.mobile) {
          const r = await params.whatsappSender();
          result.whatsappDelivered = r.success;
          if (!r.success && r.error) result.errors.push(`WhatsApp: ${r.error}`);
        }
      } catch (error) {
        result.errors.push(`${channel}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return result;
  }

  async sendNotification(notification: PasscodeNotification): Promise<NotificationResult> {
    const errors: string[] = [];
    let smsDelivered = false;
    let emailDelivered = false;

    if (notification.mobile) {
      const smsResult = await this.sendSMS(notification);
      smsDelivered = smsResult.success;
      if (!smsResult.success && smsResult.error) {
        errors.push(`SMS: ${smsResult.error}`);
      }
    }

    if (notification.email) {
      const emailResult = await this.sendEmail(notification);
      emailDelivered = emailResult.success;
      if (!emailResult.success && emailResult.error) {
        errors.push(`Email: ${emailResult.error}`);
      }
    }

    if (!smsDelivered && !emailDelivered) {
      return {
        success: false,
        smsDelivered: false,
        emailDelivered: false,
        error: errors.length > 0 ? errors.join("; ") : "No contact information provided",
      };
    }

    return {
      success: true,
      smsDelivered,
      emailDelivered,
      error: errors.length > 0 ? errors.join("; ") : undefined,
    };
  }
}
