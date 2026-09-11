# Operate

Running the platform: who may sign in, which model it uses, what it may spend, and how it is
deployed.

For the day-to-day screens, see [Dashboard](../dashboard/index.md).

Installing for the first time? Read the first three pages in order: what the image needs before it
starts, how to register the first sign-in method and administrators, then how sign-in is configured.

| Page | Covers |
| --- | --- |
| [Container image](container.md) | What each process needs before it starts, the two database connections, and the order to run them |
| [First-run bootstrap](bootstrap.md) | Registering the first installation sign-in method and the first platform administrators |
| [Authentication](auth.md) | Signing in, and who is allowed to |
| [Triage engine](triage.md) | Choosing the model, capping what it may spend, and reading what it cost |
| [Platform settings](settings.md) | Every tunable value, its range, and when a change takes effect |
| [Slack](slack.md) | What to expect from Slack once it is connected |
| [Network policy](network-policy.md) | Which addresses the platform may reach, and which it refuses |

## Two boundaries worth knowing before you deploy

**Organisations cannot see each other.** Every record carries the organisation that owns it, and the
database enforces the separation rather than the application remembering to. Two organisations on
one deployment share infrastructure and nothing else.

**Credentials never leave in plaintext.** Connector and Slack credentials are encrypted at rest and
decrypted only at the moment of use. Nothing displays them back, and nothing writes them to a log.
