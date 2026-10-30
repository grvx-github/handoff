const m = require('mongoose'), { Schema } = m, OID = Schema.Types.ObjectId;
const link = { docId: OID, title: String, reason: String, _id: false };
const hist = { at: { type: Date, default: Date.now }, event: String, detail: String, _id: false };
exports.Meeting = m.model('Meeting', new Schema({
  title: { type: String, required: true }, type: { type: String, enum: ['meeting', 'handover'], default: 'meeting' },
  agenda: String, participants: [String], rawNotes: { type: String, default: '' }, summary: String, decisions: [String],
  status: { type: String, enum: ['draft', 'held', 'closed'], default: 'draft' }, previousMeetingId: OID, linkedDocs: [link]
}, { timestamps: true }));
exports.ActionItem = m.model('ActionItem', new Schema({
  meetingId: { type: OID, required: true, index: true }, title: { type: String, required: true }, owner: String, dueDate: Date,
  status: { type: String, enum: ['open', 'in_progress', 'done', 'dropped', 'carried'], default: 'open' },
  outcome: String, carriedFromId: OID, carryCount: { type: Number, default: 0 }, history: [hist], linkedDocs: [link]
}, { timestamps: true }));
exports.Doc = m.model('Doc', new Schema({ title: { type: String, required: true }, content: { type: String, required: true }, tags: [String] }, { timestamps: true }));
