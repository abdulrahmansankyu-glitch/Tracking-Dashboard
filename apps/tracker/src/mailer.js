/**
 * Sending the reminder emails.
 *
 * Four transports behind one `send()`, because there is no single answer that
 * suits everyone:
 *
 *  * **Microsoft Graph** — for a company Microsoft 365 / Outlook mailbox. This
 *    is the supported route for such a mailbox and the one to reach for first:
 *    Microsoft has been retiring Basic authentication for SMTP in Exchange
 *    Online, and a Microsoft 365 account has no app-password equivalent, so a
 *    mailbox with MFA generally cannot authenticate over SMTP at all.
 *  * **SMTP** — a Gmail account with an app password, or the company's own
 *    relay. Nothing to sign up for, and the mail leaves from an address the
 *    team already recognises.
 *  * **Brevo** — an HTTP API with a free tier of 300 messages a day and a
 *    sender you verify by clicking a link, so it works without owning a domain.
 *  * **Resend** — an HTTP API, cleaner, but it wants a verified domain before
 *    it will send to anyone but you.
 *
 * **Credentials come from the environment and are never stored in the database
 * or returned by the API.** The Settings screen can see *whether* mail is
 * configured and which transport is in use; it cannot see or set the password.
 * A mail password that lives in a table is a mail password that leaves in a
 * database backup, and this table already sits beside the team's records.
 *
 * The HTTP transports use `fetch` directly rather than each vendor's SDK — one
 * POST of JSON does not justify a dependency, and Node 22 has `fetch` built in.
 */

const PROVIDERS = ['graph', 'smtp', 'brevo', 'resend'];

