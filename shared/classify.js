// ------------------------------------------------------------------
// Throughline — project shape classifier (runtime-agnostic ESM).
//
// Imported by BOTH backends (src/index.js Worker + server.js Node). Depends
// only on standard JS + an optional injected `llmCall` (see shared/llm.js) —
// no `node:*` — so the Worker bundle stays clean. Powers the shape wizard:
// three plain-English answers (+ a free-text description / pasted excerpt) go
// in, a structured recommendation comes out.
//
// Like atomizeEntry, this DEGRADES to a deterministic heuristic when there is
// no `llmCall` or the model returns garbage — it never throws into the handler
// and never 500s, so the wizard works with zero API spend.
// ------------------------------------------------------------------

// Output contract consumed by the wizard (public/app.js):
//   { framework, reason, suggested_phases_or_states[], suggested_metric,
//     is_program, if_program_subprojects[], first_action, source }
// where `framework` ∈ {kanban, pdsa, milestone, timeline} (or null) and each
// subproject is { name, framework, reason }.

const FRAMEWORK_IDS = ['kanban', 'pdsa', 'milestone', 'timeline'];

// ---- prompt assembly (real LLM path) -------------------------------

export function buildClassifyPrompt({ description = '', excerpt = '', answers = {} } = {}) {
  const excerptTrunc = String(excerpt || '').slice(0, 500);
  return [
    'Classify this project and suggest a structure. The user is a medical director',
    'in a multi-specialty ambulatory care organization. They are not a project',
    'manager. Respond ONLY in JSON — no prose, no markdown fences.',
    '',
    `Project description: ${description || '(none given)'}`,
    answers && Object.keys(answers).length ? `User answers: ${JSON.stringify(answers)}` : '',
    excerptTrunc ? `Relevant document excerpt: ${excerptTrunc}` : '',
    '',
    'Frameworks to choose from (pick the single best fit):',
    '  - kanban: a pipeline of content/tasks moving through stages',
    '  - pdsa: improving a measurable outcome over repeating cycles',
    '  - milestone: a phased effort with milestones to hit',
    '  - timeline: a situation driven by key dates and events',
    '',
    'Return: {"framework": one of [kanban, pdsa, milestone, timeline],',
    '"reason": "one plain-English sentence, no jargon",',
    '"suggested_phases_or_states": ["list", "of", "names"],',
    '"suggested_metric": "what to measure, or null",',
    '"is_program": true/false,',
    '"if_program_subprojects": [{"name": "…", "framework": "kanban|pdsa|milestone|timeline", "reason": "one sentence"}],',
    '"first_action": "the single most important first step to take right now"}',
  ].filter(Boolean).join('\n');
}

// ---- the public entry point ----------------------------------------

export async function classifyProject({ description = '', excerpt = '', answers = {} } = {}, { llmCall = null } = {}) {
  if (llmCall) {
    try {
      const prompt = buildClassifyPrompt({ description, excerpt, answers });
      const raw = await llmCall({ prompt, tier: 'classify', json: true });
      const parsed = parseModelJson(raw);
      const norm = normalizeClassification(parsed);
      if (norm) return { ...norm, source: 'llm' };
    } catch {
      /* fall through to heuristic */
    }
  }
  return { ...heuristicClassify({ description, excerpt, answers }), source: 'heuristic' };
}

// ---- heuristic fallback --------------------------------------------

// Map a wizard "what are you working toward?" answer to a framework.
const GOAL_TO_FRAMEWORK = {
  outcome: 'pdsa',     // improving a measurable outcome
  build: 'milestone',  // building/implementing with phases
  pipeline: 'kanban',  // a pipeline of content/tasks
  dates: 'timeline',   // a situation with important dates
};

// Keyword fallbacks when the answers don't pin a framework.
const KW = [
  { fw: 'pdsa', re: /\b(improve|improving|reduce|increase|rate|percent|%|measure|metric|score|hedis|cahps|screening|completion|adherence)\b/i },
  { fw: 'kanban', re: /\b(campaign|comms|communication|content|draft|newsletter|briefing|intranet|publish|tipsheet|email blast)\b/i },
  { fw: 'milestone', re: /\b(launch|build|implement|migrat|rollout|roll out|deploy|go.?live|onboard|stand up|cutover|phase)\b/i },
  { fw: 'timeline', re: /\b(deadline|due|audit|joint commission|cms|ncqa|corrective|counsel|incident|review by|escalat|hr )\b/i },
];

// Distinct workstream "domains". A description is a PROGRAM only when it spans
// ≥2 of these AND is long enough to plausibly describe multiple workstreams
// (see heuristicClassify) — keywords are specific to avoid splitting a simple
// single-goal project (e.g. bare "improve"/"measure" do NOT count).
const DOMAINS = [
  { key: 'analytics', fw: 'milestone', re: /\b(analytics|dashboard|data feed|sql|spreadsheet|optum analytics|epic report|reporting pipeline|monitor the measure)\b/i, name: 'Analytics & measurement' },
  { key: 'comms', fw: 'kanban', re: /\b(communication|provider briefing|newsletter|intranet|campaign|announcement|tipsheet|email blast)\b/i, name: 'Provider communications' },
  { key: 'intervention', fw: 'pdsa', re: /\b(coaching|counsel|1:1|one.on.one|individual counseling|training session|behavior change|pdsa)\b/i, name: 'Clinical intervention' },
  { key: 'documentation', fw: 'milestone', re: /\b(worksheet|template|policy|proposal|attestation|guideline document)\b/i, name: 'Documentation' },
];

