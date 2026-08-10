/**
 * Engineering Activity Tracker — HTTP server.
 *
 * One process serves both the API and the browser app, so the team gets a single
 * URL to share and there is no cross-origin configuration to get wrong.
 *
 * Access is per-person: everyone signs in, and an admin decides what each account
 * may do — read only, edit, or administer — and which registers it may open.
 * Every change is recorded against the account that made it.
 *
 * A deployment with no accounts yet falls back to the shared `TRACKER_ACCESS_CODE`,
 * which is also what authorises creating the first admin. That keeps an existing
 * deployment working through the upgrade and stops whoever finds the URL first
 * from claiming it.
 */

import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';

import {
  CONFIRM_TTL_MS,
  ROLES,
  ROLE_DESCRIPTIONS,
  buildUser,
  can,
  canUseRegister,
  hashPassword,
  normaliseEmail,
  passwordProblem,
  signToken,
  toUserApi,
  verifyPassword,
  verifyToken,
} from './auth.js';
import { buildWorkbook, inspectWorkbook, readSheet } from './excel.js';
import { buildReport } from './report.js';
import { sanitiseData, summarise } from './query.js';
import {
  AREA_OPTIONS,
  DUE_SOON_DAYS,
  PRIORITY_VALUES,
  REGISTERS,
  STATUSES,
  deriveRecord,
  getRegister,
  registerCatalogue,
} from './registers.js';
import { createStore, toRow } from './store.js';

// Re-exported so tests and the standalone build have one import for the dashboard.
export { summarise };

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, '..', 'public');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/** Uploaded workbooks awaiting confirmation, held between inspect and commit. */
const PENDING_UPLOADS = new Map();
const UPLOAD_TTL_MS = 30 * 60 * 1000;

function stashUpload(filename, buffer) {
  const token = randomUUID();
  PENDING_UPLOADS.set(token, { filename, buffer, at: Date.now() });
  for (const [key, value] of PENDING_UPLOADS) {
    if (Date.now() - value.at > UPLOAD_TTL_MS) PENDING_UPLOADS.delete(key);
  }
  return token;
}

/**
 * Who is doing this.
 *
 * The account on the request, once there is one. Before accounts existed the
 * name came from a header the browser filled in, which was fine when the only
 * gate was a shared code and nobody could be held to anything anyway.
 */
const actorOf = (req) => req.user?.name || String(req.get('x-user-name') ?? '').trim() || 'Unknown';

function asError(res, status, message) {
  return res.status(status).json({ error: message });
}

/**
 * Keep only real register ids. An empty list means "all registers", so a typo
 * that silently dropped every entry would read as unrestricted rather than as
 * the restriction somebody meant to apply.
 */
function sanitiseRegisters(input) {
  if (!Array.isArray(input)) return [];
  const known = new Set(REGISTERS.map((r) => r.id));
  return [...new Set(input.filter((id) => known.has(id)))];
}

