<!-- This is the ORIGIN conversation (frozen record). The vision has since
     evolved — see VISION.md for the living design/architecture doc (folder-lens
     direction, reference-vs-shelf, onboarding, open-in-native-app). -->

# ME: 
I'm thinking through the development of a project management tool for my work as a medical director, which touches many different facets of a large organization, which is itself part of a larger organization, which is itself a player in the confusing field of modern american medicine.  
The tool, Throughline, has as a design intention - make it easy to capture and monitor progress along many different projects, of many different types, especially when I'm coordinating between myself as medical director and natalia peden as operations director.  
Not only do we want to be able to capture critical information as it comes along in a retrievable way, we also need to capture open actions for holding ourselves, each other, and our colleagues and direct reports and even our leaders accountable for completing tasks that move our projects along.  
I've accepted that there is probably not one perfect system for collecting and presenting exactly what we need, but since we have access to strong agentic coding platforms like claude code, and also the support of microsoft copilot premium which can extract useful information from the massive enterprise context, all we need is something that can successfully park and surface information.  
We both carry around too much in our own heads, and a lot of important things end up captured on scraps of paper and on temporary txt files.  
We've decided that this system should largely house its database in microsoft onedrive folders.  
We can and have shared folders with each other, but this is an opaque system.  
there are folders, subfolders, documents of various kinds with various purposes, and no easily viewed shared orchestration layer.  
My head is foggy, in no small part due to the many ongoing projects and initiatives.  
Furthermore, I'm around the corner from accepting a role that expands my scope substantially, potentially diluting my effectiveness at my current expectations.  
Part of the struggle is that I had a very effective system, Steadyhand, but it relied on anthropic models and personal hardware that was not company approved. 
It has been many weeks since I ceased using Steadyhand, and as a result of no longer having a robust capture system, as well as a growing realization that the database steadyhand relied on was, after several months, becoming difficult to curate and required significant curation tme, and so I've made several attempts at an enterprise acceptable implementation.  
It hasn't been a failure, each attempt has taught me things and created useful projects with useful components that I can reuse.  
Right now I'm thikning about project management in general, and the various modalities.  
I was just watching a video about kanban boards, scrum, and agile project management, but it was geared towards app-development teams, which really doesn't match the majority of my work.  
I'd like you to help me by first, relying on your knowledge of me, and your general knowledge of the kinds of work medical directors and operations directors have to do inside a multi specialty healthcare delivery organization, make a listing of the sorts of projects we're likely to have to undertake, the kinds of information we'd need to curate, and offer suggestions for the kinds of tooling that could be helpful to us in tackling these different tasks.  
Do please check the internet - there are certainly articles about this.  
I'm particularly interested in project management tools that are visually accessible, though neither natalia (me operations dyad) nor I are scared of spreadsheets, but I think what we need are nested dashboards, where we can at a high level identify areas that need further development, as well as quickly give status updates to our superiors on what it is we've been working on, with the ability to drill down and see what actual work has been happening for ourselves and the people we work with, alongside the metrics that we use to track success.  
Simultaneously, we also are developing various kinds of communications projects, which do somewhat map to app development.  
A recent example - Natalia showed me a form that was popular among the providers, it was an inbasket tipsheet with colorful rounded rectangles areound the edge and a small table of information at one corner.  
I adapted that to a provider briefing, where the rounded squares remind providers of important things to keep in mind - recheck out of range BP, attend upcoming events, complete annual wellness visits - and the table contained expandable rows that show providers a listing of all the region-wide initiatives that are steadily rolling along, where clicking a row breaks it down to "what is this" "how does this apply to me" "what do I need to do differently" sorts of questions.  
My boss the senior regional medical director loved the format and wants me to work with the marketing team to put this on our regional intranet.  
this has its own challenges - the intranet page is made in sharepoint, which is very frustrating to work with and may not support the kind of tooling I'm planning to use, and since I'll be working with a marketing team they'll probably want to make changes and control the format etc etc...but this project is not one where I'm tracking percentage completion, more like somethign that could be managed with a kanban board e.g.  
Yet I'm not a professional project manager, I tend to make ad hoc diagrams and documents to plan the next set of steps, and I also tend to be the one doing a lot of the work, so till now I'm generally not sharing my project management tooling - which often lives in personal documents.  
I want to make a shift towards a sharable interface, at first just with natalia, but likely expanding to be a useful tool for others in similar roles across the organization.  
So help me think through the kinds of work I do and will later need to do, and what are some best practices, standard styles and tools and methods, which could facilitate getting things done and showing that they happened and showing that the work I did and that others have done is having a real impact

# CLAUDE:
This is worth thinking through carefully, because one of the core problems you're naming — using a software development PM framework for clinical leadership work — is a genuine category error that leads people to feel like the tools don't fit. Let me build you a proper taxonomy of the work, then talk about what PM approach fits each type, and then discuss what Throughline's design should actually look like.

Here's a reference diagram to anchor the discussion:

~/Downloads/work_domain_pm_framework_map.svg

The color groupings matter: teal represents the patient-facing clinical work (QI and provider comms), blue represents the operational and systems work (operations efficiency and technology), amber is the compliance domain, and coral covers the organizational and people-oriented work (personnel and strategy). Each of these categories has genuinely different information needs, different rhythms, and different PM frameworks that fit naturally — which is why trying to run them all through a single scrum board has always felt wrong.

