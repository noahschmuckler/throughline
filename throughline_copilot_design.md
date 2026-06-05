# Throughline + Copilot Integration Design (v0.1)

## Overview

Throughline is evolving into a **structured execution engine** that manages:

- Projects, programs, reference files
- Entries (meetings, email, free text)
- Atomized units of work (actions, decisions, observations, outcomes)

Copilot acts as a **reasoning layer** that:
- Interprets unstructured input
- Suggests structured representations
- Recommends placement into the system
- Generates commands (not direct writes)

---

# 🧠 Core Architecture

## Design Principle

```
Throughline = State + UI + Persistence
Copilot     = Reasoning + Structuring + Recommendation
User        = Control + Validation
```

---

## Key Rule

❌ Copilot NEVER writes directly into `state.json`  
✅ Copilot outputs **commands + proposals**  
✅ Throughline performs **review → validation → write**

---

# 🔁 Primary Workflow Loop

## Step 1 — Intake (Unstructured Input)

User provides:
- Dictation (speech → text)
- Email thread
- Notes / documents

No formatting required.

---

## Step 2 — Copilot: First Pass (Understanding)

### Output 1 (Human-readable)

Natural language response:
- Summary of intent
- Framing of problem
- Key areas/topics

---

### Output 2 (Structured Topics)

```json
{
  "topics": [
    {
      "title": "string",
      "summary": "string",
      "items": []
    }
  ],
  "candidate_actions": [],
  "candidate_decisions": [],
  "uncertainties": [],
  "needs_clarification": []
}
```

---

## Step 3 — Placement Reasoning

Copilot does NOT assign directly.

Instead returns ranked candidates:

```json
{
  "placement_recommendations": [
    {
      "item": "string",
      "candidates": [
        {
          "project_id": "string",
          "confidence": 0.0,
          "reason": "string"
        },
        {
          "project_id": "new_project_required",
          "confidence": 0.0
        }
      ]
    }
  ]
}
```

---

## Step 4 — Command Generation

Copilot outputs structured commands:

```json
{
  "commands": [
    {
      "type": "create_project",
      "title": "string",
      "recommended_framework": "kanban | pdsa | milestone | timeline",
      "reason": "string",
      "confidence": 0.0
    },
    {
      "type": "propose_atom",
      "atom_kind": "action | decision | observation | outcome",
      "body": "string",
      "target_project": "string",
      "confidence": 0.0
    }
  ]
}
```

---

## Step 5 — Throughline Execution

Throughline:
1. Presents commands to user
2. Allows edit / accept / reject
3. Writes approved items into `state.json`

---

# 🔄 Context Loop (Query-by-Proxy System)

## Problem

Copilot is stateless:
- Cannot retain long-term knowledge
- Needs relevant context per call

---

## Solution

Copilot returns **context queries**

```json
{
  "context_queries": [
    {
      "type": "get_project_summary",
      "project_ids": []
    },
    {
      "type": "search_actions",
      "keywords": []
    }
  ]
}
```

---

## Execution Flow

```
Copilot → returns queries  
Throughline → executes queries  
Throughline → builds enriched state_summary.json  
User → re-submits enriched context  
Copilot → performs deeper reasoning
```

---

# 📦 state_summary.json (Working Memory)

## Purpose

Reduced, focused context instead of full `state.json`

---

## Schema

```json
{
  "active_programs": [
    {
      "id": "string",
      "title": "string",
      "summary": "string"
    }
  ],
  "active_projects": [
    {
      "id": "string",
      "title": "string",
      "summary": "string",
      "framework": "string",
      "open_actions": []
    }
  ],
  "recent_actions": [],
  "recent_decisions": [],
  "key_entities": [
    {
      "name": "string",
      "type": "person | system | initiative"
    }
  ]
}
```

---

# ⚡ Key Design Innovations

## 1. Pre-Atom Layer

Do NOT atomize immediately.

Instead:
1. Extract topics
2. Structure ideas
3. THEN atomize

---

## 2. Multi-Candidate Placement

❌ Never assign directly  
✅ Always provide ranked options  

---

## 3. Command-Based Writing

Copilot outputs:
- Commands
- Not data inserts

---

## 4. Human-in-the-Loop Validation

All writes must be:
- Reviewed
- Editable
- Confirmed

---

# 🚧 Guardrails (CRITICAL)

## Atom Rules

✅ Each atom must:
- Be ≤ 2 sentences
- Represent ONE idea
- Be actionable or clearly categorized

❌ Disallowed:
- Multi-action bundling
- Narrative paragraphs
- Context-heavy content

---

## No Auto-Filing

❌ Never write without review  
❌ Never silently assign to project  

---

## Layer Separation

Maintain distinct layers:

1. Raw Input
2. Topic Structuring
3. Placement Reasoning
4. Command Generation
5. Execution

---

# 📊 Confidence + Friction Model

Every command includes:

```json
{
  "confidence": 0.0,
  "friction": "low | medium | high"
}
```

---

# 🧩 Example End-to-End Flow

### Input (dictation)

> “Natalia has this spreadsheet… people keep asking her questions…”

---

### Copilot Output

#### Natural Language

- Identifies bottleneck
- Frames as operationalization task

---

#### Commands

```json
{
  "commands": [
    {
      "type": "create_project",
      "title": "Provider Roster Operationalization",
      "recommended_framework": "kanban",
      "confidence": 0.92
    },
    {
      "type": "propose_atom",
      "atom_kind": "action",
      "body": "Extract key provider data from roster spreadsheet into accessible format",
      "confidence": 0.88
    }
  ]
}
```

---

# 🧭 Strategic Objective

Throughline is solving:

> **Decoupling knowledge from individuals and converting it into shared operational systems**

---

# ✅ Summary

This design transitions Throughline from:

> “Smart note-taking with AI”

To:

> **A distributed operational reasoning system with human validation**