export async function createApp(env = process.env) {
  const store = await createStore(env);
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));

  const accessCode = String(env.TRACKER_ACCESS_CODE ?? '').trim();
  const accessHash = accessCode
    ? createHash('sha256').update(accessCode).digest('hex')
    : null;

  /** Constant-time-ish comparison via hashing, so the code is never echoed back. */
  const codeMatches = (candidate) =>
    !accessHash ||
    createHash('sha256').update(String(candidate ?? '').trim()).digest('hex') === accessHash;

  /**
   * The secret that signs sessions.
   *
   * Taken from the environment when the operator sets one; otherwise generated
   * once and kept in the database. Generating it per boot would sign the whole
   * team out on every redeploy and every wake from sleep, which on a free
   * instance is several times a day.
   */
  let sessionSecret = String(env.TRACKER_SESSION_SECRET ?? '').trim();
  if (!sessionSecret) {
    sessionSecret = await store.getSetting('session_secret');
    if (!sessionSecret) {
      sessionSecret = randomUUID() + randomUUID();
      await store.setSetting('session_secret', sessionSecret);
    }
  }

  /** An admin seeded from the environment, for a deployment that starts locked. */
  if (env.TRACKER_ADMIN_EMAIL && env.TRACKER_ADMIN_PASSWORD && (await store.countUsers()) === 0) {
    await store.insertUser(
      buildUser({
        name: env.TRACKER_ADMIN_NAME || 'Administrator',
        email: env.TRACKER_ADMIN_EMAIL,
        password: env.TRACKER_ADMIN_PASSWORD,
        role: 'admin',
      }),
    );
    console.log('[tracker] created the first admin account from the environment');
  }

  /** Attach the signed-in account to the request, when there is a valid token. */
  const withUser = async (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const userId = token ? verifyToken(token, sessionSecret) : null;
    if (userId) {
      const found = await store.findUserById(userId);
      if (found && found.active !== false) req.user = toUserApi(found);
    }
    next();
  };
  app.use(withUser);

  /**
   * Require an account, unless nobody has created one yet.
   *
   * Before the first account exists the app is open, so the first person can set
   * themselves up; the setup route itself is what is guarded, by the team access
   * code. After that, everything needs a session.
   */
  const requireAccess = (capability) => async (req, res, next) => {
    if ((await store.countUsers()) === 0) {
      // No accounts yet: fall back to the shared code, so an existing deployment
      // keeps working right up until its owner creates the first login.
      if (!accessHash || codeMatches(req.get('x-access-code'))) return next();
      return asError(res, 401, 'Wrong or missing team access code.');
    }

    if (!req.user) return asError(res, 401, 'Please sign in.');
    if (capability && !can(req.user, capability)) {
      return asError(
        res,
        403,
        capability === 'manage'
          ? 'Only an admin can change accounts and permissions.'
          : 'Your account has view-only access. Ask an admin if you need to make changes.',
      );
    }

    // Managing accounts needs the password again, recently.
    //
    // Being signed in is not enough for the one screen that decides who gets in:
    // an admin who walks away from an unlocked browser would otherwise be leaving
    // the permissions open to whoever sits down next.
    if (capability === 'manage') {
      const confirmed = verifyToken(req.get('x-confirm-token'), sessionSecret, 'confirm');
      if (confirmed !== req.user.id) {
        return res.status(403).json({
          error: 'Confirm your password to open Settings.',
          needsConfirmation: true,
        });
      }
    }

    next();
  };

  /** Narrow a records query to the registers this account may see. */
  const scopeQuery = (req, query) => {
    const allowed = req.user?.registers ?? [];
    return allowed.length ? { ...query, registers: allowed.join(',') } : query;
  };

  const scopeRecords = (req, records) => {
    const allowed = req.user?.registers ?? [];
    return allowed.length ? records.filter((r) => allowed.includes(r.register)) : records;
  };

  /**
   * Whether this request may touch a register.
   *
   * No signed-in account means the deployment has no accounts yet — the shared
   * code is still the gate, and register restrictions have nobody to apply to.
   * Asking `canUseRegister` directly gets this wrong: with no user it answers
   * "no", which locked the pre-accounts path out of every register.
   */
  const mayUseRegister = (req, registerId) => !req.user || canUseRegister(req.user, registerId);

  /** Refuse a register this account is not allowed to touch, and say so. */
  const allowRegister = (req, res, registerId) => {
    if (mayUseRegister(req, registerId)) return true;
    asError(res, 403, 'Your account does not have access to that register.');
    return false;
  };

  // ---- Open endpoints -----------------------------------------------------

  app.get('/api/health', async (_req, res) => {
    res.json({
      ok: true,
      storage: store.kind,
      registers: REGISTERS.length,
      // Named capabilities rather than a version string: this answers "is the
      // thing I just deployed actually running?" without anyone reading a log.
      features: ['accounts', 'register-permissions', 'settings-password-confirm'],
      accounts: await store.countUsers(),
    });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      requiresAccessCode: Boolean(accessHash),
      storage: store.kind,
      dueSoonDays: DUE_SOON_DAYS,
      priorities: PRIORITY_VALUES,
      statuses: STATUSES,
      areas: AREA_OPTIONS,
      registers: registerCatalogue(),
    });
  });

  app.post('/api/session', (req, res) => {
    if (!codeMatches(req.body?.accessCode)) {
      return asError(res, 401, 'That team access code is not right.');
    }
    res.json({ ok: true });
  });

  // ---- Accounts -----------------------------------------------------------

  const issue = async (user) => {
    await store.updateUser(user.id, { last_login_at: new Date().toISOString() });
    return { token: signToken(user.id, sessionSecret), user: toUserApi(user) };
  };

  app.get('/api/auth/state', async (_req, res, next) => {
    try {
      res.json({
        needsSetup: (await store.countUsers()) === 0,
        // The first account is created with the team access code, so somebody who
        // merely finds the URL before its owner does cannot make themselves admin.
        requiresSetupCode: Boolean(accessHash),
        roles: ROLES.map((role) => ({ value: role, description: ROLE_DESCRIPTIONS[role] })),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/setup', async (req, res, next) => {
    try {
      if ((await store.countUsers()) > 0) {
        return asError(res, 409, 'This tracker already has accounts. Sign in instead.');
      }
      if (!codeMatches(req.body?.accessCode)) {
        return asError(res, 401, 'That team access code is not right.');
      }

      const email = normaliseEmail(req.body?.email);
      if (!email.includes('@')) return asError(res, 400, 'Enter a valid email address.');

      const problem = passwordProblem(req.body?.password);
      if (problem) return asError(res, 400, problem);

      const user = await store.insertUser(
        buildUser({ name: req.body?.name, email, password: req.body.password, role: 'admin' }),
      );

      await store.logActivity({
        id: randomUUID(),
        at: new Date().toISOString(),
        actor: user.name,
        action: 'account',
        register: null,
        recordId: null,
        summary: `${user.name} created the first admin account`,
        detail: {},
      });

      res.status(201).json(await issue(user));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const email = normaliseEmail(req.body?.email);
      const found = await store.findUserByEmail(email);

      // One message for a wrong email and a wrong password: telling them apart
      // turns the login form into a way to enumerate who works here.
      if (!found || !verifyPassword(req.body?.password ?? '', found.password_hash)) {
        return asError(res, 401, 'That email and password do not match.');
      }
      if (found.active === false) {
        return asError(res, 403, 'That account has been switched off. Ask an admin.');
      }

      res.json(await issue(found));
    } catch (error) {
      next(error);
    }
  });

  /** Re-check the signed-in account's own password, for Settings. */
  app.post('/api/auth/confirm', requireAccess('read'), async (req, res, next) => {
    try {
      if (!req.user) return asError(res, 401, 'Please sign in.');

      const found = await store.findUserById(req.user.id);
      if (!verifyPassword(req.body?.password ?? '', found.password_hash)) {
        return asError(res, 401, 'That password is not right.');
      }

      res.json({
        confirmToken: signToken(found.id, sessionSecret, CONFIRM_TTL_MS, 'confirm'),
        expiresInMs: CONFIRM_TTL_MS,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/auth/me', requireAccess('read'), (req, res) => {
    res.json({ user: req.user ?? null });
  });

  app.post('/api/auth/password', requireAccess('read'), async (req, res, next) => {
    try {
      if (!req.user) return asError(res, 401, 'Please sign in.');

      const found = await store.findUserById(req.user.id);
      if (!verifyPassword(req.body?.currentPassword ?? '', found.password_hash)) {
        return asError(res, 401, 'Your current password is not right.');
      }

      const problem = passwordProblem(req.body?.newPassword);
      if (problem) return asError(res, 400, problem);

      await store.updateUser(found.id, { password_hash: hashPassword(req.body.newPassword) });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // ---- Managing the team --------------------------------------------------

  app.get('/api/users', requireAccess('manage'), async (_req, res, next) => {
    try {
      res.json({ users: (await store.listUsers()).map(toUserApi) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/users', requireAccess('manage'), async (req, res, next) => {
    try {
      const email = normaliseEmail(req.body?.email);
      if (!email.includes('@')) return asError(res, 400, 'Enter a valid email address.');
      if (await store.findUserByEmail(email)) {
        return asError(res, 409, 'Somebody already has an account with that email.');
      }

      const problem = passwordProblem(req.body?.password);
      if (problem) return asError(res, 400, problem);

      const user = await store.insertUser(
        buildUser({
          name: req.body?.name,
          email,
          password: req.body.password,
          role: req.body?.role,
          registers: sanitiseRegisters(req.body?.registers),
        }),
      );

      await store.logActivity({
        id: randomUUID(),
        at: new Date().toISOString(),
        actor: actorOf(req),
        action: 'account',
        register: null,
        recordId: null,
        summary: `Added ${user.name} as ${user.role}`,
        detail: {},
      });

      res.status(201).json(toUserApi(user));
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/users/:id', requireAccess('manage'), async (req, res, next) => {
    try {
      const found = await store.findUserById(req.params.id);
      if (!found) return asError(res, 404, 'That account no longer exists.');

      const patch = {};
      if (typeof req.body?.name === 'string') patch.name = req.body.name.trim().slice(0, 80);
      if (ROLES.includes(req.body?.role)) patch.role = req.body.role;
      if (Array.isArray(req.body?.registers)) patch.registers = sanitiseRegisters(req.body.registers);
      if (typeof req.body?.active === 'boolean') patch.active = req.body.active;

      if (req.body?.password) {
        const problem = passwordProblem(req.body.password);
        if (problem) return asError(res, 400, problem);
        patch.password_hash = hashPassword(req.body.password);
      }

      // Locking out the last admin would leave nobody able to unlock it — the one
      // change that cannot be undone from inside the app.
      const losingAdmin =
        found.role === 'admin' && (patch.role === 'viewer' || patch.role === 'editor' || patch.active === false);
      if (losingAdmin && (await countActiveAdmins(found.id)) === 0) {
        return asError(res, 400, 'This is the only admin. Make somebody else an admin first.');
      }

      const saved = await store.updateUser(found.id, patch);
      res.json(toUserApi(saved));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/users/:id', requireAccess('manage'), async (req, res, next) => {
    try {
      const found = await store.findUserById(req.params.id);
      if (!found) return asError(res, 404, 'That account no longer exists.');
      if (found.id === req.user?.id) {
        return asError(res, 400, 'You cannot delete the account you are signed in with.');
      }
      if (found.role === 'admin' && (await countActiveAdmins(found.id)) === 0) {
        return asError(res, 400, 'This is the only admin. Make somebody else an admin first.');
      }

      await store.deleteUser(found.id);
      await store.logActivity({
        id: randomUUID(),
        at: new Date().toISOString(),
        actor: actorOf(req),
        action: 'account',
        register: null,
        recordId: null,
        summary: `Removed the account for ${found.name}`,
        detail: {},
      });

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  /** Active admins other than `excludeId`. */
  async function countActiveAdmins(excludeId) {
    const users = await store.listUsers();
    return users.filter((u) => u.role === 'admin' && u.active !== false && u.id !== excludeId).length;
  }

  // ---- Records ------------------------------------------------------------

  app.get('/api/records', requireAccess('read'), async (req, res, next) => {
    try {
      if (req.query.register && !allowRegister(req, res, req.query.register)) return;
      res.json(await store.list(scopeQuery(req, req.query)));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/records/:id', requireAccess('read'), async (req, res, next) => {
    try {
      const record = await store.get(req.params.id);
      if (!record) return asError(res, 404, 'That entry no longer exists.');
      res.json(record);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/records', requireAccess('write'), async (req, res, next) => {
    try {
      const register = getRegister(req.body?.register);
      if (!register) return asError(res, 400, 'Choose a register for this entry.');
      if (!allowRegister(req, res, register.id)) return;

      const data = sanitiseData(register, req.body?.data);
      if (!Object.keys(data).length) return asError(res, 400, 'Fill in at least one field.');

      const actor = actorOf(req);
      const row = toRow({
        register: register.id,
        data,
        derived: deriveRecord(register, data),
        source: 'manual',
        actor,
      });

      await store.insertMany([row]);
      const saved = await store.get(row.id);

      await store.logActivity({
        id: randomUUID(),
        at: new Date().toISOString(),
        actor,
        action: 'create',
        register: register.id,
        recordId: row.id,
        summary: `Added ${register.name}: ${saved?.title ?? saved?.ref ?? 'new entry'}`,
        detail: {},
      });

      res.status(201).json(saved);
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/records/:id', requireAccess('write'), async (req, res, next) => {
    try {
      const existing = await store.get(req.params.id);
      if (!existing) return asError(res, 404, 'That entry no longer exists.');

      const register = getRegister(existing.register);
      if (!register) return asError(res, 400, 'That entry belongs to an unknown register.');
      if (!allowRegister(req, res, register.id)) return;

      // A PATCH carries only the fields that changed, so unmentioned columns keep
      // their imported values. An explicit empty string clears a field.
      const incoming = req.body?.data ?? {};
      const merged = { ...existing.data };
      for (const [key, value] of Object.entries(incoming)) {
        if (value === null || value === '') delete merged[key];
        else merged[key] = value;
      }

      const data = sanitiseData(register, merged);
      const actor = actorOf(req);

      const row = toRow({
        id: existing.id,
        register: register.id,
        data,
        derived: deriveRecord(register, data),
        source: existing.source,
        actor,
        createdAt: existing.createdAt,
        createdBy: existing.createdBy,
      });

      const saved = await store.updateRow(row);

      const changed = Object.keys(incoming).filter(
        (key) => String(existing.data?.[key] ?? '') !== String(incoming[key] ?? ''),
      );

      if (changed.length) {
        await store.logActivity({
          id: randomUUID(),
          at: new Date().toISOString(),
          actor,
          action: 'update',
          register: register.id,
          recordId: existing.id,
          summary: `Updated ${register.name}: ${saved?.title ?? saved?.ref ?? existing.id}`,
          detail: { fields: changed },
        });
      }

      res.json(saved);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/records/:id', requireAccess('write'), async (req, res, next) => {
    try {
      const existing = await store.get(req.params.id);
      if (!existing) return asError(res, 404, 'That entry no longer exists.');
      if (!allowRegister(req, res, existing.register)) return;

      await store.remove(req.params.id);
      await store.logActivity({
        id: randomUUID(),
        at: new Date().toISOString(),
        actor: actorOf(req),
        action: 'delete',
        register: existing.register,
        recordId: existing.id,
        summary: `Deleted: ${existing.title ?? existing.ref ?? existing.id}`,
        detail: {},
      });

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // ---- Dashboard ----------------------------------------------------------

  app.get('/api/dashboard', requireAccess('read'), async (req, res, next) => {
    try {
      const registerFilter = req.query.register || null;
      if (registerFilter && !allowRegister(req, res, registerFilter)) return;
      const records = scopeRecords(req, await store.all(registerFilter));
      const summary = summarise(records);

      // A restricted account gets cards only for its own registers. Leaving the
      // others in showed a row of empty rings for work the reader cannot open,
      // which reads as "there is nothing there" rather than "this is not yours".
      summary.byRegister = summary.byRegister.filter((r) => mayUseRegister(req, r.id));

      res.json({
        ...summary,
        activity: await store.recentActivity(15),
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/filters', requireAccess('read'), async (req, res, next) => {
    try {
      const records = scopeRecords(req, await store.all(req.query.register || null));
      const distinct = (key) =>
        [...new Set(records.map((r) => r[key]).filter(Boolean))].sort((a, b) =>
          String(a).localeCompare(String(b)),
        );
      res.json({
        actionBy: distinct('actionBy'),
        initiator: distinct('initiator'),
        area: distinct('area'),
        discipline: distinct('discipline'),
      });
    } catch (error) {
      next(error);
    }
  });

  // ---- Excel import -------------------------------------------------------

  app.post('/api/import/inspect', requireAccess('write'), upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return asError(res, 400, 'Attach an .xlsx file to upload.');

      const inspection = await inspectWorkbook(req.file.buffer);
      const token = stashUpload(req.file.originalname, req.file.buffer);

      // Last month's choices for a file of this name, so a recurring upload does
      // not mean re-picking every sheet. Only a suggestion — the confirm step still
      // shows what will happen and the user can change any of it.
      const remembered = await store.findMapping(req.file.originalname);

      res.json({ token, filename: req.file.originalname, remembered, ...inspection });
    } catch (error) {
      if (error?.message?.match(/zip|corrupt|end of central directory/i)) {
        return asError(res, 400, 'That file could not be read as an Excel workbook (.xlsx).');
      }
      next(error);
    }
  });

  app.post('/api/import/commit', requireAccess('write'), async (req, res, next) => {
    try {
      const pending = PENDING_UPLOADS.get(req.body?.token);
      if (!pending) {
        return asError(res, 410, 'That upload has expired — please choose the file again.');
      }

      const selections = Array.isArray(req.body?.selections) ? req.body.selections : [];
      if (!selections.length) return asError(res, 400, 'Choose at least one sheet to import.');

      const actor = actorOf(req);
      const results = [];
      const cleared = new Set();

      for (const selection of selections) {
        const register = getRegister(selection.register);
        if (!register) {
          results.push({ sheet: selection.sheet, error: `Unknown register: ${selection.register}` });
          continue;
        }
        if (!mayUseRegister(req, register.id)) {
          results.push({ sheet: selection.sheet, error: `No access to ${register.name}` });
          continue;
        }

        let extracted;
        try {
          extracted = await readSheet(pending.buffer, selection.sheet, register.id);
        } catch (error) {
          results.push({ sheet: selection.sheet, error: error.message });
          continue;
        }

        // "Replace" clears the register once per upload, not once per sheet.
        // A workbook can carry several sheets for the same register — SHP and DCU
        // master sheets both feeding IWS — and clearing per sheet meant the second
        // one deleted the rows the first had just imported, leaving only the last
        // sheet's rows behind. The intent of "replace" is that this file is the
        // master copy for that register, so its sheets land together.
        let replaced = 0;
        if (selection.mode === 'replace' && !cleared.has(register.id)) {
          replaced = await store.clearRegister(register.id);
          cleared.add(register.id);
        }

        const source = `import:${pending.filename}`;
        const rows = extracted.rows.map((data) =>
          toRow({
            register: register.id,
            data,
            derived: deriveRecord(register, data),
            source,
            actor,
          }),
        );

        await store.insertMany(rows);

        results.push({
          sheet: selection.sheet,
          register: register.id,
          registerName: register.name,
          imported: rows.length,
          skippedBlankRows: extracted.skipped,
          replaced,
          mode: selection.mode === 'replace' ? 'replace' : 'append',
          undated: rows.filter((r) => !r.due_date).length,
        });

        await store.logActivity({
          id: randomUUID(),
          at: new Date().toISOString(),
          actor,
          action: 'import',
          register: register.id,
          recordId: null,
          summary: `Imported ${rows.length} rows into ${register.name} from ${pending.filename}`,
          detail: { sheet: selection.sheet, replaced, mode: selection.mode ?? 'append' },
        });
      }

      // The uploaded workbook is kept so anyone can download exactly what was
      // imported — the record the team asked for — along with the choices made,
      // which is what makes the next upload of the same file one click.
      try {
        await store.saveImport({
          id: randomUUID(),
          filename: pending.filename,
          uploadedAt: new Date().toISOString(),
          uploadedBy: actor,
          sizeBytes: pending.buffer.length,
          sheetNames: selections.map((sel) => sel.sheet),
          mapping: selections,
          results,
          content: pending.buffer,
        });
      } catch (error) {
        // A failure to archive the file must not undo an import that succeeded.
        console.error('[tracker] could not store the uploaded file:', error);
      }

      res.json({ results });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/imports', requireAccess('read'), async (req, res, next) => {
    try {
      const all = await store.listImports();
      // Each register page shows the files that landed in it, so "where did this
      // row come from?" is answered on the page holding the row.
      const register = req.query.register ? String(req.query.register) : null;
      const imports = register
        ? all.filter((entry) => (entry.results ?? []).some((r) => r.register === register))
        : all;
      res.json({ imports });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/imports/:id/file', requireAccess('read'), async (req, res, next) => {
    try {
      const file = await store.getImportFile(req.params.id);
      if (!file) return asError(res, 404, 'That file is no longer stored.');

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      res.send(Buffer.from(file.content));
    } catch (error) {
      next(error);
    }
  });

  // ---- PDF report ---------------------------------------------------------

  app.get('/api/report.pdf', requireAccess('read'), async (req, res, next) => {
    try {
      const records = scopeRecords(req, await store.all(null));
      const summary = summarise(records);
      summary.byRegister = summary.byRegister.filter((r) => mayUseRegister(req, r.id));

      const allowed = req.user?.registers ?? [];
      const pdf = await buildReport({
        summary,
        // Short codes: the attention table's register column is narrow, and
        // "CTS Recommendation" wrapped to three lines in it.
        registerNames: new Map(REGISTERS.map((r) => [r.id, r.short])),
        logo: await store.getSetting('report_logo'),
        generatedBy: req.user?.name ?? null,
        // A restricted account's report must say what it covers, or it reads as
        // the whole department's position when it is only part of it.
        scopeNote: allowed.length
          ? `Covers ${allowed.map((id) => getRegister(id)?.name ?? id).join(', ')} only.`
          : null,
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="Engineering_Department_Updates_${new Date().toISOString().slice(0, 10)}.pdf"`,
      );
      res.send(pdf);
    } catch (error) {
      next(error);
    }
  });

  /** The logo printed on the report — uploaded once by an admin. */
  app.get('/api/report/logo', requireAccess('read'), async (_req, res, next) => {
    try {
      res.json({ logo: await store.getSetting('report_logo') });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/report/logo', requireAccess('manage'), async (req, res, next) => {
    try {
      const logo = req.body?.logo;

      if (logo === null || logo === '') {
        await store.setSetting('report_logo', '');
        return res.json({ ok: true, logo: null });
      }

      // A data URI, so the report needs nothing from the network when it prints.
      if (typeof logo !== 'string' || !/^data:image\/(png|jpeg|jpg);base64,/.test(logo)) {
        return asError(res, 400, 'Upload a PNG or JPG image.');
      }
      if (logo.length > 600_000) {
        return asError(res, 400, 'That image is too large — use one under about 400 KB.');
      }

      await store.setSetting('report_logo', logo);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // ---- Excel export -------------------------------------------------------

  app.get('/api/export', requireAccess('read'), async (req, res, next) => {
    try {
      const requested = req.query.register ? String(req.query.register) : null;
      if (requested && !allowRegister(req, res, requested)) return;
      const registers = (requested ? [getRegister(requested)].filter(Boolean) : REGISTERS).filter(
        (r) => mayUseRegister(req, r.id),
      );
      if (!registers.length) return asError(res, 400, 'Unknown register.');

      const groups = [];
      for (const register of registers) {
        groups.push({ register, records: await store.all(register.id) });
      }

      const buffer = await buildWorkbook(groups);
      const stamp = new Date().toISOString().slice(0, 10);
      const name = requested
        ? `${registers[0].name.replace(/\s+/g, '_')}_${stamp}.xlsx`
        : `Engineering_Tracker_${stamp}.xlsx`;

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.send(Buffer.from(buffer));
    } catch (error) {
      next(error);
    }
  });

  /** An empty workbook with the right headers — the fastest way to start a register. */
  app.get('/api/template', requireAccess('read'), async (req, res, next) => {
    try {
      const register = getRegister(req.query.register);
      if (!register) return asError(res, 400, 'Unknown register.');

      const buffer = await buildWorkbook([{ register, records: [] }]);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${register.name.replace(/\s+/g, '_')}_template.xlsx"`,
      );
      res.send(Buffer.from(buffer));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/activity', requireAccess('read'), async (_req, res, next) => {
    try {
      res.json({ activity: await store.recentActivity(60) });
    } catch (error) {
      next(error);
    }
  });

  // ---- Static app ---------------------------------------------------------

  /**
   * Serve the app so a deploy is visible on the next reload.
   *
   * These files were cached for an hour, which meant a fix could be deployed,
   * confirmed running in the logs, and still not reach anybody's browser until
   * the hour was up — indistinguishable from the deploy not having worked.
   * `maxAge: 0` with ETags means each load revalidates and gets a 304 when the
   * file has not changed, so the cost is a header exchange rather than the file.
   */
  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      etag: true,
      maxAge: 0,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    }),
  );
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return asError(res, 404, 'Unknown endpoint.');
    // The shell is never cached: it is what points at everything else.
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(join(PUBLIC_DIR, 'index.html'), (error) => (error ? next(error) : undefined));
  });

  app.use((error, _req, res, _next) => {
    if (error?.code === 'LIMIT_FILE_SIZE') {
      return asError(res, 413, 'That file is larger than the 25 MB limit.');
    }
    console.error('[tracker]', error);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return { app, store };
}

// Started directly (not imported by a test), so `node src/server.js` just works.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 4100);
  createApp()
    .then(({ app, store }) => {
      // Bound to 0.0.0.0 — the default localhost bind makes a hosted service
      // unreachable from outside, which is indistinguishable from a crash.
      app.listen(port, '0.0.0.0', () => {
        console.log(`[tracker] listening on http://0.0.0.0:${port} (storage: ${store.kind})`);
      });
    })
    .catch((error) => {
      console.error('[tracker] failed to start:', error);
      process.exit(1);
    });
}
