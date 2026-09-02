# Published Pipelines migration profile

The SQL files in this directory are frozen verbatim from the published tag
`v0.11.1-pr2863.202607311655`. They are test fixtures, not active migrations.

Migrations `0001` through `0039` at that tag are byte-identical to the active
files on main. The end-to-end migration test therefore applies main through
`0039`, applies these fixtures through `0051`, seeds representative durable
data, closes the database, and upgrades it through the production `sqlite.Open`
entrypoint.

Do not edit these fixtures to match current migrations. Their purpose is to
freeze the database lineage that reached users and prevent the compatibility
repair from drifting away from its source profile.