function frameworkFromAnswers(answers, description) {
  const goal = answers && answers.goal;
  if (goal && GOAL_TO_FRAMEWORK[goal]) return GOAL_TO_FRAMEWORK[goal];
  for (const { fw, re } of KW) if (re.test(description)) return fw;
  return 'milestone'; // safe, general default
}

function phasesFor(fw) {
  switch (fw) {
    case 'kanban': return ['Backlog', 'In progress', 'In review', 'Done'];
    case 'pdsa': return ['Plan', 'Do', 'Study', 'Act'];
    case 'milestone': return ['Assess', 'Design', 'Pilot', 'Scale', 'Measure'];
    case 'timeline': return [];
    default: return [];
  }
}

function heuristicClassify({ description = '', excerpt = '', answers = {} }) {
  const text = `${description} ${excerpt}`;
  const matched = DOMAINS.filter(d => d.re.test(text));
  // Only call it a program when several workstreams are described AND there's
  // enough text to back that up — a short single-goal line stays one project.
  const isProgram = matched.length >= 2 && text.trim().length >= 100;

  if (isProgram) {
    const subs = matched.map(d => ({
      name: d.name,
      framework: d.fw,
      reason: `Handles the ${d.name.toLowerCase()} workstream.`,
    }));
    return {
      framework: null,
      reason: 'This spans several different kinds of work, so it fits best as a program with a few smaller projects underneath.',
      suggested_phases_or_states: [],
      suggested_metric: null,
      is_program: true,
      if_program_subprojects: subs,
      first_action: 'Read the source materials and confirm the suggested subprojects below.',
    };
  }

  const fw = frameworkFromAnswers(answers, text);
  const metricKnown = answers && answers.metric_known === 'yes';
  return {
    framework: fw,
    reason: reasonFor(fw),
    suggested_phases_or_states: phasesFor(fw),
    suggested_metric: fw === 'pdsa' ? (metricKnown ? 'the outcome you are trying to move' : null) : null,
    is_program: false,
    if_program_subprojects: [],
    first_action: firstActionFor(fw),
  };
}

function reasonFor(fw) {
  return {
    kanban: 'This is a flow of pieces that each move through stages, so a board fits best.',
    pdsa: 'This is about moving a number over time, so a measure-and-adjust cycle fits best.',
    milestone: 'This is a phased effort with clear steps to hit, so a milestone checklist fits best.',
    timeline: 'This is driven by key dates, so a dated event log with the next deadline on top fits best.',
  }[fw] || 'A milestone checklist is a safe general structure for this.';
}

function firstActionFor(fw) {
  return {
    kanban: 'List the first few pieces of work and drop them into the board.',
    pdsa: 'Write down the aim and the current baseline number.',
    milestone: 'List the milestones you need to hit and who owns the first one.',
    timeline: 'Note the next important date and what has to happen before it.',
  }[fw] || 'Capture the single most important next step as an action.';
}

// ---- model-response parsing + normalization ------------------------

// Local copy (kept independent of atomize.js so the two seams don't couple).
function parseModelJson(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  const text = String(raw);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

// Coerce a parsed model object into the strict output contract, or null if it
// is unusable (so the caller can fall back to the heuristic).
function normalizeClassification(p) {
  if (!p || typeof p !== 'object') return null;
  const isProgram = p.is_program === true;
  let framework = FRAMEWORK_IDS.includes(p.framework) ? p.framework : null;
  if (!framework && !isProgram) return null; // nothing usable

  const subs = Array.isArray(p.if_program_subprojects)
    ? p.if_program_subprojects
        .filter(s => s && s.name)
        .map(s => ({
          name: String(s.name),
          framework: FRAMEWORK_IDS.includes(s.framework) ? s.framework : 'milestone',
          reason: s.reason ? String(s.reason) : '',
        }))
    : [];

  return {
    framework: isProgram ? null : framework,
    reason: typeof p.reason === 'string' && p.reason ? p.reason : reasonFor(framework),
    suggested_phases_or_states: Array.isArray(p.suggested_phases_or_states)
      ? p.suggested_phases_or_states.map(String).slice(0, 10)
      : phasesFor(framework),
    suggested_metric: (p.suggested_metric && p.suggested_metric !== 'null') ? String(p.suggested_metric) : null,
    is_program: isProgram,
    if_program_subprojects: isProgram ? subs : [],
    first_action: typeof p.first_action === 'string' && p.first_action ? p.first_action : firstActionFor(framework),
  };
}