---

**The terrain: what you're actually managing**

Clinical leadership work at your level in a multi-specialty ambulatory organization falls into domains that have very different textures. Understanding that texture is the prerequisite to designing a tool that fits.

Quality improvement is the most formalized of the domains. Visual management boards prominently showcase key metrics such as patient satisfaction scores, patient volume, and wait times in a visually engaging and easily accessible format, contributing to real-time decision-making and adjusting to enhance operational efficiency. Your QI work — lipid management, AWV completion, preventive screenings, HEDIS gaps, urgent care transfer rates — is intrinsically metric-driven. The natural frame for these projects is the PDSA cycle: a problem statement, a measurable aim, an intervention design, a measurement period, a study phase where you look at what actually moved, and then an Act phase where you either standardize or iterate. The key information to capture for each QI project includes the baseline metric, the target, the current value and trend, the intervention being tested, the accountability structure (who's reporting what to you at what cadence), and the study-act decision. These aren't "percentage complete" projects; they're living cycles that may run for 90 days, pause, restart, and generate descendant projects.

Operations and efficiency work is structurally different. Projects like template redesign, panel rebalancing, float pool coordination, scheduling optimization, or front-desk throughput improvement have a natural before/after shape — there's a current-state assessment, a set of interventions with milestones, and a measurement period that demonstrates (or fails to demonstrate) impact. In ambulatory care, lean improvement principles have improved preventive screenings, communication with patients, coordination of care, and care management of patients with chronic conditions. These projects benefit from a milestone-gated approach: you define the phases (assess → design → pilot → scale → measure), assign owners to each milestone, and track whether those milestones are hit. The Gantt chart is actually appropriate here, even if it feels old-fashioned — a timeline with milestones and owner names surfaces exactly what you need for accountability conversations.

Provider communications is the domain you described in your briefing example, and you correctly identified it as kanban territory. The reason is that communications projects aren't measured by percentage complete — they flow through states: an idea, a draft, a review cycle, a design phase, an approval gate, and then published or live. The transitions between states are the meaningful events to track, and the board makes those visible at a glance. Your intranet tipsheet briefing, a policy announcement, a controlled substances training module — these all fit a similar five-to-seven state pipeline. The critical insight is that different pieces of content can be in different states simultaneously, and the kanban view makes that parallelism legible.

Technology implementation is one of the domains where waterfall thinking genuinely applies. Industries with strict compliance or regulatory requirements often lean towards Waterfall due to its emphasis on detailed documentation, audit trails, and formal processes. When you're rolling out a new Epic workflow, deploying Meridian to a site, integrating DAX Copilot into provider workflows, or standing up Threshold as a shared tool, you have sequential dependencies: requirements must precede build, build must precede test, test must precede go-live. Trying to run these as agile sprints without clear phase gates typically leads to scope creep and delayed go-lives. What you need is a phase definition, a go/no-go checklist at each gate, and a risk register that tracks the items most likely to delay the schedule.

Regulatory and compliance work is the most deadline-driven of the domains. Joint Commission, CMS, NCQA, PCMH recognition, controlled substances regulations — these have external dates that cannot be negotiated, and the audit trail matters as much as the work itself. The PM structure is straightforward: a hard deadline, a set of requirements, a gap assessment, remediation tasks with owners and due dates, and a verification step. The important differentiator is that the documentation of having done the work is often as important as doing it.

Personnel and leadership situations — the corrective action process, onboarding a new provider, managing a leadership transition, a medical director succession — don't fit conventional PM frameworks well. They're inherently timeline-anchored (HR processes have specific escalation triggers), require careful documentation, are often sensitive, and can accelerate or deescalate in ways that change the project shape rapidly. What you need for these is a lightweight chronological log with a clear accounting of who was notified of what and when, the next scheduled event or trigger, and the relevant documentation links. The "project" is really the situation itself, and the tracking is more like a case record than a Gantt chart.

Strategic planning, which for you includes the upcoming regional medical director role, the Meridian expansion, the Resonance Codex architecture, and the broader Crystal Run/Optum integration strategy, maps to OKR-style thinking: a cascading OKR view maps the full hierarchy of goals, from company-level objectives down through teams and individuals, with a birds-eye overview that answers one question: are we on track? The Objective is qualitative and directional ("Establish a regional urgent care quality framework that is recognizably better than the predecessor approach"). The Key Results are measurable and time-bound ("three Threshold calibration sessions completed by Q3," "transfer rate variance between sites reduced by 15% within 6 months"). The initiatives are the actual work that drives the key results. This structure is less about task completion and more about periodic honest assessment: are the key results moving? If not, why not, and what do we change?

---

**What information needs to be curated**

Across all these project types, there's a core set of information that Throughline needs to be able to hold:

For every project of any type: a name, a domain, an owner, a status (in a RAG or richer status scheme), a brief one-sentence description of what success looks like, a set of open actions with responsible parties and due dates, a set of closed/completed actions that constitutes a work log, a link to any associated documents in OneDrive, and a timestamp of the last meaningful update. This is the atomic unit of project tracking.

Then, layered on top by project type: QI projects get metric fields (baseline, target, current, trend direction, measurement date). Operations projects get a milestone table. Communications projects get a state field and a distribution/review list. Technology projects get a risk register. Compliance projects get a hard deadline and an audit date. Personnel situations get a timeline of key events and escalation status.

The "next action" field deserves special emphasis. A living portfolio dashboard connects strategic objectives to day-to-day execution, updates automatically, and flags issues before they spread. Use visual cues consistently, so meaning is obvious at a glance. In practice, the single most useful field in any project record is "what needs to happen next, by whom, by when." This is what breaks the cycle of projects stalling in no-man's-land where everyone assumes someone else is moving things forward.

---

**The nested dashboard architecture**

What you're describing — high-level status for upward reporting, ability to drill into project-level detail, and within a project, the actual work log and task list — maps cleanly to a three-tier dashboard structure that the project management literature calls a portfolio hierarchy.

Not all portfolio dashboards are created equal, and the most effective organizations recognize that different stakeholders need different views of the same underlying data — C-suite leaders don't have time for operational minutiae, but they desperately need strategic visibility. Drill-down capabilities let users start with portfolio overviews and navigate progressively deeper into project details, resource assignments, and individual task status.

The first tier is the portfolio view — a single page that shows every active domain (QI, Operations, Communications, Technology, Compliance, Personnel, Strategy) with a RAG status for each, a count of active projects, and a one-sentence summary of the most pressing issue or recent win. This is the "five-minute briefing for Dr. Schechter" layer. It should be scannable in under a minute and should signal immediately where something needs attention.

The second tier is the domain view — within each domain, a list of active projects with their status, owner (you or Natalia or a named third party), next due action, and the key metric if applicable. This is where you and Natalia coordinate: she should be able to update the status of projects she owns without needing to talk to you first, and you should be able to see at a glance whether something she was supposed to drive has stalled.

The third tier is the project view — the full record: description, history, open actions, closed actions with dates, documents, metric timeline, meeting notes, decisions made. This is where the work actually lives, and it's what protects you when someone asks "what happened with that initiative" six months later.

The technical implication for Throughline is that the OneDrive folder structure becomes the database for tier three (one folder per project, with a structured markdown or JSON file as the project record), the domain view is an index document per domain, and the portfolio view is a single dashboard document that reads from all the domain indexes. This can be built as a simple HTML page or a SharePoint page that reads from OneDrive — and the generation of that dashboard can be automated with a script (which is exactly where your background in Steadyhand-style tooling pays off).

---

**The methodology question in practice**

The reason kanban boards feel irrelevant to most of your work is that kanban was designed for continuous-flow work — a service desk, a software team handling feature requests — where there's a stable pipeline of work items that need to move through defined states at roughly constant volume. Your work is not like that. You have projects that run for three months on a PDSA cycle, projects that hit a milestone and then go quiet for six weeks waiting for a go-live window, personnel situations that may be inactive for months and then require intense activity in a two-week window, and strategic initiatives that are measured quarterly.

What's actually useful from the kanban world is the state-machine model for communications projects, where the question is not "how far along is this" but "what state is this in, and what needs to happen to move it to the next state." Your intranet briefing project is exactly this: it's currently somewhere between "design locked" and "marketing alignment," and the next state transition requires a meeting with the marketing team where you negotiate constraints. That's a Kanban card that needs a blocker flag and a next-action date.

What's useful from waterfall thinking is the milestone gate model for operations and technology work — not the heavyweight documentation overhead, but the discipline of saying "we do not move from phase 2 to phase 3 until we have validated these three things." Waterfall suits projects with stable requirements especially where there is a need to maintain high standards and documentation, and service-oriented projects where problems are not always predictable benefit from Kanban for assigning and ranking tasks without needing fixed iterations.

What's useful from PDSA for your QI work is the forced reflection cycle — the "study" step that many clinician-led QI projects skip, going directly from "do" to "scale" without ever asking whether what they did actually worked. Throughline should support this by surfacing the measurement data alongside the project record, making it easy to say "we ran this intervention from October through December, and here's what the metric did."

---

**Throughline design principles**

Given all of this, a few concrete design principles for what Throughline should feel like:

The primary job is frictionless capture. The biggest cost in your current setup is information falling off scraps of paper and temporary txt files — not a failure of analysis, but a failure of capture surface. Whatever Throughline looks like, the most important interface is the one that lets you add a new action item, a new decision, or a new project record in under thirty seconds, ideally from mobile during a meeting.

Status should be a single authoritative color at every level of the hierarchy. RAG (red/amber/green) is the most universally understood scheme in healthcare. Red means "this needs your attention now or something will fall through." Amber means "watching, may need intervention." Green means "on track." Every project has a status; every domain has an aggregate status derived from its projects; the portfolio view shows a domain-level status grid that can be photographed and texted to Dr. Schechter as a weekly update.

Every action item has exactly one owner. Not "Noah/Natalia" — one of you. This is the accountability layer. When an action item is past its due date and it belongs to a third party (a direct report, a colleague, your boss), Throughline should surface it as an "overdue — needs follow-up" flag, not silently let it age.

The tool should serve two different reading modes: strategic and operational. Strategic mode is the portfolio and domain views — high level, status-oriented, suitable for preparing for a meeting with Dr. Schechter or onboarding a new team member to what you're working on. Operational mode is the project view — granular, task-oriented, the working surface where you actually track what's happening day to day.

The SharePoint/intranet project is a perfect first test case for Throughline's communications pipeline. Track it as a Kanban-style project with states: concept → content drafted → design locked → marketing/IT alignment → approval → live → maintenance. The current blocker is the "marketing team will want control" problem, which is a constraint to capture in the project record alongside the next action: "schedule alignment meeting, bring design spec, define non-negotiable constraints." The fact that SharePoint web parts are limited doesn't change the PM challenge — it just means the delivery vehicle is constrained and that constraint needs to live in the project record.

Finally: build for shareability from day one. You mentioned starting with Natalia and potentially expanding to others in similar roles. The architecture that serves that goal best is one where each project record is a standalone, shareable document — not a database entry that only makes sense inside the system. OneDrive folders accomplish this naturally: every project folder is independently readable by anyone with access to the shared drive, even if they never look at the Throughline dashboard. The dashboard is a convenience layer on top of a structure that works without it.

The fact that Steadyhand has been dormant for weeks, and that your head is foggy with accumulated context, is itself the most important argument for building Throughline with a minimal viable surface first — something that can accept a new project record in thirty seconds, even if it initially doesn't aggregate into a beautiful portfolio dashboard. Start with capture. The dashboard layer can come once the records exist to aggregate.

# ME

Thank you.  We actually do have a strong capture surface.  
Learning from steadyhand, and then from a new project called atom_sandbox, I have a developed a basic but powerful schema which I think fits the needs of the baseline substrate for underpinning all of these different project types.  
Information is added as an "entry".  Entries have a date, a title, and a type.  
Currently there are three types - meeting, email, freetext.  
email is a difficult one to capture usefully, but in the future I do believe tooling is possible that captures incoming information from my inbasket and surfaces it in the appropriate context within our projects.  
Meetings are better - we are using facilitator in microsoft copilot, which produces a .loop artifact that contains an AI summary with distinct sections for themes of information and pending actions with owners.  
I built a separate utility called "loop deloop" which is also integrated into atom sandbox, that extracts the ai summary from each proprietary .loop artifact, as well as the meeting date and participants.  
With that standardized structure, we have an ingestion pathway that processes each extracted .loop summary into a meeting entry.  
the ingestion pathway when an ai summary is processed by the internal tooling includes a way to associate the entry with multiple projects, sorting atoms to the appropriate project.  
atoms are units of information that fall into four classes - observations (objective facts or subjective statements that surfaced in the meeting) decisions (alignment between meeting members on a topic) actions (single concrete step that must be taken, with an owner and optional due date), and outcomes.  
Outcomes are never generated by the AI, not yet.  Instead, when a user marks an action complete, they generate an outcome atom, which not only marks the action atom complete, but appends a user entered statement of how the atom was completed and what the outcome of that completion was.  
The outcome atoms are appended to the entrywhere the action was generated, with a separate date.  Each entry also has a field for tagging people, or adding simple string tags.  
I think that with this substrate we can form the basis for the various project types.  I would like it if Throughline helped us select what sort of PM approach to take when we're creating a project.  
Neither Natalia nor I are project managers, despite doing a lot of ad hoc project management by necessity.  An example Natalia has been giving lately that frustrates her is regarding CAHPS.  
We were contacted by the Optum person who has been working with CDOs to improve their CAHPS measures.  We had a meeting with her where she described the expectation in general terms, choose a CAHPS measure on which we are lagging, write up a proposal for what we are going to do to address it and how we'll demonstrate progress towards improvement, and alerted us that specific documentation materials would be coming.  
We then got an email from her with several attachments, but neither of us have had the bandwidth to open and read all the attachments, though we presume they'd consist of guidelines and tips, general information, and some sort of worksheet or template.  
I can think of a few formats that could suit this, but it may be a project that will require multiple subprojects - monitoring the measure directly may require assistance from the software engineers, or coordinating with optum health analytics, the intervention we take might be in the form of a communication surface with the providers which would be like making an app or drafting an email or planning a meeting, the intervention might take the form of individual counseling so that we'd need to plan out and reserve time for 1:1's with specific providers then monitor their individual progress.  
It would be very helpful if either throughline itself with some AI tooling, or a careful prompt to give to microsoft copilot, which could read all the attachments and help us plan out what kind of project this CAHPS project is...and if it is multiple projects, help design the structure that would support it, maybe an OKR framework on top, with a waterfall for one subproject, a PDSA cycle for another portion, a kanban board for another, and then throughline could sustain the custom dashboard for the overall CAPHS project with a modular set of dashboards supporting the subprojects, and underneath it all are the dated entries showing the actual work across the project's timeline.  
atoms could be marked on project related graphs showing the impact of actions, narrating outcomes, marking decision points.  It all feels quite overwhelming to produce, yet at the same time you've done such a wonderful job sketching it out, I'm going to take this conversation and put it in a markdown file, then have claude code review it against the current program and plan out a development pathway to get us from where we are to where we'd like to be.  What do you think about all that?

# Claude

What you've built is genuinely good, and I want to name specifically what's excellent before talking through the complications.

**The atom schema is right.** The four-type constraint — observations, decisions, actions, outcomes — is not just a data model, it's a theory of how organizational work leaves a trace. Most capture systems conflate these, which is why you end up with meeting notes that are unqueryable prose. By making them typed, you've created something that can answer questions: "show me every decision made in CAHPS-related meetings," "show me all overdue actions where Natalia is owner," "show me the outcome narrative for every action we completed in Q1." Those queries are actually possible now. The action→outcome link specifically is the most important design insight in the whole schema. It creates a causal chain — decision made, action taken, outcome recorded — that becomes the evidence layer for demonstrating impact. That's not obvious and it's not trivial.

The Loop Deloop pipeline is pragmatically elegant. You're using Copilot Facilitator as a structured capture surface that produces reasonably reliable output, then normalizing it into your schema. That's better than trying to build the meeting intelligence yourself.

**The CAHPS project is a program, not a project.** This distinction matters for Throughline's design. A project has one dominant PM framework and a single logical completion state. A program is a strategic objective that coordinates multiple subordinate projects, each of which may have different PM frameworks, different owners, and different timelines. The OKR layer you described is exactly right as the program-level scaffold: Objective ("Meaningfully improve our lagging CAHPS measure within the Optum CDO framework"), Key Results (specific numeric targets, possibly including interim behavioral measures like provider acknowledgment of coaching sessions), and beneath those, the actual subproject work. The reason this matters is that Throughline's dashboard hierarchy needs one more tier than I described earlier: program sits above project, which sits above entry, which contains atoms. The CAHPS dashboard would be the program view, with three or four sub-dashboards aggregating up into it.

**The Natalia usability question deserves explicit design attention.** Everything you've described is coherent and elegant from your perspective — you built it, you understand atoms, you understand PM frameworks, and you have an intuitive feel for when to reach for PDSA versus waterfall. Natalia needs something that works without that background knowledge. The project creation wizard you described is the right answer to this, but I'd push you to be specific about what her experience looks like: she gets a CAHPS email with attachments, she opens Throughline, she creates a new project called "CAHPS improvement initiative," she describes it in a sentence or two, and the system suggests a structure and asks her to confirm or adjust. She should never have to type the word "PDSA." The AI-assisted structuring layer is the feature that makes Throughline something Natalia can use without a briefing from you.

**On the AI-assisted project structuring specifically:** the right design here is a short intake form (project name, one-sentence description, optional document uploads) followed by a Claude API call that returns a structured recommendation: project type, suggested PM framework, proposed phase/state structure, a starter set of milestone or kanban states, and a suggested set of initial action atoms to get the project moving. The response gets rendered as an editable preview before Natalia or you confirms it. That interaction is probably a 400-token prompt + 800-token response and could run in the Throughline UI itself — no need to go to Copilot for this part.

For the CAHPS attachments specifically, before you have that native capability, here's a Copilot prompt worth saving:

> You are helping a medical director and operations director plan a quality improvement initiative. Attached are materials from our Optum quality improvement coordinator regarding CAHPS improvement. Please: (1) summarize the specific expectations and deliverables described in these materials, (2) identify the distinct work streams involved — data/analytics, clinical intervention, provider communication, documentation — and what each requires, (3) suggest whether this should be structured as a single project or a program with subprojects, and if the latter, describe what PM framework fits each subproject, (4) draft a proposed set of initial action items with suggested owners drawn from: Medical Director (Noah), Operations Director (Natalia), software engineering support, Optum analytics, and marketing. Format the output as a structured project plan we can use to get started.

That prompt will work in Copilot Premium with the attachments added, and the output should map fairly directly onto the atom schema — decisions from the meeting become decision atoms, the action items become action atoms, you associate them all with a new CAHPS program record.

**The atoms-on-graphs idea is real and it's worth designing carefully.** The technique is called event annotation — you plot a metric over time and mark the intervention points so you can see before/after visually. Google Analytics has had this since 2010, and clinical QI dashboards use it routinely. The specific design decision you'll need to make is whether metric values are entered manually (Noah or Natalia types in "AWV completion: 61%" on a given date) or pulled from a data feed. Manual entry is unglamorous but works immediately. A data feed from Epic or Optum analytics is the right long-term answer but requires engineering time and probably IT coordination. I'd design the data model to support both — a metric snapshot atom that has a date, a value, a unit, and a source (manual | API) — and ship manual entry first.

**On the development pathway:** before you open Claude Code, I'd suggest being explicit with yourself about the MVP expression of each layer, because the scope you've described could easily be six months of work if developed all at once. The first working version of Throughline that earns its place in your and Natalia's daily workflow probably looks like: program/project hierarchy visible on a dashboard, open action atoms by project with owner and due date, RAG status per project that you set manually, and the project creation wizard with AI-assisted structuring. Everything else — metric annotation, subproject dashboards, email capture — is real and valuable but it's phase two. If you go into the Claude Code session having clearly defined "phase one is these four capabilities," you'll come out with something usable within a few sessions rather than a beautifully architected system that takes weeks to get to first run.

The plan to take this conversation to Claude Code as a reference document is exactly right. One thing worth adding to that document before you do: a clear description of the current atom_sandbox schema in its actual form — the database tables, the fields, the current API surface — so Claude Code is working from the real substrate rather than inferring it from conversation. The conceptual model is clear from what you've described here, but the implementation details will matter when it's time to build on top.

This is a genuinely coherent system. The pieces fit. Go build it.

# ME

That's a great callout.  I have throughline currently designed around two kinds of files: reference files and project files.  I considered reference files to be anything that needs to be tracked but isn't a discrete project.  
Examples would be provider behaviors.  We often get incident reports of various kinds, a provider makes a bad medical decision and gets counseled, or exhibits a bad behavior which we counsel.  This information often lives in email, so we tend to aggregate it in folders.  
While this benefits from a certain amount of graphical representation and management, it's fairly straightforward, and though it does generate actions sometimes - counseling the provider for example, or writing an email to them, or writing an email to all providers or the organization - it's questionable whether it rises to the level of a project.  
It's often a gut decision whether to escalate to a performance improvement project or a corrective action plan, which are definitely projects, but until then we just need a structured place to hold that information that we can later reference for the details if we decide to move forward on a structured intervention.  Projects then are anything that is going to take more than one discrete step to complete.  
An action is one discrete step, and is sometimes a one off that can live in reference files.  Write an email telling providers about an update to epic; could live in a general "provider communications" reference file, or an "epic updates" reference file.  
Projects are more multistep, and involve monitoring a before and after state in some way.  I had thought that beyond that it was just subprojects in one direction and review sessions at various horizons - goals for the week, goals for the month, quarter, year, etc, all composed of ongoing iterating projects.  I love the idea of a program instead - a collection of projects, each of which may need subprojects, and may involve a reference file for general information.  
Clarifying that a project should have one PM tool, and that multiple projects with their individual PM tools live inside a program is very helpful.  A dashboard view for a program could have the most relevant metrics from each PM tool visible.  
It helps also to think about programs as having their own management tools distinct from smaller scale project management tools.  I would hope that you can help flesh out the design discussion for how to best implement these lessons in the v1 version of throughline. as well as downstream iterations with more users and enhanced functionality.

I do need to call out as well - I really don't have an intuitive feel for when to reach for PDSA versus waterfall.  
I have only a general knowledge of these things.  In designing previous iterations of the system, I really only distinguished between reference files, and projects, where projects get a smart goal and reference files get brief description of the kinds of information that should accumulate there.  Before reading your reply above, I only had vague recollections of waterfall, pdsa, gannt charts, etc.  
That's why I'm hoping this system can, in some way, help support the selection and implementation of different PM tools.  agree that neither natalia nor I should open a wizard that assumes we already know what these different PM tools are or how they work.  
the system should have templated structures to support different PM tools, and AI wizard can help us decide which shape to choose, then the program creates the db structures to support that work.  the program should also strongly facilitate data entry.  
It should be easy to plug and play.  That may take some custom tooling per project - if the data is coming from a spreadsheet vs a sql db or even freetext in emails, it's possible to extract, but we need a solid and clear endpoint for each type of information needed for each kind of PM tool to land in.

On the AI assisted project structuring - we cannot use a claude API call, unfortunately, at this time.  My approved pathways are : chat interface with microsoft copilot, or an enterprise approved openi AI api endpoint called cdsapi that can call full GPT 5.4, mini, or nano.  
if it's a small token prompt and response, then the cdsapi is what we'd design around.  Granted, while developing on my linux tooling, we can use an anthropic endpoint for testing.  Thank you for the prompt to give Copilot, I do believe that that would be effective.  

as far as attachments, I'd want the onedrive filetree to be fairly readable to a non-throughline user.  
Throughline would help organize the files, and by implementing a standard structure it would be possible for the throughline frontend to surface and display and extract information from attachments, but I'd want it to be possible to either upload attachments directly to throughline for directed filing, or to simply drop relevant files into a folder within the project folder and for throughline to be able to surface them as simple hyperlinks or with custom per project tooling that surfaces specific information or interactability.

The atoms on graphs is probably best built as a manual item for now, though I'd like tooling that would let me select a point on the graph and assign an atom to it, to avoid needing to manually type the information, though I think manually typing an ad hoc entry to the graph should be supported as well.

# CLaude

What you've described is more mature than I think you're giving it credit for. The atom schema isn't a starting point — it's a solved problem. The question is now architectural: how do you compose that substrate into the layered hierarchy we've been sketching, and what does each layer provide on top of it? Let me draw the object model first, then work through each design decision systematically.

~/Downloads/throughline_object_hierarchy.svg

The hierarchy has four levels. Program holds the strategic container. Project is where PM-framework-specific structure lives — one framework per project, always. Reference File sits at the same level as Project but has no framework; it's just the atom/entry substrate with a description and tags, used for ongoing accumulation without a defined endpoint (exactly right for provider behavior tracking). Entry is the dated unit of capture. Atom is the typed unit of information.

The important clarification: Reference Files belong to a Program if they're contextually related (a CAHPS reference file for background materials lives inside the CAHPS program), or they live at the standalone level for cross-cutting concerns like "provider behaviors" or "epic updates" that don't belong to any one project.

---

**The PM framework template system**

Each framework is a template that defines three things: the structural scaffold (phases, states, or quadrants depending on the type), the required metric fields for that project type, and the dashboard view that's generated from the data. When a project is created with a given framework, Throughline provisions exactly these three things and nothing else. The user never has to understand what PDSA stands for to benefit from the structure.

Here's what each template provides:

A *kanban* project gets a configurable list of states (defaulting to something like "backlog / in progress / in review / done," which the user can rename), a WIP display showing how many items are in each state, and a board view. The metrics for kanban are throughput-oriented: how many items moved to "done" in the last 30 days, current cycle time, items blocked. This fits communications work and any pipeline of discrete deliverables.

A *PDSA* project gets four named phases (Plan, Do, Study, Act) that cycle — this is not a linear progression but an iterative loop, which the dashboard should reflect visually. The metric fields are: aim statement (text), baseline value, target value, measurement frequency, and a time-series log of measured values. The dashboard's central element is the metric chart with phase boundaries marked. This is the right frame for any QI initiative with a measurable clinical endpoint.

A *milestone-gated* project gets a configurable list of milestones, each with a description, owner, due date, go/no-go criteria, and completion status. The dashboard is a timeline view with milestones as markers, current position highlighted. Metric fields are: baseline state description, target state description, and a simple before/after comparison field. Operational improvement projects live here.

A *waterfall/phased* project gets sequential phases with explicit dependencies — phase N cannot begin until phase N-1 is gated. Each phase has a deliverable list, an owner, a planned date, and an actual completion date. The dashboard surfaces the current phase, the next gate, and a risk register (which is just a special class of observation atom tagged as a risk). Technology and compliance work lives here.

A *timeline/triggers* project gets a chronological event log as its primary view, with flagged trigger dates (HR deadlines, regulatory due dates, next required action) prominently displayed. There are no phases, no states — just a log of dated events with associated atoms, and a "next trigger" field that floats to the top. Personnel situations live here. This is also appropriate for compliance tracking where the primary driver is external deadlines.

An *OKR* project is actually what a Program uses as its own management frame — a Program's dashboard is inherently OKR-shaped (objective at the top, key results as progress bars, linked subprojects as the initiative layer). Individual projects within a program don't use OKR; the OKR logic belongs to the Program object itself.

---

**The shape wizard**

When a new project is being created, Throughline asks three questions in plain English before any framework is selected:

First: "What best describes what you're working toward?" with four options — improving a measurable outcome, building or implementing something with defined phases, managing a pipeline of content or tasks, or tracking a situation with important dates. This is enough to narrow to 1-2 framework candidates.

Second: "How will you know when this is done?" with options — when a metric reaches a target, when a set of tasks is completed, when something is published or deployed, or this doesn't have a defined end. The "no defined end" branch routes to Reference File, not a Project.

Third (conditional): if the first two answers point to "improving a measurable outcome" — "Do you already know what the metric is and how to measure it?" Yes/no. Yes means full PDSA scaffolding is provisioned. No means the first phase of PDSA (Plan) is where work begins, and the metric fields are left blank with a prompt to fill them.

The wizard does not mention PDSA, kanban, or waterfall anywhere. It mentions them only in the help text that appears after the framework is selected, as a brief "here's what this structure is called and why it fits your work" explanation. This is the reference-level explanation for curious users, not a prerequisite for using the tool.

---

**The AI-assisted structuring call**

For complex projects like CAHPS — where the user uploads materials and wants help figuring out what kind of project this even is — the AI call goes to cdsapi using a lean prompt designed for GPT-mini or GPT-nano. The call happens after the user has typed a description and optionally pasted extracted text from attachments. The prompt should be small enough that it completes in under two seconds.

A good prompt template for this call:

> Classify this project and suggest a structure. The user is a medical director in a multi-specialty ambulatory care organization. They are not a project manager. Respond only in JSON.
>
> Project description: {{user_description}}
>
> Optionally, relevant document excerpt: {{extracted_text_truncated_to_500_chars}}
>
> Return: {"framework": one of [kanban, pdsa, milestone, waterfall, timeline, program], "reason": "one plain-English sentence, no jargon", "suggested_phases_or_states": ["list", "of", "names"], "suggested_metric": "what to measure, or null", "is_program": true/false, "if_program_subprojects": [{"name": "subproject name", "framework": "framework type", "reason": "one sentence"}], "first_action": "the single most important first step to take right now"}

That prompt runs approximately 180 tokens input for a concise project description, and returns approximately 200 tokens. Well within nano range. The `is_program` field is the key branching decision — if true, Throughline creates a Program record and offers to provision the listed subprojects. If false, it creates a single Project with the recommended framework.

The "first action" field is immediately surfaced as a pre-populated action atom, so the project doesn't start empty. This is the detail that makes the difference between a tool that captures planning and a tool that generates momentum.

---

**OneDrive folder structure**

The folder tree should be legible to someone who has never opened Throughline:

```
/Throughline/
├── Programs/
│   └── CAHPS Improvement 2025/
│       ├── program.json
│       ├── README.md          ← human-readable summary, auto-generated
│       ├── Reference/
│       │   └── (materials dropped here surface as links)
│       └── Projects/
│           ├── Analytics Pipeline/
│           │   ├── project.json
│           │   ├── entries/
│           │   └── attachments/
│           └── Provider Comms Campaign/
│               ├── project.json
│               └── ...
├── Projects/                  ← standalone projects not in a program
│   └── Intranet Briefing Page/
│       ├── project.json
│       └── attachments/
└── Reference/                 ← cross-cutting reference files
    ├── Provider Behaviors/
    │   ├── reference.json
    │   └── incidents/
    └── Epic Updates/
        └── reference.json
```

The README.md at the program level is auto-generated by Throughline on each update and contains: the program objective, current status of each subproject in one line, the three most recent entries across all subprojects, and the five open actions with their owners and due dates. This file is the "Natalia can read this without opening the app" artifact. It also serves as the Copilot-readable context for the program — if you want to paste something into Copilot and ask "what's the current status of CAHPS work," pasting the README is sufficient.

---

**File attachment pathways**

Two pathways with the same destination: both end up in the `attachments/` folder for the relevant project or reference file, with a record in the project.json file.

Pathway one: upload via Throughline. User selects a file in the UI, Throughline writes it to the correct attachments folder via the OneDrive API, appends an attachment record to project.json with filename, date, MIME type, and an optional user-provided label. The attachment appears immediately as a hyperlink in the project view.

Pathway two: drop in folder. User manually copies a file to the OneDrive folder. On next load (or on demand via a "scan folder" button), Throughline compares the contents of the attachments folder against the records in project.json. New files found in the folder but not in the records get surfaced as "unregistered attachments" with a prompt to add a label and confirm. Confirmed files get appended to the records. This pathway is important because it respects the existing workflows of people who manage files directly in OneDrive.

For per-project custom tooling on specific attachment types — for example, a CAHPS worksheet that Throughline knows how to parse and extract a gap table from — the architecture should support an `attachment_handler` field in the project template that specifies a processor. In v1, all attachments are surfaced as hyperlinks with no processing. In later iterations, specific attachment types for specific project templates can have registered handlers that extract structured data. The CAHPS worksheet is a good candidate for the first such handler, since it presumably has a consistent structure across projects.

---

**Atoms on graphs**

The metric chart in a PDSA or milestone project shows a time series. The annotation interaction works like this: the user clicks any point on the line (or any empty space on the time axis), a popover appears at the click location with three options:

"Link an existing atom" opens a search/filter panel showing atoms from this project's entries sorted by date proximity to the clicked point. The user selects one and it appears as an annotated marker on the chart at the appropriate date.

"Add a note" opens a small text field pre-populated with the date corresponding to the click position. The user types a free text annotation. This creates a new observation atom in a special "chart annotation" entry for the project, so it's stored in the atom layer and can be retrieved by other views.

"Mark intervention start" is a shortcut for PDSA projects that places a vertical phase-boundary line at the clicked date, labeled with the current phase name. This is the most common annotation action in QI work — "we started the intervention here" — and making it one click rather than a multi-step process is what determines whether it actually gets used.

The underlying data model for annotations is: every metric data point is a row in a `metrics` table (or JSON array) with a `date`, `value`, `unit`, and an optional `atom_ids` array. When an atom is linked to a chart point, its ID is appended to the nearest date bucket. When "add a note" creates a new atom, that atom's ID is added to the appropriate bucket. The chart rendering layer then draws annotation markers at any date bucket that has `atom_ids` populated, with a click handler that shows the linked atom content.

---

**V1 scope**

Given the cdsapi constraint, the OneDrive file store, and the goal of having something Natalia can use without a briefing, v1 should ship exactly these capabilities and nothing else:

The object hierarchy: program, project, reference file, entry, atom — all the DB structures created and navigable.

Four framework templates: kanban, PDSA, milestone-gated, and timeline/triggers. These cover the large majority of your actual work. Waterfall can come in v1.1 — in practice, waterfall and milestone-gated are close enough that milestone-gated handles most technology projects at your level of abstraction.

The shape wizard: three plain-English questions, cdsapi call, framework recommendation with explanation, first action provisioned automatically.

Program dashboard: objective, key results (manually entered progress), subproject grid with RAG status and one-line status text, and recent entries feed across the program.

Project dashboard: framework-appropriate view (board for kanban, four-quadrant for PDSA, timeline for milestone/triggers), open actions by owner, file attachment links.

File attachment: upload pathway only in v1. Folder-scan pathway is v1.1.

Atoms on charts: manual entry only in v1, with date pre-fill. Click-to-link-existing-atom is v1.1.

Loop Deloop ingestion: wire it into the entry creation pathway if it already exists as a standalone utility, but don't block v1 on it if the integration is complex.

The CAHPS project is the right first real-world test case because it exercises all four templates (program-level OKR, milestone for analytics, kanban for communications, PDSA for the actual QI intervention), the attachment ingestion pathway, and the shape wizard for Natalia's onboarding. If Throughline handles CAHPS cleanly in v1, the architecture is right.

---

**Later iterations**

The three natural v2 capabilities, in priority order, are: the folder-scan attachment pathway (because it makes OneDrive the source of truth without requiring everything to go through the UI), multi-user entry creation for Natalia (she should be able to create entries and add atoms independently, with her name appearing as the author), and a "prepare for review" export function that reads from a program's entries and atoms and generates a formatted summary suitable for a Dr. Schechter briefing — leveraging the cdsapi for the synthesis pass and the README.md structure as the output format.

The email capture pathway is real and valuable but requires the most infrastructure work — reading from inbox, identifying relevant threads, extracting atoms. That belongs in v3 alongside the Copilot Facilitator pipeline being fully automated rather than requiring Loop Deloop to run manually.

The metric data connector (Epic or Optum analytics) is the long-term unlock for the atoms-on-graphs feature to reach its full value, because manually entering monthly metric values is sustainable but fragile. When the connector exists, metric snapshots become automatic and the annotation interaction is the primary human-added layer. That's when the graph stops being a chart and starts being a narrative.
