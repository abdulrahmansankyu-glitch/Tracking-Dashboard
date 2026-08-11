/**
 * Sending the reminder emails.
 *
 * Three transports behind one `send()`, because there is no single answer that
 * suits everyone:
 *
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

const PROVIDERS = ['smtp', 'brevo', 'resend'];

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
  if (env.TRACKER_SMTP_HOST) return 'smtp';
  if (env.TRACKER_BREVO_API_KEY) return 'brevo';
  if (env.TRACKER_RESEND_API_KEY) return 'resend';
  return 'none';
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

  await transport.sendMail({
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
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

const SENDERS = { smtp: sendSmtp, brevo: sendBrevo, resend: sendResend };

/** What is missing before this transport could send anything. */
function problemWith(provider, env, from) {
  if (provider === 'none') {
    return 'No mail transport is configured. Set TRACKER_SMTP_HOST, TRACKER_BREVO_API_KEY or TRACKER_RESEND_API_KEY.';
  }
  if (!from || !parseAddress(from).email.includes('@')) {
    return 'Set TRACKER_MAIL_FROM to the address reminders should come from.';
  }
  if (provider === 'smtp' && !env.TRACKER_SMTP_HOST) return 'Set TRACKER_SMTP_HOST.';
  if (provider === 'smtp' && env.TRACKER_SMTP_USER && !env.TRACKER_SMTP_PASSWORD) {
    return 'Set TRACKER_SMTP_PASSWORD (for Gmail this is an app password, not the account password).';
  }
  if (provider === 'brevo' && !env.TRACKER_BREVO_API_KEY) return 'Set TRACKER_BREVO_API_KEY.';
  if (provider === 'resend' && !env.TRACKER_RESEND_API_KEY) return 'Set TRACKER_RESEND_API_KEY.';
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

  return {
    provider,
    from,
    configured: !problem,
    problem,

    async send(message) {
      if (problem) throw new Error(problem);
      await SENDERS[provider](env, from, message);
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
