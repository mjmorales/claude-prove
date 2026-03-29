---
name: round-table
description: >
  Orchestrate a multi-agent round-table discussion among expert subagents who
  build on each other's ideas across multiple rounds. Use when the user wants
  diverse expert perspectives on a hard problem -- game design, architecture,
  debugging, balance, strategy, or any domain where a single viewpoint is
  insufficient. Also triggers on: "get multiple perspectives", "debate this",
  "what would experts say", "round-table", "brainstorm with agents", "devil's
  advocate", or when a problem clearly benefits from structured multi-expert
  deliberation even if the user doesn't explicitly ask for it.
---

# Round-Table Discussion

Orchestrate a structured multi-round discussion among expert subagents. Each
agent runs in its own context window (via the Agent tool), preventing cross-
contamination and attention degradation. The orchestrator (you) manages rounds,
compiles briefing packets, and assembles the transcript.

## Why This Design Works

Multi-agent debate research shows that naive "share everything and discuss"
patterns fail -- agents become sycophantic, abandon correct positions, and
converge prematurely (Du et al. 2023; Smit et al. 2024). The design below
counters these failure modes through three mechanisms:

1. **Heterogeneous roles** -- agents with distinct expertise lenses produce
   genuinely different analyses, not rephrased versions of the same reasoning
   (A-HMAD, Springer 2025)
2. **Structured briefing packets** -- instead of dumping full transcripts,
   surface tensions and questions that force engagement with specific reasoning
3. **Explicit permission to disagree and evolve** -- counter RLHF sycophancy
   by instructing agents that changing position requires stating what changed
   their mind, and holding position requires engaging with the strongest
   counterargument

## Orchestration Flow

### 1. Parse the Request

Extract from the user's message:

- **Topic**: the problem or question to discuss
- **Agents**: specific expert roles requested (if any)
- **Rounds**: number of discussion rounds (default: 3)
- **Output path**: where to save the transcript (default: ask the user)

If the user didn't specify agents, recommend 3-5 based on the topic. Explain
your choices and let the user adjust before proceeding. Fewer than 3 agents
produces weak cross-pollination; more than 5 creates noisy briefings.

### 2. Prepare the Topic Brief

Before spawning agents, research the topic yourself. Read relevant files in the
codebase (use Glob, Grep, Read) and search the web if the topic warrants it.
Produce a **topic brief** -- a concise summary of the problem, relevant context,
constraints, and what a good outcome looks like. This brief goes to every agent
in Round 1 so they share a common factual foundation.

### 3. Run the Rounds

#### Round 1: Independent Analysis

Spawn all agents in parallel. Each agent receives:

```text
You are [ROLE NAME], an expert in [DOMAIN].

## Your Lens
[2-3 sentences defining what this expert uniquely cares about and how they
evaluate problems. Be specific -- not "you care about balance" but "you
evaluate whether mechanical interactions create dominant strategies that
collapse decision space."]

## Topic
[The topic brief from Step 2]

## Instructions
Analyze this topic through your expert lens. Use available tools (Read, Grep,
Glob, Bash, WebSearch) to research before responding -- ground your analysis
in evidence, not speculation.

Structure your response:
1. **Assessment** -- your expert read on the situation (3-5 key points)
2. **Proposals** -- concrete suggestions, with reasoning
3. **Risks** -- what could go wrong, what are you uncertain about
4. **Questions** -- what would you want to ask the other experts

You will participate in a multi-round discussion. Your thinking will evolve
as you hear from other experts. Changing your mind based on good arguments
is a strength, not a weakness -- but state what convinced you. Holding your
position against pressure is also fine -- but engage with the strongest
counterargument, don't just ignore it.
```

Collect all Round 1 responses.

#### Rounds 2 through N-1: Cross-Pollination

This is where value emerges or doesn't. The briefing packet design is critical.

**Compile the briefing packet** by reading all responses from the previous round
and extracting:

1. **Tensions** -- where experts explicitly or implicitly disagree. State the
   disagreement as a question: "Agent A argues X because of Y. Agent B argues
   the opposite because of Z. Which reasoning is stronger, and why?"

2. **Novel ideas** -- proposals or framings that only one expert raised. Flag
   them: "Agent C proposed [idea]. No one else addressed this. Is it viable?
   What are the implications?"

3. **Convergence points** -- where multiple experts independently reached the
   same conclusion. Note these briefly so agents don't re-argue settled points.

4. **Open questions** -- questions agents posed in the previous round that
   weren't answered. Route them to the expert best positioned to answer.

5. **Evolution tracker** -- for Round 3+, note how positions have shifted:
   "In Round 1, Agent A argued X. In Round 2, they shifted to Y after hearing
   Z's argument about W. Is this the right move?"

Do NOT include full transcripts of other agents' responses. The briefing packet
is a curated editorial product, not a copy-paste job. Full transcripts cause
agents to fixate on phrasing rather than reasoning, and waste tokens that could
go toward deeper analysis.

Each agent receives:

