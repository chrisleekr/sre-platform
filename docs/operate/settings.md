# Platform settings

Platform settings are global, not per workspace. A platform operator changes them from the dashboard
under **Platform administration** → **Platform settings**, and every process picks the new value up
without a restart.

This page is the single description of how a setting resolves. Pages that mention an individual
setting link here rather than restating the rules.

## Who can change them

Reading or changing settings requires the platform-administrator permission described in
[Authentication](auth.md). Settings are installation-wide and can contain operational policy that
an unaffiliated tenant member must not inspect.

The deploy-time [bootstrap task](bootstrap.md) can grant a known provider subject immediately or
create an email invitation. A matching trusted email claim accepts that invitation on the next
sign-in. Both paths use the administrative database connection; the application database connection
cannot grant itself access. The development-only password login is the sole exception: when
explicitly armed outside production, it grants its single local account administrator access.

The settings table is global rather than per workspace, and the application database connection has no
privileges on it at all. Every write goes through the API's administrator connection.

## When a change takes effect

A saved setting normally applies to the very next piece of work. Every process is told about the
change as it happens, and even if that notification is missed the value is re-read within 30 seconds.
Nothing needs restarting.

A save that succeeds stays saved. The cache in front of it can be unavailable without losing the
change.

## Settings and their fallbacks

Until you save a value, a setting falls back to the environment variable set for the deployment, and
failing that to the built-in default below.

The general numeric settings ignore an unreadable environment value and use their default. The
automatic-investigation spending limits do the opposite: an unreadable value stops the platform from
starting, so a malformed budget can never become an unenforced one.

--8<-- "_generated/platform-settings.md"

## Notification email

Every notification is written to the recipient's in-app inbox first. Email is an optional secondary
copy. With email disabled, the inbox still works and no delivery error is recorded.

Configure the SMTP host, port, sender email, TLS mode and optional username in **Platform
administration** → **Platform settings** → **Notification email**. A username requires a password. The
password is encrypted separately from the setting, is write-only, and is never returned to the
browser. Use **Send test email** to deliver a
plain-text test to the signed-in platform operator's verified email address. A rejected test displays
the SMTP adapter's error so the operator can correct the endpoint or credentials.

Before an operator saves a value, the non-secret fields can fall back to `SMTP_HOST`, `SMTP_PORT`,
`SMTP_SECURE`, `SMTP_FROM` and `SMTP_USERNAME`. All required fields must be present and valid when any
of them is set. Add the password from the Platform settings screen after sign-in. A saved disabled state
overrides the environment fallback without affecting in-app delivery.

Registration mode, product name, public value line, and the terms, privacy, and support URLs live in
the same administration section. `/public-config` reads the current values, so a successful save is
visible on the next public request without an API restart.
