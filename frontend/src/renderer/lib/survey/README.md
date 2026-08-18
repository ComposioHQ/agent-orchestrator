# In-product survey

A short, centered survey the user opens from the sidebar "Help shape AO"
invite. Five questions that turn into user metrics: who they are, what they use
AO for, whether it sticks, what slows them down, and one open wish.

## Why custom, not PostHog's native surveys

The renderer sets `disable_surveys: true` and `advanced_disable_flags: true`
(see `lib/telemetry.ts`) because `/surveys` and `/flags` poll PostHog on init
and are billed per request. So this ships its own modal and records answers as
ordinary captured events, no extra network requests, nothing to set up in
PostHog.

## Flow

The survey opens only when the user clicks the sidebar invite (opt-in, never an
auto-pop). It runs one question at a time in a centered modal with a progress
bar. Crossing the invite (✕) hushes it for 48 hours; finishing marks it complete
so it never returns.

## The five questions (`definitions.ts`)

| id | Input | Question |
|---|---|---|
| `profile` | single | What best describes you? |
| `task-type` | multi | What did you use this AO for? |
| `pmf` | single | If AO disappeared tomorrow? |
| `blocker` | multi | What slows you down most in AO? |
| `wish` | text | One thing you wish AO did automatically? |

## Tracking (the point)

Every answer is captured (properties registered in
`telemetry.ts` → `sanitizeRendererProperties`):

| Event | When | Properties |
|---|---|---|
| `ao.renderer.survey_answered` | per question | `survey`, `choice`, `choices[]` (multi) |
| `ao.renderer.survey_completed` | on finish | `answer_profile`, `answer_task_type`, `answer_pmf`, `answer_blocker`, `answer_wish` |
| `ao.renderer.survey_invite_dismissed` | invite crossed | — |

`survey_completed` carries the whole response as one row, so metrics need no
joins: break it down by `answer_profile` for the persona mix, `answer_pmf` for
stickiness (cross-tab with profile = which persona sticks), `answer_task_type` /
`answer_blocker` for how they work and where friction is, and list `answer_wish`
for the roadmap.
