const { Meeting, ActionItem, Doc } = require('./models'), log = require('./logger');
const day = n => new Date(Date.now() + n * 864e5), h = d => [{ event: 'created', detail: d }];
module.exports = async () => {
  if (await Meeting.countDocuments()) return;
  const docs = await Doc.insertMany([
    { title: 'Release Checklist', tags: ['release', 'qa', 'deploy'], content: 'Steps before every production release: regression suite, changelog, rollback plan, on-call sign-off.' },
    { title: 'Vendor Onboarding Policy', tags: ['vendor', 'sla', 'security'], content: 'All vendors need a signed SLA, security questionnaire and data-processing agreement before access is granted.' },
    { title: 'Q4 Roadmap', tags: ['roadmap', 'planning'], content: 'Q4 priorities: mobile checkout revamp, analytics dashboard, vendor consolidation.' },
    { title: 'Incident Response Runbook', tags: ['incident', 'oncall'], content: 'Severity levels, paging policy, communication templates and post-mortem process.' }
  ]);
  const ref = (i, reason) => [{ docId: docs[i]._id, title: docs[i].title, reason }];
  const m1 = await Meeting.create({
    title: 'Sprint 42 Planning', participants: ['Asha', 'Rohan', 'Meera', 'Dev'], agenda: 'Scope, release readiness, vendor SLA', status: 'held',
    rawNotes: 'Release v4.2 slips to next Friday. Rohan owns the release checklist. Meera still drafting the vendor SLA.',
    summary: 'Release v4.2 moved to next Friday to finish QA. Vendor SLA is still pending and the Q4 roadmap was published.',
    decisions: ['Release v4.2 moves to next Friday', 'Vendor work blocked until SLA is signed'], linkedDocs: ref(0, 'Defines pre-release steps')
  });
  await ActionItem.insertMany([
    { meetingId: m1._id, title: 'Finalise release checklist for v4.2', owner: 'Rohan', dueDate: day(-3), history: h('Sprint 42 Planning'), linkedDocs: ref(0, 'Defines pre-release steps') },
    { meetingId: m1._id, title: 'Draft vendor SLA terms', owner: 'Meera', dueDate: day(-10), carryCount: 2, history: [...h('Sprint 40 Planning'), { event: 'carried_forward', detail: 'to Sprint 41' }, { event: 'carried_forward', detail: 'to Sprint 42' }], linkedDocs: ref(1, 'Lists SLA requirements') },
    { meetingId: m1._id, title: 'Update Q4 roadmap doc', owner: 'Asha', dueDate: day(-5), status: 'done', outcome: 'Published and shared with leadership', history: h('Sprint 42 Planning'), linkedDocs: ref(2, 'The doc being updated') }
  ]);
  await Meeting.create({
    title: 'Asha leave handover', type: 'handover', participants: ['Asha', 'Dev'], agenda: 'Hand over roadmap comms and vendor follow-ups before leave',
    rawNotes: 'Asha is on leave from Monday for 3 weeks. Dev takes over roadmap comms. Decided: the weekly roadmap update goes out Fridays and Dev owns it. Asha to share the vendor contact list with Dev by Thursday. Dev will schedule a review with finance next week. Incident runbook needs a refresh, nobody owns it yet, Meera might pick it up.'
  });
  log.info('seed.done');
};
