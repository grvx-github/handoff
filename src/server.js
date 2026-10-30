require('dotenv').config();
const express = require('express'), mongoose = require('mongoose'), { z } = require('zod'), { randomUUID } = require('crypto'), path = require('path');
const log = require('./logger'), { Meeting, ActionItem, Doc } = require('./models'), ai = require('./ai');

const app = express();
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => { // correlation id + request log
  req.id = req.get('x-request-id') || randomUUID(); res.set('x-request-id', req.id);
  req.log = log.child({ requestId: req.id }); const t = Date.now();
  res.on('finish', () => req.log[res.statusCode >= 500 ? 'error' : 'info']({ method: req.method, url: req.originalUrl, status: res.statusCode, ms: Date.now() - t }, 'request'));
  next();
});

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const h = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, r.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
};
const find = async (Model, id) => {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(400, 'Invalid id');
  const d = await Model.findById(id); if (!d) throw new HttpError(404, Model.modelName + ' not found'); return d;
};
const date = z.string().refine(s => !isNaN(Date.parse(s)), 'invalid date');
const meetingIn = z.object({
  title: z.string().trim().min(2).max(200), type: z.enum(['meeting', 'handover']).default('meeting'), agenda: z.string().max(5000).optional(),
  participants: z.array(z.string().trim().min(1)).default([]), rawNotes: z.string().max(50000).optional(), previousMeetingId: z.string().optional()
});
const meetingPatch = meetingIn.partial().extend({ status: z.enum(['draft', 'held', 'closed']).optional() });
const applyIn = z.object({
  summary: z.string().max(5000), decisions: z.array(z.string()).default([]),
  actionItems: z.array(z.object({ title: z.string().trim().min(2), owner: z.string().nullable().optional(), dueDate: date.nullable().optional() })).default([])
});
const actionPatch = z.object({ status: z.enum(['open', 'in_progress', 'done', 'dropped']).optional(), owner: z.string().trim().min(1).optional(), dueDate: date.nullable().optional(), outcome: z.string().trim().max(2000).optional() });
const docIn = z.object({ title: z.string().trim().min(2).max(200), content: z.string().trim().min(10).max(20000), tags: z.array(z.string().trim().min(1)).default([]) });

app.get('/api/health', (req, res) => res.json({ ok: true, ai: !!process.env.GEMINI_API_KEY }));

// ---- meetings
app.get('/api/meetings', h(async (req, res) => res.json(await Meeting.find().sort('-createdAt'))));
app.post('/api/meetings', h(async (req, res) => {
  const b = parse(meetingIn, req.body);
  const prev = b.previousMeetingId ? await find(Meeting, b.previousMeetingId) : null;
  const m = await Meeting.create(b); let carried = 0;
  if (prev) { // carry open items forward, preserving history
    for (const o of await ActionItem.find({ meetingId: prev._id, status: { $in: ['open', 'in_progress'] } })) {
      await ActionItem.create({
        meetingId: m._id, title: o.title, owner: o.owner, dueDate: o.dueDate, status: o.status, carriedFromId: o._id, carryCount: o.carryCount + 1, linkedDocs: o.linkedDocs,
        history: [...o.history.map(x => x.toObject()), { event: 'carried_forward', detail: `from "${prev.title}" to "${m.title}"` }]
      });
      o.status = 'carried'; o.history.push({ event: 'carried_forward', detail: `to "${m.title}"` }); await o.save(); carried++;
    }
  }
  req.log.info({ meetingId: m.id, type: m.type, carried }, 'meeting.created');
  res.status(201).json(m);
}));
app.get('/api/meetings/:id', h(async (req, res) => {
  const meeting = await find(Meeting, req.params.id);
  res.json({ meeting, items: await ActionItem.find({ meetingId: meeting._id }).sort('createdAt') });
}));
app.patch('/api/meetings/:id', h(async (req, res) => {
  const m = await find(Meeting, req.params.id); Object.assign(m, parse(meetingPatch, req.body)); await m.save();
  req.log.info({ meetingId: m.id, status: m.status }, 'meeting.updated'); res.json(m);
}));

