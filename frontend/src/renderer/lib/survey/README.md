# In-product micro-surveys

Zero-friction, one-tap questions that fill the gaps behavioral telemetry can't:
profession, is there a team, how people actually work, would they miss us, what
broke, and open feedback. Each is anchored to a moment (opened the app, added a
repo, finished/failed a session) so the answer is an obvious fact, not a "which
kind of user am I?" deliberation.

## Why custom, not PostHog's native surveys

The renderer sets `disable_surveys: true` and `advanced_disable_flags: true`
(see `lib/telemetry.ts`) because `/surveys` and `/flags` poll PostHog on init
and are billed per request, pure cost for ~2k users. So this ships its own tiny
prompt and records the answer as an **ordinary captured event**. No extra
network requests, no `survey:write` key, nothing to create in PostHog.

## The card

One dismissible card, bottom-right, that slides up after a completed action and
appears **at most once per user per week**. Three input types:

- **single** — one tap, auto-submits.
- **multi** — toggle several, then Done.
- **text** — a short-answer box with Send / Skip.

## Events

| Event | When | Properties |
|---|---|---|
| `ao.renderer.survey_shown` | a survey is displayed | `survey` |
| `ao.renderer.survey_answered` | user submits | `survey`, `choice` (+ `choices[]` for multi) |
| `ao.renderer.survey_dismissed` | user closes it | `survey` |

## The pool (see `definitions.ts`)

| id | Trigger | Input | Question |
|---|---|---|---|
| `profile` | app open | single | What best describes you? |
| `repo-who` | repo added | single | Who else works in this repo? |
| `repo-purpose` | repo added | single | This project is… |
| `pmf` | 3rd spawn | single | If AO disappeared tomorrow? |
| `task-type` | after a session | multi | What did you use this agent for? |
| `autonomy` | after a session | single | How closely did you watch it? |
| `wish` | 5th spawn | text | One thing you wish AO did automatically? |
| `would-pay` | 5th spawn, Work + My-team only | single | Is AO worth paying for? |
| `feedback` | 8th spawn | text | Anything you'd tell the team? |
| `blocker` | spawn failed | multi | Biggest thing slowing you down? |

Guarantees (in `surveyController.ts`, unit-tested): one per user per week, never
re-ask an answered or dismissed one, activation gates via `minSpawns`, and
`would-pay` reaches only users who already said Work + My team, so it can never
nag a student.

## Wiring

- `routes/__root.tsx` → `onAppStart()` on open; `<SurveyPrompt />` mounted once.
- `lib/spawn-orchestrator.ts` → `onSessionSpawned()` on success, `onSpawnFailed()` on failure.
- `routes/_shell.tsx` → `onProjectAdded()` after a project is added.

## Turning answers into decisions

Cross the PMF answer against profile / repo answers and **actual retention** —
whoever says "I'd be lost", is a Developer/Founder on a Work + My-team repo, and
keeps coming back, is your ICP, discovered from data, not assumed:

```sql
select
  a_pmf.choice as pmf, a_profile.choice as profile, a_who.choice as team,
  count(distinct a_pmf.person_id) as users,
  round(100 * countIf(a_pmf.person_id in (
     select distinct person_id from events
     where event='ao.session.spawned' and timestamp > now() - interval 7 day
  )) / count(distinct a_pmf.person_id), 1) as still_active_pct
from (select person_id, properties.choice as choice from events
      where event='ao.renderer.survey_answered' and properties.survey='pmf') a_pmf
left join (select person_id, properties.choice as choice from events
      where event='ao.renderer.survey_answered' and properties.survey='profile') a_profile using(person_id)
left join (select person_id, properties.choice as choice from events
      where event='ao.renderer.survey_answered' and properties.survey='repo-who') a_who using(person_id)
group by pmf, profile, team order by still_active_pct desc
```
