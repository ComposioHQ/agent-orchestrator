# ValidatorEngine-3P

This example shows how to run a non-coding AO worker that validates startup ideas using live public evidence instead of writing code.

Files:

- `examples/idea-validator-3p.yaml`
- `examples/prompts/validatorengine-3p.md`

## What This Agent Does

The validator does one job: it takes a startup idea from an upstream Idea Sourcerer, tries to disprove it first, then checks live public discussion sources such as Reddit, Product Hunt, Hacker News, GitHub, review sites, and app stores for evidence about pain, competition, willingness to pay, and distribution reality.

It does not source ideas.
It does not brainstorm new ideas before validating the submitted one.
It can suggest pivots only after it has scored the submitted idea.

The workflow is:

1. Phase 1 converts the idea into falsifiable hypotheses and kill criteria.
2. Phase 2 gathers live quotes, comments, reviews, and launch-discussion signals.
3. Phase 3 turns that evidence into a hard verdict: `GREEN`, `YELLOW`, or `RED`.

## What The Idea Sourcerer Must Send

The validator expects a JSON payload like this:

```json
{
  "idea_id": "IDEA-123",
  "idea": "AI SDR for local service businesses",
  "optional_context": "ICP: plumbers and roofers. Founder can build AI workflow tooling, budget <$500/mo, wants B2B SaaS, prefers agency distribution.",
  "source_agent": "idea-sourcerer"
}
```

Required fields:

- `idea_id`
  A stable identifier used for tracking runs and cross-agent references.
- `idea`
  The exact startup idea to validate. This should be a single idea, not a list.
- `source_agent`
  The upstream agent or system name, usually `idea-sourcerer`.

Optional field:

- `optional_context`
  Extra detail that helps the validator test the right assumptions. This is optional, but higher-quality context leads to better validation.

## What To Put In `optional_context`

Good `optional_context` usually includes:

- target customer or ICP
- founder constraints
- budget constraints
- desired business model
- geography or market
- industry vertical
- acquisition channel assumptions
- pricing assumptions
- any explicit thesis from the Idea Sourcerer that should be stress-tested

Example:

```json
{
  "idea_id": "IDEA-456",
  "idea": "AI concierge for wedding venue lead qualification",
  "optional_context": "ICP: independent wedding venues in the US doing 20-80 weddings/year. Founder wants software revenue, not services. Concern: venues miss inbound leads after hours. Hypothesis: speed-to-lead matters more than CRM depth.",
  "source_agent": "idea-sourcerer"
}
```

Bad inputs:

- vague prompts like `find me something in healthcare`
- multiple unrelated ideas in one payload
- no user or market context when the idea is highly ambiguous
- asking the validator to invent a better idea instead of first scoring the submitted idea

## What The Validator Returns

By default the prompt runs all 3 phases in one pass.

Phase 1 returns:

- idea restatement
- falsifiable hypotheses
- kill criteria
- platform query map

Phase 2 returns:

- evidence ledger with source URLs
- quote labels
- hypothesis mappings
- collection stats
- data gaps

Phase 3 returns:

- TL;DR verdict
- scorecard
- what is wrong or why it works
- pain themes
- competitor signals
- 14-day action plan
- pivot options
- what would change the verdict

## Evidence Quality Rules

The validator is designed to prefer stronger evidence in this order:

1. buyer, user, operator, or reviewer comments
2. full discussion threads
3. review-platform feedback
4. launch-page comments
5. listing snippets, maker copy, or repo metadata as fallback only

If a platform is inaccessible, the agent should say:

- attempted platform
- failure reason
- fallback used

If dates, engagement, or author names are missing, the validator should say `unavailable` instead of guessing.

## Smoke Test Mode vs Full Validation

Use full validation when you want production-quality evidence harvesting.

Use `smoke_test_mode` only for prompt checks and agent QA. In smoke mode the validator still runs all 3 phases, but evidence volume is intentionally reduced. The output should say that coverage is shallow and confidence is lower.

## Example Spawn

```bash
ao spawn startup-factory --prompt '{"idea_id":"IDEA-123","idea":"AI SDR for local service businesses","optional_context":"ICP: plumbers and roofers. Prefer agency channel.","source_agent":"idea-sourcerer"}'
```

## How To Read The Verdict

- `GREEN`
  Strong evidence of painful demand, willingness to pay, and a believable distribution wedge.
- `YELLOW`
  Real signal exists, but the idea is weak, narrow, crowded, or needs repositioning.
- `RED`
  The idea is not compelling as stated. Pain may still be real, but the wedge, timing, trust, or moat is weak.

The most useful output is often not the color alone. The best signal is usually:

- which assumptions failed
- which evidence killed the idea
- whether a narrower wedge survives

## Related Files

- [idea-validator-3p.yaml](../idea-validator-3p.yaml)
- [validatorengine-3p.md](../prompts/validatorengine-3p.md)