// ---- AI
app.post('/api/meetings/:id/recap', h(async (req, res) => {
  const m = await find(Meeting, req.params.id), notes = req.body.notes ?? m.rawNotes ?? '';
  if (notes.trim().length < 20) throw new HttpError(400, 'Notes too short to summarise (min 20 characters)');
  if (req.body.notes !== undefined && notes !== m.rawNotes) { m.rawNotes = notes; await m.save(); } // never lose user input
  res.json(await ai.recap(notes, m, req.log));
}));
app.post('/api/meetings/:id/recap/apply', h(async (req, res) => {
  const m = await find(Meeting, req.params.id), b = parse(applyIn, req.body);
  const items = await ActionItem.insertMany(b.actionItems.map(a => ({
    meetingId: m._id, title: a.title, owner: a.owner || undefined, dueDate: a.dueDate ? new Date(a.dueDate) : undefined, history: [{ event: 'created', detail: `from "${m.title}"` }]
  })));
  const links = await ai.linkDocs([{ key: 'meeting', text: `${m.title}. ${b.summary}` }, ...items.map(i => ({ key: String(i._id), text: i.title }))], await Doc.find().lean(), req.log);
  Object.assign(m, { summary: b.summary, decisions: b.decisions, status: 'held', linkedDocs: links.meeting || [] }); await m.save();
  await Promise.all(items.filter(i => links[String(i._id)]).map(i => ActionItem.updateOne({ _id: i._id }, { linkedDocs: links[String(i._id)] })));
  items.forEach(i => req.log.info({ actionItemId: i.id, owner: i.owner, meetingId: m.id }, 'actionItem.created'));
  req.log.info({ meetingId: m.id, items: items.length }, 'meeting.recap_saved');
  res.json({ ok: true, items: items.length });
}));
app.get('/api/meetings/:id/brief', h(async (req, res) => {
  const m = await find(Meeting, req.params.id), person = String(req.query.person || '').trim();
  if (!person) throw new HttpError(400, 'person is required');
  const out = await ai.brief({ person, meeting: m, items: await ActionItem.find({ meetingId: m._id }) }, req.log);
  req.log.info({ meetingId: m.id, person, degraded: out.degraded }, 'brief.generated'); res.json(out);
}));

// ---- action items
app.get('/api/actions', h(async (req, res) => {
  const q = {}; if (req.query.owner) q.owner = String(req.query.owner); if (req.query.status) q.status = String(req.query.status);
  const items = await ActionItem.find(q).collation({ locale: 'en', strength: 2 }).sort('dueDate').lean();
  const ms = Object.fromEntries((await Meeting.find({}, 'title').lean()).map(m => [String(m._id), m.title]));
  res.json(items.map(i => ({ ...i, meetingTitle: ms[String(i.meetingId)] })));
}));
app.patch('/api/actions/:id', h(async (req, res) => {
  const it = await find(ActionItem, req.params.id), b = parse(actionPatch, req.body), push = (event, detail) => it.history.push({ event, detail });
  const closing = ['done', 'dropped'].includes(b.status);
  if (closing && !(b.outcome || it.outcome)) throw new HttpError(400, 'An outcome is required to close an item');
  if (b.owner && b.owner !== it.owner) { push('reassigned', `${it.owner || 'unassigned'} -> ${b.owner}`); req.log.info({ actionItemId: it.id, from: it.owner, to: b.owner }, 'actionItem.reassigned'); it.owner = b.owner; }
  if (b.dueDate !== undefined) { push('due_date_changed', String(b.dueDate)); it.dueDate = b.dueDate ? new Date(b.dueDate) : undefined; }
  if (b.outcome) it.outcome = b.outcome;
  if (b.status && b.status !== it.status) { push('status_changed', `${it.status} -> ${b.status}`); it.status = b.status; req.log.info({ actionItemId: it.id, status: b.status }, closing ? 'actionItem.closed' : 'actionItem.status_changed'); }
  await it.save(); res.json(it);
}));
app.get('/api/followups', h(async (req, res) => { // special feature: items that need chasing
  const now = new Date(), items = await ActionItem.find({ status: { $in: ['open', 'in_progress'] }, $or: [{ dueDate: { $lt: now } }, { carryCount: { $gte: 2 } }] }).sort('dueDate').lean();
  res.json(items.map(i => ({ ...i, reason: [i.dueDate && i.dueDate < now ? `overdue by ${Math.ceil((now - i.dueDate) / 864e5)}d` : null, i.carryCount >= 2 ? `carried forward ${i.carryCount}x` : null].filter(Boolean).join(', ') })));
}));
app.post('/api/actions/:id/nudge', h(async (req, res) => {
  const it = await find(ActionItem, req.params.id), out = await ai.nudge(it, await Meeting.findById(it.meetingId), req.log);
  req.log.info({ actionItemId: it.id, owner: it.owner, degraded: out.degraded }, 'followup.nudge_drafted'); res.json(out);
}));

