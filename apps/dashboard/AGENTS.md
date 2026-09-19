# Dashboard design contract

Read `../../docs/build/design-system.md` before changing this dashboard. It is the design
contract, not optional inspiration. `src/index.css` owns tokens and shared control styles.

- Use semantic colour utilities. Do not add raw colours, Tailwind colour palettes, external
  fonts, decorative shadows, or page-specific token overrides.
- Buttons, selectors, fields, and navigation controls use 4px corners. Cards and dialogs use
  at most 8px. Never introduce pill-shaped controls. Status badges and circular avatars are
  not action controls.
- Use `sre-action`, `sre-action-primary`, `sre-action-danger`, and `sre-field` for their documented
  roles. Preserve native semantics. Do not override their shape, padding, or disabled states.
- Reuse PageHeader, Layout, SetupDialog, SetupActions, and SegmentedTabs. Do not build a second
  dialog shell, navigation shell, or palette for a feature.
- Keep status colours and text labels meaningful. Do not turn map nodes, table rows, or tabs
  into primary action buttons merely to reuse a class.
- Preserve keyboard focus, dialog focus return, drafts, and scroll position. Check both themes
  and desktop, tablet, and mobile widths. Browser emulation is not physical-device proof.

Run `bun run check:design-system` from the repository root. It runs in the normal UI test lane
too. Do not weaken the guard to accommodate a one-off design. Change the shared system and
its documented contract together if the user approves a new design decision.

For shared visual changes, also run `bun run test:modal-layout`, the relevant feature browser
checks, and `bun scripts/docs/screenshots/capture.ts`. The full capture must succeed before
replacing screenshots. Never capture customer data for documentation.