```text
You are [ROLE NAME], continuing the round-table discussion.

## Your Previous Position
[Paste their own previous response -- they need their own context back since
each invocation is a fresh context window]

## Briefing: What Other Experts Said (Round N)
[The compiled briefing packet]

## Instructions for This Round
Respond to the briefing. Prioritize:
- Engaging with tensions that involve your expertise
- Answering questions directed at you
- Building on novel ideas from others (not just acknowledging them -- extend,
  combine, or critique them)
- Updating your proposals based on what you've learned

If you've changed your mind on something, state clearly what changed it.
If you haven't, engage with the strongest argument against your position --
explain specifically why it doesn't hold, don't just reassert.

Avoid: restating your Round 1 position unchanged, vague agreement ("great
point"), or surface-level engagement with complex arguments.

Structure your response:
1. **Reactions** -- what shifted your thinking, what didn't, and why
2. **Updated proposals** -- refined or new suggestions
3. **Remaining disagreements** -- where you still push back, with reasoning
4. **Synthesis attempts** -- can any competing ideas be reconciled?
```

#### Final Round: Convergence

The last round has a different prompt focus:

```text
You are [ROLE NAME], delivering your final contribution to the round-table.

## Your Previous Position
[Their Round N-1 response]

## Briefing: Final Round
[Briefing packet emphasizing: remaining open tensions, strongest proposals
that emerged, and areas where the group is close to consensus but not there]

## Instructions
This is the final round. Focus on:
1. **Your top recommendations** -- max 3, concrete and actionable
2. **What the group got right** -- the strongest ideas that emerged
3. **Unresolved tensions** -- disagreements that need the user's judgment
4. **Surprises** -- anything you learned that changed your expert perspective

Be decisive. The user needs actionable output, not "it depends."
```

### 4. Synthesize and Save

After all rounds complete:

1. **Write the transcript** -- compile the full discussion into a structured
   document. Use this format:

```markdown
# Round-Table: [Topic]
**Date**: [date]
**Rounds**: [N]
**Experts**: [list with roles]

## Topic Brief
[The brief from Step 2]

## Round 1: Independent Analysis
### [Agent Name] ([Role])
[Full response]

## Round 2: Cross-Pollination
### Briefing Packet
[The briefing you compiled]
### [Agent Name] ([Role])
[Full response]

[...repeat for all rounds...]

## Synthesis
### Key Recommendations
[Ordered list of the strongest actionable recommendations that emerged]

### Points of Consensus
[What the experts agreed on]

### Unresolved Tensions
[Disagreements that need the user's judgment, with each side's best argument]

### Ideas Worth Exploring
[Novel proposals that surfaced but weren't fully developed]
```

1. **Write the synthesis section yourself** -- don't delegate this to an agent.
   You have the full picture across all rounds. Distill it honestly: surface
   genuine disagreements, don't paper over them with false consensus.

1. **Save to the output path** and tell the user where to find it.

1. **Present a brief summary** in the conversation -- 5-10 bullet points
   covering the most important takeaways. Point the user to the full transcript
   for depth.

## Agent Role Design

When auto-selecting agents, pick roles that create productive tension. Agents
who would agree on everything add no value. Agents who talk past each other
(no shared vocabulary or concerns) add noise.

**Good combinations** create overlapping-but-distinct concerns:

- Game designer + game balancer (both care about mechanics, disagree on
  player freedom vs. competitive integrity)
- Architect + product owner (both care about shipping, disagree on technical
  debt tolerance)
- Narrative designer + UI designer (both care about player experience,
  approach it from different angles)

**Avoid** pure adversarial pairings (devil's advocate + yes-man) -- research
shows rigid adversarial structures underperform diverse cooperative ones.

When the user specifies custom agents not in the known set, define their lens
based on the role name and topic context. Ask the user to confirm if the role
is ambiguous.

## Configuration Defaults

| Parameter | Default | Range  | Notes                                                            |
| --------- | ------- | ------ | ---------------------------------------------------------------- |
| Rounds    | 3       | 2-5    | 2 rounds = shallow; 5 rounds = diminishing returns and token cost|
| Agents    | 3-4     | 2-6    | Auto-selected based on topic                                     |
| Output    | ask user| --     | Suggest `docs/round-tables/[topic-slug].md`                      |

## Error Handling

- If an agent invocation fails, retry once. If it fails again, note the gap
  in the briefing packet and continue with remaining agents.
- If the user interrupts mid-discussion, save the partial transcript and offer
  to resume or restart.
- If agents converge completely by Round 2, skip remaining rounds -- forced
  disagreement produces noise. Tell the user consensus was reached early.

## Token Budget Awareness

Each agent invocation consumes a full context window. For a 3-round, 4-agent
discussion, that's 12 agent invocations. Keep individual prompts focused:

- Topic brief: under 500 words
- Briefing packets: under 800 words
- Agent responses: no explicit limit, but the prompt structure discourages
  rambling by asking for structured output

The orchestrator's main token cost is reading all responses to compile
briefings. This is unavoidable -- quality briefings require understanding the
full discussion.
