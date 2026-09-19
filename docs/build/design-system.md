# Dashboard design system

The interface is a quiet control surface. Neutral backgrounds and outlined actions keep attention
on operational evidence. Colour identifies severity, health, and chart series, not decoration.

## Foundations

| Role | Dark | Light |
| --- | --- | --- |
| Canvas | `#08090a` | `#f7f8f8` |
| Surface | `rgb(20 21 22)` | `#ffffff` |
| Nested surface | `#1c1c1f` | `#f0f0f2` |
| Raised surface | `#23252a` | `#e4e5e9` |
| Main text | `#f7f8f8` | `rgb(20 21 22)` |
| Muted text | `#a0a4ad` | `#62666d` |

Use semantic utilities such as `bg-surface`, `text-ink-muted`, and `border-line`. Do not add page-specific
hex colours. Light, dark, and system preference share the same roles.

Inter Variable is self-hosted for interface text. Headings use weight 510; emphasis uses 590.
IBM Plex Mono is reserved for commands, identifiers, and numeric instruments. Body text uses a
15px base and 1.5 line height. Keep dense metadata at 12px or above.

Spacing follows a 4px rhythm. Cards have at most 8px corners; buttons, selectors, and fields share 4px corners. Separate
layers with borders and surface tones, not drop shadows. Keep existing responsive data layouts;
do not constrain maps or evidence to a narrow reading column.

## Controls

Use the shared action and field styles on native elements. Keep their labels, validation,
disabled states, and event handlers in the owning feature.

```html
<button class="sre-action sre-action-primary">Save connection</button>
<button class="sre-action">Cancel</button>
<button class="sre-action sre-action-danger">Disconnect</button>
<button class="sre-action" disabled>Saving…</button>
<label>
  Connection name
  <input class="sre-field mt-1 w-full" />
</label>
```

Primary actions use a strong outline. Secondary actions use a quieter outline. Destructive
actions keep a red outline and an explicit verb. Use one primary action per task. Text-only
actions stay understated; table rows, map nodes, and tabs are not action buttons.

Apply width and placement utilities where needed. Do not repeat background, radius, padding,
or disabled styling beside the shared action classes. Dialogs use the shared dialog shell,
with fixed navigation and actions around one scrolling content area.

## Accessibility and validation

Keep the shared two-colour keyboard focus ring and text labels for statuses. Its contrasting
halo stays visible on dark conversation bubbles in either theme; it is not decorative elevation.
Shared actions are at least
36px tall and grow to 44px on coarse pointers. Touch form fields use 16px text. These choices
preserve usability rather than reproducing a marketing-page reference literally.

Token tests check normal text at 4.5:1 contrast and focus/control boundaries at 3:1. They do not
replace checking composed pages. Review light and dark themes at desktop, tablet, and mobile
sizes; check keyboard focus, wrapping, errors, disabled controls, and long content.

The [contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html),
[visible focus](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html), and
[target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) guidance explains
the accessibility constraints. The focus ring follows the
[two-colour technique](https://www.w3.org/WAI/WCAG22/Techniques/css/C40).
Regenerate the [documentation screenshots](documentation.md)
after changing shared styles.

## Required development checks

Run `bun run check:design-system` before submitting a UI change. These tests also run in the
required UI CI lane. They protect colour contrast, palette parity, typography weights, the
4px control radius, and the 8px card radius.
The screenshot inventory must match the full capture registry, with no missing, duplicate,
or obsolete images. This checks completeness, not whether an image is visually current.
Capture open dialogs at their real viewport size. Do not expand them or remove their scroll limits
for documentation.

The source policy rejects raw colour literals, default Tailwind colour palettes, decorative
shadows, control radii larger than 4px, hidden control focus, and overrides of shared action styling. It
checks static JSX classes, template branches, top-level class constants, and literal inline
colours. Runtime-generated styles still require review; a source check cannot prove accessibility.

Use this component map before creating anything new:

| Need | Use |
| --- | --- |
| Page title and actions | `PageHeader` |
| Workspace navigation | `Layout` |
| Modal, wizard, or evidence inspector | `SetupDialog` and `SetupActions` |
| In-page tabs | `SegmentedTabs` |
| Primary, secondary, or destructive action | Shared action classes |
| Form input, textarea, or select | `sre-field` |
| Loading or unavailable content | Existing loading and page-state components |

Layout utilities may control width, spacing between elements, and placement. Compact controls
may specify text size and a larger minimum height. Status badges, avatars, graph nodes, and
selected tabs have distinct roles; they are not substitutes for action controls. Toggle actions
may use `aria-pressed:bg-line` to distinguish their selected state. The skip link
has an opaque surface so underlying content cannot obscure it.

Before review:

1. Run the design checks and relevant feature tests.
2. For shared styles, run `bun run test:modal-layout` and the affected feature browser checks.
3. Inspect light and dark themes at desktop, tablet, and mobile widths, including keyboard focus,
   disabled and error states, long labels, and overflowing content.
4. Run `bun run docs:screenshots` for the full screenshot replacement. Never use
   a partial capture after a system-wide change. Inspect the resulting images before submitting.

New visual requirements belong in the shared tokens or controls and this contract together,
not a local override or a weakened test. Keep any exception explicit and obtain design approval.
