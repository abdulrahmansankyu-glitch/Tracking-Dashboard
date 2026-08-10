/**
 * Engineering Activity Tracker — HTTP server.
 *
 * One process serves both the API and the browser app, so the team gets a single
 * URL to share and there is no cross-origin configuration to get wrong.
 *
 * Access control is a shared team code, not per-person accounts. The team already
 * shares these workbooks over email; making everyone maintain a password to see a
 * tracker they can already read would add administration without adding privacy.
 * Each person types their name once, and it is recorded against everything they
 * change — which is the accountability the register columns actually ask for.
 */

import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';

import { buildWorkbook, inspectWorkbook, readSheet } from './excel.js';
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

const actorOf = (req) => {
  const name = String(req.get('x-user-name') ?? '').trim();
  return name ? name.slice(0, 80) : 'Unknown';
};

function asError(res, status, message) {
  return res.status(status).json({ error: message });
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

  const requireAccess = (req, res, next) => {
    if (!accessHash) return next();
    if (codeMatches(req.get('x-access-code'))) return next();
    return asError(res, 401, 'Wrong or missing team access code.');
  };

  // ---- Open endpoints -----------------------------------------------------

  app.get('/api/health', async (_req, res) => {
    res.json({ ok: true, storage: store.kind, registers: REGISTERS.length });
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

  // ---- Records ------------------------------------------------------------

  app.get('/api/records', requireAccess, async (req, res, next) => {
    try {
      res.json(await store.list(req.query));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/records/:id', requireAccess, async (req, res, next) => {
    try {
      const record = await store.get(req.params.id);
      if (!record) return asError(res, 404, 'That entry no longer exists.');
      res.json(record);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/records', requireAccess, async (req, res, next) => {
    try {
      const register = getRegister(req.body?.register);
      if (!register) return asError(res, 400, 'Choose a register for this entry.');

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

  app.patch('/api/records/:id', requireAccess, async (req, res, next) => {
    try {
      const existing = await store.get(req.params.id);
      if (!existing) return asError(res, 404, 'That entry no longer exists.');

      const register = getRegister(existing.register);
      if (!register) return asError(res, 400, 'That entry belongs to an unknown register.');

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

  app.delete('/api/records/:id', requireAccess, async (req, res, next) => {
    try {
      const existing = await store.get(req.params.id);
      if (!existing) return asError(res, 404, 'That entry no longer exists.');

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

  app.get('/api/dashboard', requireAccess, async (req, res, next) => {
    try {
      const registerFilter = req.query.register || null;
      const records = await store.all(registerFilter);
      res.json({
        ...summarise(records),
        activity: await store.recentActivity(15),
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/filters', requireAccess, async (req, res, next) => {
    try {
      const records = await store.all(req.query.register || null);
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

  app.post('/api/import/inspect', requireAccess, upload.single('file'), async (req, res, next) => {
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

  app.post('/api/import/commit', requireAccess, async (req, res, next) => {
    try {
      const pending = PENDING_UPLOADS.get(req.body?.token);
      if (!pending) {
        return asError(res, 410, 'That upload has expired — please choose the file again.');
      }

      const selections = Array.isArray(req.body?.selections) ? req.body.selections : [];
      if (!selections.length) return asError(res, 400, 'Choose at least one sheet to import.');

      const actor = actorOf(req);
      const results = [];

      for (const selection of selections) {
        const register = getRegister(selection.register);
        if (!register) {
          results.push({ sheet: selection.sheet, error: `Unknown register: ${selection.register}` });
          continue;
        }

        let extracted;
        try {
          extracted = await readSheet(pending.buffer, selection.sheet, register.id);
        } catch (error) {
          results.push({ sheet: selection.sheet, error: error.message });
          continue;
        }

        // "replace" is how a team that lives in Excel actually re-uploads: the sheet
        // is the truth, and yesterday's rows should not linger beside today's.
        const replaced =
          selection.mode === 'replace' ? await store.clearRegister(register.id) : 0;

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

  app.get('/api/imports', requireAccess, async (_req, res, next) => {
    try {
      res.json({ imports: await store.listImports() });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/imports/:id/file', requireAccess, async (req, res, next) => {
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

  // ---- Excel export -------------------------------------------------------

  app.get('/api/export', requireAccess, async (req, res, next) => {
    try {
      const requested = req.query.register ? String(req.query.register) : null;
      const registers = requested ? [getRegister(requested)].filter(Boolean) : REGISTERS;
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
  app.get('/api/template', requireAccess, async (req, res, next) => {
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

  app.get('/api/activity', requireAccess, async (_req, res, next) => {
    try {
      res.json({ activity: await store.recentActivity(60) });
    } catch (error) {
      next(error);
    }
  });

  // ---- Static app ---------------------------------------------------------

  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '1h' }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return asError(res, 404, 'Unknown endpoint.');
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
