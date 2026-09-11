# Build

Documentation for people changing the platform, rather than running it. If you are setting the
product up, start at [Get started](../get-started/index.md) instead.

## What is here

| Page | Answers |
| --- | --- |
| [Add a connector](connectors.md) | How do I teach the platform to read a system it does not support yet? |
| [Keeping the docs true](documentation.md) | How does this guide avoid drifting away from the code? |
| [Model-facing encoding](model-encoding.md) | How is tool output encoded for the investigator, and what must not change? |

## The shape of the repository

One monorepo, split into applications that run and packages they share.

--8<-- "_generated/workspaces.md"

That table is generated from the workspace tree, so it cannot fall behind a rename.

## Getting it running

```
bun install
bun run dev:setup   # containers, health checks, migrations
bun run dev         # every application's watcher
```

`dev:setup` brings up PostgreSQL and Valkey and applies migrations. `dev` runs the watchers.
[Install locally](../get-started/local-development.md) covers the same ground in more detail,
including what to do when a long-lived local database has fallen behind.

## What has to pass

Both CI providers run the same scripts, so there is one list, not two.

--8<-- "_generated/ci-gates.md"

Two of those deserve a note before you hit them for the first time.

**Tests need Docker, not a running stack.** The suite boots its own PostgreSQL and Valkey through
Testcontainers, migrates once, and tears them down. It never touches your development database, and
it must never be pointed at shared infrastructure.

**Tenant isolation tests block merge.** Every domain table carries a tenant, and the database
enforces it rather than the application. A change that reaches domain data without that scoping is
a cross-tenant leak, not a style problem.

## The rules that are not negotiable

These hold everywhere, and a change that breaks one is rejected regardless of what it enables.

| Rule | Why |
| --- | --- |
| Every domain table is tenant-scoped, enforced by the database | A gap is a cross-tenant data leak |
| PostgreSQL is the durable source of truth, queues are delivery | Work survives a queue that loses a message |
| One model provider per deployment, no cross-provider fallback | Silent failover means silently different behaviour |
| Connectors are read-only, without exception | The product promises it on every page |
| No new datastore without a recorded decision | PostgreSQL and Valkey are the only two |
| Secrets are encrypted at rest and never returned | Credentials are write-only, everywhere |
