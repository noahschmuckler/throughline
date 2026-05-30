// Demo data for Throughline — 3 projects + 3 reference files spread across
// one busy week (Mon..Fri of the week containing `now`) with backstory
// entries reaching ~5 weeks back. All dates are computed relative to `now`
// so the demo stays fresh whenever the seed script is re-run.
//
// Outcome atoms reference their parent action/decision by a string label
// (e.g. parentLabel: 'A-pull-invoices'). A two-pass resolver at the end
// rewrites these labels into real atom UUIDs.

import { randomUUID } from 'node:crypto';

export function buildDemoData(now = new Date()) {
  const containers = [];
  const entries = [];
  const atoms = [];
  const labels = new Map(); // label -> atom uuid

  // ---- date helpers ----
  // Offsets are in days from `now`. Negative = past, positive = future.
  // `now` is anchored to the start of its UTC day so the day-of-week
  // math is stable regardless of wall-clock time at seed time.
  const anchor = new Date(now);
  anchor.setUTCHours(0, 0, 0, 0);

  // Re-anchor so offset 0 is "Friday of the current week". For weekdays
  // (Mon-Thu) Friday is later in the same week (delta positive). For
  // Fri itself delta is 0. For weekend days we anchor to the Friday
  // that just passed (delta negative).
  // dayOfWeek: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat.
  const dow = anchor.getUTCDay();
  let deltaToFriday;
  if (dow === 0) deltaToFriday = -2;      // Sun -> previous Fri
  else if (dow === 6) deltaToFriday = -1; // Sat -> previous Fri
  else deltaToFriday = 5 - dow;           // Mon..Fri -> upcoming/today Fri
  anchor.setUTCDate(anchor.getUTCDate() + deltaToFriday);

  function offsetIso(daysOffset, hh = 14, mm = 0) {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() + daysOffset);
    d.setUTCHours(hh, mm, 0, 0);
    return d.toISOString();
  }
  function offsetDate(daysOffset) {
    return offsetIso(daysOffset, 0, 0).slice(0, 10);
  }

  // ---- builders ----
  function pushContainer(c) {
    containers.push({
      id: c.id,
      type: c.type,
      title: c.title,
      goal_or_purpose: c.goal_or_purpose,
      summary: c.summary,
      tags: c.tags || [],
      status: c.status || 'active',
      // Optional v2 project metadata — pass through only when set so reference
      // files and minimal projects stay lean.
      ...(c.emoji ? { emoji: c.emoji } : {}),
      ...(c.color ? { color: c.color } : {}),
      ...(c.category ? { category: c.category } : {}),
      created_at: c.created_at || offsetIso(-120, 9, 0),
      updated_at: c.updated_at || offsetIso(0, 17, 0),
    });
  }

  function pushEntry(containerId, e) {
    const entryId = randomUUID();
    const occurredAt = offsetIso(e.daysAgo, e.hh ?? 14, e.mm ?? 0);
    entries.push({
      id: entryId,
      container_id: containerId,
      kind: e.kind,
      occurred_at: occurredAt,
      title: e.title,
      participants: e.participants || [],
      tags: e.tags || [],
      notes: e.notes || '',
      created_at: occurredAt,
      updated_at: occurredAt,
    });
    const atomDefs = e.atoms || [];
    // First pass: assign ids + index labels.
    for (const a of atomDefs) {
      a._id = randomUUID();
      if (a.label) labels.set(a.label, a._id);
    }
    // Second pass: emit atoms (outcomes keep a _parentLabel placeholder
    // that the resolver below converts to a real parent_atom_id).
    for (const a of atomDefs) {
      const atom = {
        id: a._id,
        entry_id: entryId,
        kind: a.kind,
        body: a.body,
        tags: a.tags || [],
        created_at: occurredAt,
        updated_at: occurredAt,
      };
      if (a.kind === 'action') {
        atom.assigned_to = a.assigned_to || '';
        atom.due_date = a.due_date || '';
      } else if (a.kind === 'outcome') {
        atom.parent_atom_id = null;
        atom._parentLabel = a.parentLabel || null;
      }
      atoms.push(atom);
    }
  }

  // ==================================================================
  // PROJECT 1 — Payroll renewal (Acme vs. Gusto)
  // Overdue action lives here: "Send Acme termination clause request",
  // due Wednesday, still open Friday.
  // ==================================================================
  pushContainer({
    id: 'demo_payroll_renewal',
    type: 'project',
    emoji: '💸',
    color: '#b05a2a',
    category: 'Finance',
    title: 'Acme Payroll renewal vs. Gusto switch',
    goal_or_purpose:
      'Decide whether to renew Acme Payroll or switch to Gusto before the 06-30 contract auto-renew.',
    summary:
      'Contract auto-renews on 06-30 unless we send 30-day termination notice. Acme is comfortable but 6.5% more expensive than last year; Gusto pitch is integrated payroll + benefits at lower headline cost. Need benefits parity confirmed before we commit.',
    tags: ['vendor', 'renewal', 'q2', 'finance'],
    created_at: offsetIso(-21, 8, 42),
  });

  pushEntry('demo_payroll_renewal', {
    kind: 'email', daysAgo: -21, hh: 8, mm: 42,
    title: 'Acme renewal proposal received',
    participants: ['Sarah Chen', 'Noah'],
    notes:
      'Sarah forwarded the renewal terms. 12-month renewal at $4,490/mo. Auto-renews 06-30 unless 30 days notice. Attached PDF in shared drive.',
    atoms: [
      { kind: 'observation', body: 'New rate $4,490/mo, up 6.5% from current $4,217/mo.' },
      { kind: 'observation', body: '30-day termination notice required by end of month.' },
    ],
  });

  pushEntry('demo_payroll_renewal', {
    kind: 'freetext', daysAgo: -17, hh: 13, mm: 0,
    title: 'Should we even shop this?',
    notes:
      'Quick gut check. Last benchmarked 3 years ago. Worth one competitive quote even if we re-sign with Acme.',
    atoms: [
      { kind: 'decision', body: 'Get one competitive quote (Gusto) before committing.' },
      { kind: 'action', label: 'A-pull-invoices',
        body: 'Pull last 12 months of Acme invoices for benchmarking.',
        assigned_to: 'Natalia', due_date: offsetDate(-14) },
      { kind: 'action', label: 'A-gusto-call',
        body: 'Schedule Gusto discovery call.',
        assigned_to: 'Noah', due_date: offsetDate(-14) },
    ],
  });

  pushEntry('demo_payroll_renewal', {
    kind: 'meeting', daysAgo: -14, hh: 14, mm: 0,
    title: 'Gusto discovery call',
    participants: ['Noah', 'Natalia', 'Mark Patel'],
    notes:
      '45-min call. Mark walked us through pricing tiers and benefits admin. Sandbox available next week.',
    atoms: [
      { kind: 'observation',
        body: 'Gusto base $42/employee/month; at 75 heads we land near $3,150 (~$1,000/mo paper savings vs. Acme).' },
      { kind: 'observation',
        body: 'HSA admin is in-product at Gusto; ours currently goes through Trustmark.' },
      { kind: 'action', label: 'A-sandbox',
        body: 'Mark to send sandbox login.',
        assigned_to: 'Mark Patel', due_date: offsetDate(-9) },
    ],
  });

  pushEntry('demo_payroll_renewal', {
    kind: 'freetext', daysAgo: -10, hh: 9, mm: 15,
    title: 'Invoices pulled, sandbox up',
    notes:
      'Closing the prep actions so we go into next week clean.',
    atoms: [
      { kind: 'outcome', parentLabel: 'A-pull-invoices',
        body: '12-month average $4,217/mo, year-over-year drift +2.1%. Spreadsheet in shared drive.' },
      { kind: 'outcome', parentLabel: 'A-gusto-call',
        body: 'Held Friday; notes in the 2026-05-15 entry on this project.' },
      { kind: 'outcome', parentLabel: 'A-sandbox',
        body: 'Sandbox creds saved to 1Password as "Gusto-eval".' },
    ],
  });

  // ---- busy week ----
  pushEntry('demo_payroll_renewal', {
    kind: 'email', daysAgo: -4, hh: 8, mm: 42,
    title: 'Acme: any flexibility on pricing?',
    participants: ['Noah', 'Sarah Chen'],
    notes:
      'Asked Sarah whether Acme can match Gusto on price. She said she would take it to her director and circle back midweek.',
    atoms: [
      { kind: 'observation',
        body: 'Sarah noted Acme rarely matches on price but sometimes offers implementation credits.' },
      // The signature overdue action — created Mon, due Wed, still open Fri.
      { kind: 'action', label: 'A-termination-clause',
        body: 'Send Acme our termination-notice clause request so we keep the option open if we decide late.',
        assigned_to: 'Noah', due_date: offsetDate(-2) },
    ],
  });

  pushEntry('demo_payroll_renewal', {
    kind: 'meeting', daysAgo: -3, hh: 14, mm: 0,
    title: 'Payroll decision working session',
    participants: ['Noah', 'Natalia'],
    notes:
      '90 min. Walked the cost spreadsheet, the migration effort estimate, and the parental-leave admin question. Leaning Gusto but want HR to confirm benefits parity before signing.',
    atoms: [
      { kind: 'decision',
        body: 'Default to Gusto unless HR flags a benefits gap we cannot close in flight.' },
      { kind: 'action', label: 'A-cost-comp',
        body: 'Write up the cost comparison for Diane (HR).',
        assigned_to: 'Natalia', due_date: offsetDate(-2) },
      { kind: 'action',
        body: 'Confirm migration support hours included in Gusto SOW.',
        assigned_to: 'Natalia', due_date: offsetDate(4) },
    ],
  });

  pushEntry('demo_payroll_renewal', {
    kind: 'email', daysAgo: -2, hh: 10, mm: 30,
    title: 'HR: benefits parity questions',
    participants: ['Diane Marston', 'Noah', 'Natalia'],
    notes:
      'Diane has three concerns: HSA admin, dependent care FSA, parental-leave tracking into our HRIS.',
    atoms: [
      { kind: 'observation',
        body: 'Diane raised three benefit-parity questions; first two answered on the thread, leave-tracking still TBD.' },
      { kind: 'outcome', parentLabel: 'A-cost-comp',
        body: 'Natalia sent the cost comparison Wed morning; Diane confirmed she has what she needs.' },
      { kind: 'action', label: 'A-leave-tracking',
        body: 'Get Gusto answer on parental-leave tracking integration with BambooHR.',
        assigned_to: 'Noah', due_date: offsetDate(0) },
    ],
  });

  pushEntry('demo_payroll_renewal', {
    kind: 'meeting', daysAgo: -1, hh: 11, mm: 0,
    title: 'Gusto pricing + leave-tracking call',
    participants: ['Noah', 'Natalia', 'Mark Patel'],
    notes:
      'Mark confirmed leave tracking syncs nightly to BambooHR via their standard connector. Pricing holds at $42/head if we sign by end of Q2.',
    atoms: [
      { kind: 'observation',
        body: 'Leave tracking syncs nightly to BambooHR via the standard connector.' },
      { kind: 'outcome', parentLabel: 'A-leave-tracking',
        body: 'Confirmed: nightly BambooHR sync covers it. No custom integration needed.' },
      { kind: 'decision',
        body: 'If Diane signs off Friday, we move to Gusto and send Acme the termination notice over the weekend.' },
    ],
  });

  pushEntry('demo_payroll_renewal', {
    kind: 'freetext', daysAgo: 0, hh: 15, mm: 30,
    title: 'Status memo — decision pending HR sign-off',
    notes:
      'Diane gave verbal OK; written sign-off Monday. Pricing locked. Need to send Acme termination by Sunday and counter-sign Gusto Monday.',
    atoms: [
      { kind: 'observation',
        body: 'Diane verbally signed off; written confirmation expected Monday morning.' },
      { kind: 'action',
        body: 'Send Acme termination notice and counter-sign Gusto contract.',
        assigned_to: 'Noah', due_date: offsetDate(2) },
    ],
  });

  // ==================================================================
  // PROJECT 2 — Ops Coordinator hire
  // No overdue actions; cleaner-looking project to balance the demo.
  // ==================================================================
  pushContainer({
    id: 'demo_ops_coordinator_hire',
    type: 'project',
    emoji: '🧑‍💼',
    color: '#5a7a5e',
    category: 'Human Resources',
    title: 'Ops Coordinator backfill',
    goal_or_purpose:
      'Hire and onboard an Operations Coordinator backfill with a signed offer by 06-15.',
    summary:
      'Backfilling Priya\'s seat after her promotion to Ops Manager. Final round done; one strong finalist (Amelia Park). This week: reference checks, comp benchmarking, and offer letter out.',
    tags: ['hiring', 'team', 'q2'],
    created_at: offsetIso(-37, 9, 0),
  });

  pushEntry('demo_ops_coordinator_hire', {
    kind: 'freetext', daysAgo: -37, hh: 9, mm: 0,
    title: 'Backfill kicked off',
    notes:
      'Job posted to LinkedIn, Workable, AngelList. Targeting 6-8 weeks to signed offer.',
    atoms: [
      { kind: 'decision',
        body: 'Mid-level coordinator, not a manager rehire. Promote internal in 12-18 months instead.' },
    ],
  });

  pushEntry('demo_ops_coordinator_hire', {
    kind: 'meeting', daysAgo: -16, hh: 11, mm: 0,
    title: 'Phone screen: Amelia Park',
    participants: ['Natalia', 'Amelia Park'],
    notes: '30 min. Strong signal on systems thinking and follow-through.',
    atoms: [
      { kind: 'observation',
        body: 'Eight years ops experience; last four at a Sequoia portfolio company.' },
      { kind: 'decision', body: 'Advance to onsite.' },
    ],
  });

  pushEntry('demo_ops_coordinator_hire', {
    kind: 'meeting', daysAgo: -10, hh: 11, mm: 0,
    title: 'Phone screen: Tomás Aguilar',
    participants: ['Natalia', 'Tomás Aguilar'],
    notes: 'Good communicator but less hands-on systems work than we need at this level.',
    atoms: [
      { kind: 'observation',
        body: 'Strong communicator; lighter on systems work than the role needs.' },
      { kind: 'decision', body: 'Pass with positive notes; keep in pipeline for a coordinator-light role.' },
    ],
  });

  // ---- busy week ----
  pushEntry('demo_ops_coordinator_hire', {
    kind: 'meeting', daysAgo: -4, hh: 13, mm: 0,
    title: 'Final round: Amelia Park',
    participants: ['Noah', 'Natalia', 'Amelia Park', 'Diane Marston'],
    notes:
      'Three-hour onsite. Case study went well. Diane flagged comp expectations are on the high end of band.',
    atoms: [
      { kind: 'observation',
        body: 'Amelia\'s expected comp range: $95-105k. Our band tops at $98k.' },
      { kind: 'action', label: 'A-refs',
        body: 'Run reference checks (3 contacts provided).',
        assigned_to: 'Natalia', due_date: offsetDate(-2) },
      { kind: 'action', label: 'A-comp-bench',
        body: 'Benchmark comp via Payscale + two peer-company data points.',
        assigned_to: 'Noah', due_date: offsetDate(-2) },
    ],
  });

  pushEntry('demo_ops_coordinator_hire', {
    kind: 'email', daysAgo: -3, hh: 9, mm: 0,
    title: 'Debrief: Amelia',
    participants: ['Noah', 'Natalia', 'Diane Marston'],
    notes: 'All three of us aligned. Diane wants to stress-test comp.',
    atoms: [
      { kind: 'observation',
        body: 'Three-way alignment on Amelia. Diane will sign off once comp benchmarking is in.' },
    ],
  });

  pushEntry('demo_ops_coordinator_hire', {
    kind: 'meeting', daysAgo: -2, hh: 11, mm: 0,
    title: 'Calibration: are we sure?',
    participants: ['Noah', 'Natalia'],
    notes:
      '30 min. Talked through Amelia vs. holding for a second finalist. Agreed she is the candidate; pay the top of band.',
    atoms: [
      { kind: 'decision',
        body: 'Offer at $98k (top of band). No second finalist worth waiting for.' },
      { kind: 'outcome', parentLabel: 'A-refs',
        body: 'All three references positive; one called her "coachable and very organized".' },
      { kind: 'outcome', parentLabel: 'A-comp-bench',
        body: '$95-105k matches market; our top-of-band is competitive but not generous.' },
      { kind: 'action', label: 'A-offer-draft',
        body: 'Draft offer letter for Amelia at $98k, start date 06-15.',
        assigned_to: 'Natalia', due_date: offsetDate(-1) },
    ],
  });

  pushEntry('demo_ops_coordinator_hire', {
    kind: 'email', daysAgo: -1, hh: 16, mm: 0,
    title: 'Offer letter sent',
    participants: ['Noah', 'Amelia Park'],
    notes: 'Sent the offer with a one-week response window.',
    atoms: [
      { kind: 'outcome', parentLabel: 'A-offer-draft',
        body: 'Sent at 4pm Thursday. Response window through next Thursday.' },
    ],
  });

  pushEntry('demo_ops_coordinator_hire', {
    kind: 'freetext', daysAgo: 0, hh: 11, mm: 30,
    title: 'Amelia accepted verbally',
    notes: 'Quick phone call this morning. She is in. Paperwork Monday; start date 06-15.',
    atoms: [
      { kind: 'observation', body: 'Verbal acceptance Friday morning; written acceptance to follow Monday.' },
      { kind: 'action',
        body: 'Coordinate Day 1 logistics (laptop, accounts, intro meetings, welcome lunch).',
        assigned_to: 'Natalia', due_date: offsetDate(14) },
      { kind: 'action',
        body: 'Notify the second finalist they did not get the role; keep door open.',
        assigned_to: 'Noah', due_date: offsetDate(3) },
    ],
  });

  // ==================================================================
  // PROJECT 3 — Salesforce -> HubSpot cutover
  // Second overdue action: "Confirm pipeline-stage mapping", due Thursday.
  // ==================================================================
  pushContainer({
    id: 'demo_crm_cutover',
    type: 'project',
    emoji: '🔁',
    color: '#2e7dbd',
    category: 'Technology',
    title: 'Salesforce -> HubSpot cutover',
    goal_or_purpose:
      'Cut over from Salesforce to HubSpot by 06-12 with no data loss and the sales team trained on the new system.',
    summary:
      'SOW signed. Sandbox up. Field mapping mostly resolved except for pipeline stages — our 7-stage funnel does not fit HubSpot\'s standard. Training rollout scheduled for cutover week.',
    tags: ['migration', 'tooling', 'q2'],
    created_at: offsetIso(-25, 10, 0),
  });

  pushEntry('demo_crm_cutover', {
    kind: 'meeting', daysAgo: -25, hh: 10, mm: 0,
    title: 'CRM kickoff with HubSpot IS',
    participants: ['Noah', 'Natalia', 'Tom Reilly'],
    notes:
      '60 min. Walked the project plan and timeline. Sandbox provisioning starts next week.',
    atoms: [
      { kind: 'observation', body: 'Six-week implementation plan; cutover targeted 06-12.' },
      { kind: 'action', label: 'A-sandbox-provision',
        body: 'HubSpot to provision sandbox tenant.',
        assigned_to: 'Tom Reilly', due_date: offsetDate(-18) },
    ],
  });

  pushEntry('demo_crm_cutover', {
    kind: 'email', daysAgo: -18, hh: 9, mm: 30,
    title: 'SOW signed; sandbox ready',
    participants: ['Tom Reilly', 'Noah'],
    notes: 'Tom countersigned the SOW and sent sandbox credentials.',
    atoms: [
      { kind: 'observation', body: 'SOW countersigned; sandbox tenant live.' },
      { kind: 'outcome', parentLabel: 'A-sandbox-provision',
        body: 'Sandbox provisioned. Creds shared via 1Password.' },
    ],
  });

  pushEntry('demo_crm_cutover', {
    kind: 'freetext', daysAgo: -11, hh: 15, mm: 0,
    title: 'Field mapping draft',
    notes:
      'First pass mapping Salesforce custom fields to HubSpot. Most map cleanly; pipeline stages are the open question.',
    atoms: [
      { kind: 'decision', body: 'Use HubSpot\'s standard contact properties where possible; only bring custom fields with real downstream consumers.' },
      { kind: 'action', label: 'A-mapping-signoff',
        body: 'Get sales lead sign-off on the field mapping.',
        assigned_to: 'Noah', due_date: offsetDate(-4) },
    ],
  });

  // ---- busy week ----
  pushEntry('demo_crm_cutover', {
    kind: 'meeting', daysAgo: -4, hh: 10, mm: 0,
    title: 'HubSpot IS implementation session',
    participants: ['Noah', 'Natalia', 'Jess Nguyen'],
    notes:
      'First session with Jess (took over from Tom 05-25). Sample import scheduled Wed.',
    atoms: [
      { kind: 'observation', body: 'Jess Nguyen has taken over as our IS rep from Tom Reilly.' },
      { kind: 'observation', body: 'Sandbox ready; first sample import scheduled for Wednesday.' },
      { kind: 'action', label: 'A-sample-import',
        body: 'Stage a 1k-record sample import in sandbox.',
        assigned_to: 'Jess Nguyen', due_date: offsetDate(-2) },
    ],
  });

  pushEntry('demo_crm_cutover', {
    kind: 'freetext', daysAgo: -3, hh: 16, mm: 30,
    title: 'Field mapping issues found',
    notes:
      'Sales lead reviewing the mapping flagged 3 issues with pipeline-stage mapping. Our 7-stage funnel does not fit cleanly into HubSpot\'s 5 standard stages.',
    atoms: [
      { kind: 'observation', body: '3 of our 7 pipeline stages do not have clean HubSpot equivalents.' },
      // Second overdue action — created Tue, due Thu, still open Fri.
      { kind: 'action', label: 'A-pipeline-mapping',
        body: 'Confirm pipeline-stage mapping with sales lead (need this resolved before the next IS session).',
        assigned_to: 'Noah', due_date: offsetDate(-1) },
    ],
  });

  pushEntry('demo_crm_cutover', {
    kind: 'email', daysAgo: -2, hh: 9, mm: 15,
    title: 'Salesforce export windows',
    participants: ['Kelvin Wright', 'Noah'],
    notes:
      'Kelvin (SF admin side) offered Sat 06-06 as the export window. Sample import results from yesterday came back clean.',
    atoms: [
      { kind: 'observation', body: 'Salesforce export window confirmed: Sat 06-06, 8am-2pm.' },
      { kind: 'outcome', parentLabel: 'A-sample-import',
        body: '1k records imported clean; 2 custom fields lost on first pass — fixed by adding to mapping.' },
      { kind: 'outcome', parentLabel: 'A-mapping-signoff',
        body: 'Sales lead signed off on the standard fields; pipeline stages still open (see Tue freetext).' },
    ],
  });

  pushEntry('demo_crm_cutover', {
    kind: 'meeting', daysAgo: -1, hh: 15, mm: 0,
    title: 'Training rollout planning',
    participants: ['Noah', 'Natalia', 'Lina Faraj'],
    notes:
      'Two 90-min training sessions, Tue and Thu of cutover week. Recordings + cheat sheet PDF for anyone who misses.',
    atoms: [
      { kind: 'decision',
        body: 'Two 90-min training sessions, Tue + Thu of cutover week. Recordings + cheat-sheet PDF.' },
      { kind: 'action', label: 'A-rooms',
        body: 'Book conference room and add training sessions to team calendars (06-09 and 06-11).',
        assigned_to: 'Natalia', due_date: offsetDate(0) },
      { kind: 'action',
        body: 'Draft cheat-sheet PDF.',
        assigned_to: 'Noah', due_date: offsetDate(7) },
    ],
  });

  pushEntry('demo_crm_cutover', {
    kind: 'freetext', daysAgo: 0, hh: 14, mm: 0,
    title: 'Friday status update',
    notes:
      'On track for 06-12 cutover. Pipeline-stage mapping is the one open risk; everything else is moving.',
    atoms: [
      { kind: 'observation', body: 'On track for 06-12 cutover. Pipeline-stage mapping is the open risk.' },
      { kind: 'outcome', parentLabel: 'A-rooms',
        body: 'Rooms booked; team calendars updated; recurring placeholders for cutover week added.' },
      { kind: 'action',
        body: 'Send weekly stakeholder update email summarising the week.',
        assigned_to: 'Natalia', due_date: offsetDate(0) },
    ],
  });

  // ==================================================================
  // REFERENCE FILE 1 — Dyad operating agreement
  // Long-lived; no actions, mostly decisions and observations.
  // ==================================================================
  pushContainer({
    id: 'demo_dyad_operating_agreement',
    type: 'reference_file',
    title: 'Dyad operating agreement',
    goal_or_purpose:
      'How Noah and Natalia work together: meeting cadence, decision rights, escalation, coverage.',
    summary:
      'Living doc. Update when we agree to a new rule. Decisions captured as decision atoms so they are searchable.',
    tags: ['dyad', 'process'],
    created_at: offsetIso(-140, 10, 0),
  });

  pushEntry('demo_dyad_operating_agreement', {
    kind: 'freetext', daysAgo: -135, hh: 10, mm: 0,
    title: 'Standing cadence',
    atoms: [
      { kind: 'decision', body: 'Mon 9am standing 1:1 (30 min). Skipped only if both of us are out.' },
      { kind: 'decision', body: 'Thu 3pm async written check-in in Slack #ops-dyad.' },
    ],
  });

  pushEntry('demo_dyad_operating_agreement', {
    kind: 'freetext', daysAgo: -100, hh: 10, mm: 0,
    title: 'Decision rights',
    atoms: [
      { kind: 'decision', body: 'Either of us can sign vendor agreements under $5k unilaterally.' },
      { kind: 'decision', body: 'Hiring decisions require both of us to interview the candidate.' },
      { kind: 'decision', body: 'Contracts over $25k require explicit written sign-off from both of us.' },
    ],
  });

  pushEntry('demo_dyad_operating_agreement', {
    kind: 'freetext', daysAgo: -75, hh: 10, mm: 0,
    title: 'Escalation',
    atoms: [
      { kind: 'decision', body: 'If a vendor is unresponsive for 5 business days, escalate to the AE\'s manager.' },
      { kind: 'decision', body: 'Internal disagreements that block work for 48 hours: bring to the weekly leadership sync.' },
    ],
  });

  pushEntry('demo_dyad_operating_agreement', {
    kind: 'freetext', daysAgo: -50, hh: 10, mm: 0,
    title: 'Coverage when one of us is out',
    atoms: [
      { kind: 'decision', body: 'If one of us is out >2 business days, the other is empowered to act unilaterally on everything except hires and contracts over $25k.' },
      { kind: 'observation', body: 'Out-of-office windows go in the shared calendar 7 days in advance.' },
    ],
  });

  // ==================================================================
  // REFERENCE FILE 2 — Vendor directory
  // Shares the `vendor` tag with the payroll renewal project.
  // ==================================================================
  pushContainer({
    id: 'demo_vendor_directory',
    type: 'reference_file',
    title: 'Vendor directory',
    goal_or_purpose:
      'Single source of truth for vendor contacts, account reps, and renewal dates.',
    summary:
      'One entry per vendor. Update the existing entry rather than creating a new one when contacts change.',
    tags: ['vendor', 'reference'],
    created_at: offsetIso(-150, 10, 0),
  });

  pushEntry('demo_vendor_directory', {
    kind: 'freetext', daysAgo: -145, hh: 10, mm: 0,
    title: 'Acme Payroll',
    atoms: [
      { kind: 'observation', body: 'Rep: Sarah Chen — sarah.chen@acmepayroll.com — +1 415-555-0142.' },
      { kind: 'observation', body: 'Renews annually 06-30. 30-day notice required to terminate.' },
      { kind: 'observation', body: 'Account #: ACM-44982.' },
    ],
  });

  pushEntry('demo_vendor_directory', {
    kind: 'freetext', daysAgo: -14, hh: 10, mm: 0,
    title: 'Gusto (under evaluation)',
    atoms: [
      { kind: 'observation', body: 'Rep: Mark Patel — mark.patel@gusto.com — +1 415-555-0987.' },
      { kind: 'observation', body: 'Eval sandbox creds in 1Password as "Gusto-eval".' },
    ],
  });

  pushEntry('demo_vendor_directory', {
    kind: 'freetext', daysAgo: -143, hh: 10, mm: 0,
    title: 'Salesforce',
    atoms: [
      { kind: 'observation', body: 'Rep: Janet Liu — jliu@salesforce.com.' },
      { kind: 'observation', body: 'Renews 2027-02-28.' },
      { kind: 'observation', body: 'Account #: SF-22113.' },
    ],
  });

  pushEntry('demo_vendor_directory', {
    kind: 'freetext', daysAgo: -143, hh: 10, mm: 0,
    title: 'HubSpot',
    atoms: [
      { kind: 'observation', body: 'IS rep: Jess Nguyen — jnguyen@hubspot.com (replaced Tom Reilly week of 05-25).' },
      { kind: 'observation', body: 'Implementation SOW signed; subscription auto-renews annually after go-live.' },
    ],
  });

  pushEntry('demo_vendor_directory', {
    kind: 'freetext', daysAgo: -140, hh: 10, mm: 0,
    title: 'Greenline Properties (building landlord)',
    atoms: [
      { kind: 'observation', body: 'Contact: Mariana Cole — mcole@greenline-properties.com.' },
      { kind: 'observation', body: 'Lease renews 2027-09-30.' },
    ],
  });

  pushEntry('demo_vendor_directory', {
    kind: 'freetext', daysAgo: -140, hh: 10, mm: 0,
    title: 'Linkbridge (IT MSP)',
    atoms: [
      { kind: 'observation', body: 'Account manager: Devin Park — devin@linkbridgeit.com.' },
      { kind: 'observation', body: 'Monthly retainer; cancel anytime with 30 days notice.' },
    ],
  });

  pushEntry('demo_vendor_directory', {
    kind: 'freetext', daysAgo: -2, hh: 16, mm: 0,
    title: 'HubSpot rep changed',
    notes: 'Updating the HubSpot entry above; logging here for the audit trail.',
    atoms: [
      { kind: 'observation', body: 'Jess Nguyen replaced Tom Reilly as our HubSpot IS rep effective 05-25.' },
    ],
  });

  // ==================================================================
  // REFERENCE FILE 3 — Team roster
  // Shares the `team` tag with the hiring project.
  // ==================================================================
  pushContainer({
    id: 'demo_team_roster',
    type: 'reference_file',
    title: 'Team roster',
    goal_or_purpose:
      'Who is on the ops/admin team, their roles, work hours, time off.',
    summary:
      'One entry per person. Keep observation atoms current; log significant changes as new observations on the existing entry.',
    tags: ['team', 'reference'],
    created_at: offsetIso(-150, 10, 0),
  });

  pushEntry('demo_team_roster', {
    kind: 'freetext', daysAgo: -148, hh: 10, mm: 0,
    title: 'Diane Marston — HR Lead',
    atoms: [
      { kind: 'observation', body: 'Email: diane.m@company.com. Slack: @diane.' },
      { kind: 'observation', body: 'Hours: Mon-Thu, off Fridays. Cover via Stefanie on Fridays for urgent items.' },
    ],
  });

  pushEntry('demo_team_roster', {
    kind: 'freetext', daysAgo: -148, hh: 10, mm: 0,
    title: 'Priya Sundaram — Ops Manager (formerly Sr Ops Coordinator)',
    atoms: [
      { kind: 'observation', body: 'Promoted to Ops Manager on 03-15; backfilling her coordinator seat (see hiring project).' },
      { kind: 'observation', body: 'Reports to Noah.' },
    ],
  });

  pushEntry('demo_team_roster', {
    kind: 'freetext', daysAgo: -148, hh: 10, mm: 0,
    title: 'Lina Faraj — Sales Lead',
    atoms: [
      { kind: 'observation', body: 'Sales lead since 2024. Primary stakeholder for the HubSpot migration.' },
      { kind: 'observation', body: 'Out 06-22 to 07-06 (pre-planned PTO — Italy).' },
    ],
  });

  pushEntry('demo_team_roster', {
    kind: 'freetext', daysAgo: -148, hh: 10, mm: 0,
    title: 'Kelvin Wright — IT Support',
    atoms: [
      { kind: 'observation', body: 'Tier 1-2 internal IT. Also liaises with Linkbridge for tier 3.' },
    ],
  });

  pushEntry('demo_team_roster', {
    kind: 'freetext', daysAgo: -148, hh: 10, mm: 0,
    title: 'Stefanie Holm — Office Manager',
    atoms: [
      { kind: 'observation', body: 'Office manager + executive admin support. Covers Diane on Fridays.' },
    ],
  });

  pushEntry('demo_team_roster', {
    kind: 'freetext', daysAgo: -1, hh: 9, mm: 30,
    title: 'Kelvin parental leave',
    notes: 'Logging now so we plan coverage before he is out.',
    atoms: [
      { kind: 'observation', body: 'Kelvin\'s parental leave starts 06-15, returns 09-15.' },
      { kind: 'observation', body: 'Coverage: tier 2 tickets roll to Linkbridge for the duration.' },
    ],
  });

  // ==================================================================
  // Resolve outcome parent labels into real atom UUIDs.
  // ==================================================================
  for (const a of atoms) {
    if (a.kind === 'outcome') {
      if (a._parentLabel) {
        a.parent_atom_id = labels.get(a._parentLabel) || null;
      }
      delete a._parentLabel;
    }
  }

  return { containers, entries, atoms };
}