// ---- knowledge base
app.get('/api/docs', h(async (req, res) => res.json(await Doc.find().sort('title'))));
app.post('/api/docs', h(async (req, res) => { const d = await Doc.create(parse(docIn, req.body)); req.log.info({ docId: d.id }, 'doc.created'); res.status(201).json(d); }));

// ---- import a document into a meeting (AI fills the fields; the user reviews before saving)
const importIn = z.object({ filename: z.string().trim().min(1).max(200).default('pasted text'), mimeType: z.string().optional(), data: z.string().optional(), text: z.string().optional() })
  .refine(b => b.data || (b.text && b.text.trim().length >= 20), 'Provide a file or at least 20 characters of text');
app.post('/api/meetings/import/preview', h(async (req, res) => {
  const b = parse(importIn, req.body), ext = path.extname(b.filename).toLowerCase();
  let text = (b.text || '').trim(), file = null;
  if (b.data) {
    const buf = Buffer.from(b.data, 'base64');
    if (ext === '.pdf' || b.mimeType === 'application/pdf') file = { mimeType: 'application/pdf', data: b.data };
    else if (ext === '.docx') text = (await require('mammoth').extractRawText({ buffer: buf }).catch(() => { throw new HttpError(400, 'Could not read this DOCX file'); })).value.trim();
    else if (['.txt', '.md', '.csv', '.json', '.log'].includes(ext)) text = buf.toString('utf8').trim();
    else throw new HttpError(415, 'Unsupported file type. Use PDF, DOCX, TXT or MD');
  }
  if (!file && text.length < 20) throw new HttpError(400, 'The document has no readable text');
  text = text.slice(0, 45000);
  const out = await ai.extractMeeting({ text: file ? '' : text, file, filename: b.filename }, req.log);
  if (!out) throw new HttpError(503, 'AI is unavailable and PDFs need it. Paste the text instead.');
  req.log.info({ filename: b.filename, chars: text.length, degraded: out.degraded }, 'meeting.import_previewed');
  res.json({ ...out, rawNotes: text || `Imported from ${b.filename}` });
}));

// ---- ask the knowledge base: answers grounded in documents and past meetings
app.post('/api/ask', h(async (req, res) => {
  const { question } = parse(z.object({ question: z.string().trim().min(3).max(500) }), req.body);
  const [docs, ms, items] = await Promise.all([Doc.find().lean(), Meeting.find().sort('-createdAt').lean(), ActionItem.find({ status: { $ne: 'carried' } }).lean()]);
  const sources = [
    ...docs.map((d, i) => ({ id: 'D' + (i + 1), kind: 'document', title: d.title, refId: String(d._id), text: d.content })),
    ...ms.map((m, i) => ({ id: 'M' + (i + 1), kind: 'meeting', title: m.title, refId: String(m._id), text: [
      m.summary && 'Summary: ' + m.summary, (m.decisions || []).length && 'Decisions: ' + m.decisions.join('; '),
      ...items.filter(a => String(a.meetingId) === String(m._id)).map(a => `Action item: ${a.title} (owner ${a.owner || 'unassigned'}, status ${a.status}${a.dueDate ? ', due ' + a.dueDate.toISOString().slice(0, 10) : ''}${a.outcome ? ', outcome: ' + a.outcome : ''})`),
      !m.summary && (m.rawNotes || '').slice(0, 2000)].filter(Boolean).join('\n') }))
  ];
  if (!sources.length) return res.json({ answer: 'The knowledge base is empty. Add a document or save a meeting recap first.', sources: [], degraded: false });
  const out = await ai.answer(question, sources, req.log);
  req.log.info({ questionChars: question.length, sources: out.sources.length, degraded: out.degraded }, 'knowledge.asked');
  res.json({ answer: out.answer, degraded: out.degraded, sources: out.sources.map(({ id, kind, title, refId }) => ({ id, kind, title, refId })) });
}));

app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));
app.use((e, req, res, next) => { // eslint-disable-line
  const s = e.status || (e.name === 'ValidationError' ? 400 : 500);
  (req.log || log)[s >= 500 ? 'error' : 'warn']({ err: e.message, stack: s >= 500 ? e.stack : undefined, url: req.originalUrl }, 'request.failed');
  res.status(s).json({ error: s >= 500 ? 'Internal server error' : e.message, requestId: req.id });
});

const port = process.env.PORT || 3000;
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/handoff')
  .then(() => { log.info('db.connected'); return require('./seed')(); })
  .then(() => app.listen(port, () => log.info({ port }, 'server.started')))
  .catch(e => { log.fatal({ err: e.message }, 'startup.failed'); process.exit(1); });
