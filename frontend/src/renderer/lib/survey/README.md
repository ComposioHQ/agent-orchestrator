# In-product micro-surveys

Zero-friction, one-tap questions that fill the gaps behavioral telemetry can't:
is a repo **work / personal / learning**, is there a **team**, would they **miss
us**, what **broke**. Each is anchored to a moment (a repo just added, a spawn
that failed) so the answer is an obvious fact, never a "which kind of user am
I?" deliberation.

## Why custom, not PostHog's native surveys

The renderer deliberately sets `disable_surveys: true` and
`advanced_disable_flags: true` (see `lib/telemetry.ts`) because `/surveys` and
`/flags` poll PostHog on init and are billed per request, pure cost for ~2k
users. So this ships its own tiny prompt and records the answer as an **ordinary
captured event**. No extra network requests, no `/flags` dependency, no
`survey:write` API key, and full control of the one-tap UX. Nothing needs to be
created in PostHog.

## What it emits

| Event | When | Properties |
|---|---|---|
| `ao.renderer.survey_shown` | a survey is displayed | `survey` |
| `ao.renderer.survey_answered` | user taps a choice | `survey`, `choice` |
| `ao.renderer.survey_dismissed` | user closes it | `survey` |

## The surveys (see `definitions.ts`)

| id | Trigger | Question |
|---|---|---|
| `repo-who` | project added | Who else works in this repo? |
| `repo-purpose` | project added | This project is… |
| `pmf` | spawn ≥ 3 | If AO disappeared tomorrow? |
| `what-broke` | spawn failed | What went wrong? |
| `why-ao` | 2nd session | AO is most useful to you for… |
| `would-pay` | spawn ≥ 5, only Work + My-team users | Would your team pay for this? |

Guarantees (enforced in `surveyController.ts`, unit-tested): **at most one
survey per user per week**, never re-ask an answered or dismissed one,
activation gates via `minSpawns`, and `would-pay` only reaches users who already
said Work + My team, so it can never nag a student.

## Wiring (already done)

- `lib/spawn-orchestrator.ts` → `onSessionSpawned()` on success, `onSpawnFailed()` on failure.
- `routes/_shell.tsx` → `onProjectAdded()` after `project_add_succeeded`.
- `routes/__root.tsx` → `<SurveyPrompt />` mounted once (fixed, dismissible, bottom-right).

## Turning answers into decisions (the whole point)

Cross the PMF answer against the repo answers and **actual retention**, whoever
says "I'd be lost", whose repos are Work + My team, *and* who keeps coming back,
is your ICP, discovered from data:

```sql
select
  a_pmf.choice                              as pmf,
  a_purpose.choice                          as purpose,
  a_who.choice                              as team,
  count(distinct a_pmf.person_id)           as users,
  round(100 * countIf(a_pmf.person_id in (
     select distinct person_id from events
     where event='ao.session.spawned' and timestamp > now() - interval 7 day
  )) / count(distinct a_pmf.person_id), 1)  as still_active_pct
from (select person_id, properties.choice as choice from events
      where event='ao.renderer.survey_answered' and properties.survey='pmf') a_pmf
left join (select person_id, properties.choice as choice from events
      where event='ao.renderer.survey_answered' and properties.survey='repo-purpose') a_purpose using(person_id)
left join (select person_id, properties.choice as choice from events
      where event='ao.renderer.survey_answered' and properties.survey='repo-who') a_who using(person_id)
group by pmf, purpose, team
order by still_active_pct desc
```

The row with the highest `still_active_pct` is the segment to double down on in
onboarding, messaging, and pricing.