/** `"Engineering Tracker <tracker@example.com>"` → its two parts. */
export function parseAddress(value) {
  const raw = String(value ?? '').trim();
  const angled = raw.match(/^(.*?)<([^>]+)>$/);
  if (angled) {
    return {
      name: angled[1].trim().replace(/^["']|["']$/g, '') || null,
      email: angled[2].trim(),
    };
  }
  return { name: null, email: raw };
}

/**
 * Pick the transport from whichever credentials are present.
 *
 * Setting `TRACKER_MAIL_PROVIDER` is still allowed and wins, but having to name
 * the provider *and* supply its key is a second thing to get wrong for no gain.
 */
function detectProvider(env) {
  const named = String(env.TRACKER_MAIL_PROVIDER ?? '').trim().toLowerCase();
  if (PROVIDERS.includes(named)) return named;
  if (env.TRACKER_GRAPH_CLIENT_ID) return 'graph';
  if (env.TRACKER_SMTP_HOST) return 'smtp';
  if (env.TRACKER_BREVO_API_KEY) return 'brevo';
  if (env.TRACKER_RESEND_API_KEY) return 'resend';
  return 'none';
}

/**
 * Build the complete MIME message.
 *
 * Graph's JSON `message` object carries one body and one content type, so
 * sending through it would drop the plain-text alternative that every other
 * transport keeps. Graph also accepts a raw MIME message, which preserves it —
 * and nodemailer is already a dependency here and will assemble one without
 * opening a connection, so there is nothing extra to add or to hand-roll.
 */
async function buildMime(from, message) {
  const { createTransport } = await import('nodemailer');
  const transport = createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const info = await transport.sendMail({
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
  return info.message;
}

async function sendSmtp(env, from, message) {
  // Imported here rather than at the top so a deployment using an HTTP
  // transport, or none at all, never pays to load it.
  const { createTransport } = await import('nodemailer');
  const port = Number.parseInt(env.TRACKER_SMTP_PORT ?? '587', 10) || 587;
  const transport = createTransport({
    host: env.TRACKER_SMTP_HOST,
    port,
    // 465 is implicit TLS; 587 starts plain and upgrades with STARTTLS. Getting
    // this backwards is the usual reason a first attempt hangs rather than fails.
    secure: String(env.TRACKER_SMTP_SECURE ?? '').trim()
      ? env.TRACKER_SMTP_SECURE === 'true'
      : port === 465,
    auth: env.TRACKER_SMTP_USER
      ? { user: env.TRACKER_SMTP_USER, pass: env.TRACKER_SMTP_PASSWORD }
      : undefined,
  });

  try {
    await transport.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  } catch (error) {
    throw new Error(explainSmtpFailure(error));
  }
}

/**
 * Say what an SMTP refusal actually means.
 *
 * Mail servers answer in codes written for other mail servers. Microsoft's
 * `535 5.7.139 Authentication unsuccessful, the request did not meet the
 * criteria to be authenticated successfully` is the same sentence whether the
 * password is wrong, the mailbox has SMTP AUTH switched off, or the tenant
 * blocks Basic authentication entirely — three different problems with three
 * different fixes, and only one of them is worth retyping a password over.
 *
 * The server's own words are kept and the explanation added, never substituted:
 * the raw text is what an IT department will ask for.
 */
export function explainSmtpFailure(error) {
  const raw = String(error?.response ?? error?.message ?? error);
  const code = String(error?.code ?? '');

  const hint = (() => {
    if (/5\.7\.139|SmtpClientAuthentication is disabled|5\.7\.30/i.test(raw)) {
      return 'Microsoft 365 refused the sign-in itself, so the password is probably not the problem. It means one of: SMTP AUTH is switched off for this mailbox (it is off by default), the tenant blocks Basic authentication for SMTP, or the account uses MFA — which SMTP cannot satisfy, and Microsoft 365 has no app-password equivalent. All three need an administrator, or use Microsoft Graph instead.';
    }
    if (/5\.7\.57|Client (was )?not authenticated/i.test(raw)) {
      return 'The server wanted credentials and got none. Check TRACKER_SMTP_USER and TRACKER_SMTP_PASSWORD are both set.';
    }
    if (/Application-specific password required|5\.7\.9/i.test(raw)) {
      return 'Gmail needs an App Password here, not the account password. Google Account → Security → 2-Step Verification → App passwords.';
    }
    if (/Username and Password not accepted|5\.7\.8|535/.test(raw) || code === 'EAUTH') {
      return 'The username or password was rejected. For Gmail this must be an App Password; for Microsoft 365, SMTP AUTH also has to be enabled on the mailbox.';
    }
    if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNREFUSED') {
      return 'Could not reach the mail server. Check the host and port — 587 for STARTTLS, 465 for implicit TLS. A wrong port typically hangs rather than failing outright.';
    }
    return null;
  })();

  return hint ? `${raw.trim()}\n\n${hint}` : raw.trim();
}

async function postJson(url, headers, body, provider) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${provider} refused the message (${response.status}): ${detail.slice(0, 300)}`);
  }
  return response;
}

async function sendBrevo(env, from, message) {
  const sender = parseAddress(from);
  await postJson(
    'https://api.brevo.com/v3/smtp/email',
    { 'api-key': env.TRACKER_BREVO_API_KEY },
    {
      sender: { email: sender.email, name: sender.name ?? undefined },
      to: [{ email: message.to }],
      subject: message.subject,
      htmlContent: message.html,
      textContent: message.text,
    },
    'Brevo',
  );
}

async function sendResend(env, from, message) {
  await postJson(
    'https://api.resend.com/emails',
    { authorization: `Bearer ${env.TRACKER_RESEND_API_KEY}` },
    {
      from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    },
    'Resend',
  );
}

/**
 * Microsoft Graph, via the client-credentials flow.
 *
 * The app signs in as itself rather than as a person, so there is no password
 * to rotate when somebody leaves and no mailbox that stops sending when their
 * account is disabled. The mailbox it sends *from* is `TRACKER_MAIL_FROM`.
 *
 * Worth telling whoever registers the application: the `Mail.Send` application
 * permission is tenant-wide by default — it would let this app send as any
 * mailbox in the company. An **application access policy** scopes it to the one
 * mailbox, and asking for that up front is usually the difference between the
 * request being approved and being refused.
 *
 * Tokens are cached until shortly before they expire. They last about an hour,
 * and a run sends one message per person within a few seconds of itself, so
 * fetching a fresh token per recipient would be a needless round trip against
 * a login endpoint that rate-limits.
 */
function graphSender() {
  let cached = { token: null, expires: 0 };

  const accessToken = async (env) => {
    if (cached.token && Date.now() < cached.expires) return cached.token;

    const tenant = encodeURIComponent(env.TRACKER_GRAPH_TENANT_ID);
    const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.TRACKER_GRAPH_CLIENT_ID,
        client_secret: env.TRACKER_GRAPH_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Entra's own description names the actual problem — an expired secret, a
      // wrong tenant, consent never granted. Replacing it with "login failed"
      // would throw away the only useful part of the answer.
      throw new Error(
        `Microsoft refused the sign-in (${response.status}): ${
          body.error_description ?? body.error ?? 'no reason given'
        }`.split('\n')[0],
      );
    }

    cached = {
      token: body.access_token,
      // A minute of margin, so a token cannot expire between being checked and
      // being used on a slow connection.
      expires: Date.now() + Math.max(0, (body.expires_in ?? 3600) - 60) * 1000,
    };
    return cached.token;
  };

  return async (env, from, message) => {
    const token = await accessToken(env);
    const mailbox = encodeURIComponent(parseAddress(from).email);
    const mime = await buildMime(from, message);

    const response = await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/sendMail`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        // Not JSON: this posts the assembled MIME message, which is what keeps
        // the plain-text alternative alongside the HTML.
        'content-type': 'text/plain',
      },
      body: mime.toString('base64'),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Graph refused the message (${response.status}): ${detail.slice(0, 300)}`);
    }
  };
}

// Graph is built per mailer rather than once for the module, because it is the
// only sender holding state — a cached token belongs to the credentials it was
// issued for, not to the process.
const STATELESS_SENDERS = { smtp: sendSmtp, brevo: sendBrevo, resend: sendResend };

/** What is missing before this transport could send anything. */
function problemWith(provider, env, from) {
  if (provider === 'none') {
    return 'No mail transport is configured. For a company Outlook mailbox set TRACKER_GRAPH_CLIENT_ID; otherwise TRACKER_SMTP_HOST, TRACKER_BREVO_API_KEY or TRACKER_RESEND_API_KEY.';
  }
  // The transport's own credentials come first. Checking the from-address ahead
  // of them answered "set TRACKER_MAIL_FROM" to somebody who had in fact set it
  // and was missing a tenant ID — naming the wrong variable is worse than
  // naming none, because it sends them to look at something already correct.
  if (provider === 'graph') {
    for (const [key, name] of [
      ['TRACKER_GRAPH_TENANT_ID', 'directory (tenant) ID'],
      ['TRACKER_GRAPH_CLIENT_ID', 'application (client) ID'],
      ['TRACKER_GRAPH_CLIENT_SECRET', 'client secret value'],
    ]) {
      if (!String(env[key] ?? '').trim()) return `Set ${key} — the ${name} from the app registration.`;
    }
    // Graph sends *from a mailbox*, named by its address in the request path,
    // so this one has to be a real mailbox rather than any valid address.
    if (!parseAddress(from).email.includes('@')) {
      return 'Set TRACKER_MAIL_FROM to the Outlook mailbox the reminders should come from.';
    }
  }
  if (provider === 'smtp' && !env.TRACKER_SMTP_HOST) return 'Set TRACKER_SMTP_HOST.';
  if (provider === 'smtp' && env.TRACKER_SMTP_USER && !env.TRACKER_SMTP_PASSWORD) {
    return 'Set TRACKER_SMTP_PASSWORD (for Gmail this is an app password, not the account password).';
  }
  if (provider === 'brevo' && !env.TRACKER_BREVO_API_KEY) return 'Set TRACKER_BREVO_API_KEY.';
  if (provider === 'resend' && !env.TRACKER_RESEND_API_KEY) return 'Set TRACKER_RESEND_API_KEY.';

  if (!from || !parseAddress(from).email.includes('@')) {
    return 'Set TRACKER_MAIL_FROM to the address reminders should come from.';
  }
  return null;
}

/**
 * Build the mailer.
 *
 * Never throws on a missing transport — an unconfigured deployment must still
 * boot and serve the dashboard. `configured` is false and `send()` reports the
 * reason, which is what the Settings screen shows.
 */
export function createMailer(env = process.env) {
  const provider = detectProvider(env);
  const from = String(env.TRACKER_MAIL_FROM ?? '').trim();
  const problem = problemWith(provider, env, from);
  const senders = { ...STATELESS_SENDERS, graph: graphSender() };

  return {
    provider,
    from,
    configured: !problem,
    problem,

    async send(message) {
      if (problem) throw new Error(problem);
      await senders[provider](env, from, message);
    },

    /**
     * Send a batch, one at a time, collecting failures rather than stopping.
     *
     * Serial on purpose. The free tiers here are rate-limited (Brevo 300 a day,
     * Resend 100), the batch is one message per team member rather than
     * thousands, and one refused address must not cost everybody else theirs.
     */
    async sendAll(messages) {
      const sent = [];
      const failed = [];
      for (const message of messages) {
        try {
          await this.send(message);
          sent.push(message.to);
        } catch (error) {
          failed.push({ to: message.to, error: String(error?.message ?? error) });
        }
      }
      return { sent, failed };
    },
  };
}
