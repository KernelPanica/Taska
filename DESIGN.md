# Taska Design System

> Dark, tactile, Material-like interface based on the visual principles of TypeUI Essential.

## 1. Design direction

Taska is a dense project-management application, but it must not feel like an accounting table. The interface should be calm, tactile and immediately readable even when a board contains many cards.

The visual foundation adapts **TypeUI Essential**:

- direct layouts and obvious actions;
- pill-shaped interactive controls;
- large rounded cards;
- one vivid blue primary accent;
- soft layered depth;
- clear hierarchy between the canvas, navigation, boards, cards and overlays.

Taska changes Essential in three deliberate ways:

1. Dark theme is the default and primary theme.
2. Elevation, state layers and motion follow Material-like interaction principles.
3. Density is increased for kanban boards, tables and issue metadata without reducing touch targets or readability.

“Material-like” means familiar depth, state layers, motion and responsive behavior. It does **not** mean copying Material components pixel for pixel.

## 2. Product design principles

### 2.1 Content first

Task title, status, assignee and due date are more important than decoration. Every visual element must help users understand state or perform an action.

### 2.2 One obvious primary action

Each screen has at most one visually dominant action:

- board — `Create issue`;
- issue drawer — `Save` only when autosave is unavailable;
- project settings — `Save changes`;
- import — `Start import`.

Secondary actions use tonal, outlined or text treatments.

### 2.3 Depth describes structure

Elevation is functional:

- canvas sits at level 0;
- navigation and board columns sit at level 1;
- cards sit at level 2;
- dragged cards and floating controls rise to level 3;
- menus, drawers and dialogs sit at levels 4–5.

Do not add shadows simply to make an element look “premium.”

### 2.4 Motion explains change

Animations show origin, destination, hierarchy and causality. They must not delay work or play decoratively while nothing changes.

### 2.5 Dense, not cramped

Desktop views can display substantial information, but interactive targets remain at least 40×40 px and important controls 44×44 px.

### 2.6 Color communicates meaning

Primary blue is reserved for actions, focus and selection. Semantic colors communicate status, warnings and errors. Issue types and labels may use additional colors, but the surrounding UI stays neutral.

---

## 3. Theme architecture

Components must use semantic tokens only. Do not place raw hex colors, arbitrary radii, shadows or durations inside component styles.

```css
:root,
[data-theme="dark"] {
  color-scheme: dark;

  /* Canvas and surfaces */
  --color-canvas: #0c0e12;
  --color-surface-0: #11141a;
  --color-surface-1: #171a21;
  --color-surface-2: #1d212a;
  --color-surface-3: #242936;
  --color-surface-inverse: #edf1f8;

  /* Content */
  --color-text-primary: #edf1f8;
  --color-text-secondary: #b7bfcc;
  --color-text-tertiary: #858e9d;
  --color-text-disabled: #626a77;
  --color-text-inverse: #12151a;

  /* Borders and state layers */
  --color-border-subtle: #292e38;
  --color-border-default: #353b47;
  --color-border-strong: #4a5261;
  --color-hover-layer: rgb(255 255 255 / 0.06);
  --color-pressed-layer: rgb(255 255 255 / 0.10);
  --color-selected-layer: rgb(91 141 255 / 0.14);
  --color-drag-layer: rgb(91 141 255 / 0.20);

  /* Brand */
  --color-primary: #78a2ff;
  --color-primary-hover: #8eafff;
  --color-primary-pressed: #668fe9;
  --color-primary-container: #23385f;
  --color-on-primary: #071225;
  --color-on-primary-container: #d9e5ff;
  --color-focus-ring: #9cb9ff;

  /* Semantic */
  --color-success: #63d297;
  --color-success-container: #153d2a;
  --color-warning: #f2bd5b;
  --color-warning-container: #483414;
  --color-danger: #ff8a8a;
  --color-danger-container: #562424;
  --color-info: #74c7ec;
  --color-info-container: #183c4e;

  /* Scrims */
  --color-scrim: rgb(0 0 0 / 0.64);
  --color-scrim-soft: rgb(0 0 0 / 0.36);
}
```

### 3.1 Surface rules

| Token | Usage |
|---|---|
| `canvas` | Application background behind all navigation and workspaces |
| `surface-0` | Sidebar, top bar and persistent navigation |
| `surface-1` | Board columns, table shells and settings sections |
| `surface-2` | Issue cards, inputs, selected navigation groups |
| `surface-3` | Hovered/raised cards, menus, popovers and nested panels |
| `surface-inverse` | Rare inverse tooltip or high-contrast callout |

Avoid pure black for large surfaces and pure white for body text. Slightly tinted neutrals reduce glare and preserve depth.

### 3.2 Optional light theme

Light theme may be added later, but no component may assume a dark background. All components must consume the semantic tokens above so a second token set can be introduced without rewriting component CSS.

### 3.3 User theme setting

Support three modes when light theme exists:

- `Dark`;
- `Light`;
- `System`.

Until then, expose only `Dark` and do not ship a broken theme toggle.

---

## 4. Typography

Use a variable sans-serif with clear Cyrillic support. Preferred stack:

```css
--font-sans: "Inter Variable", Inter, Roboto, system-ui, -apple-system,
  "Segoe UI", sans-serif;
--font-mono: "JetBrains Mono Variable", "JetBrains Mono", ui-monospace,
  monospace;
```

Use monospace only for issue IDs, code fragments, timestamps in audit views and technical values.

| Role | Size / line-height | Weight | Usage |
|---|---:|---:|---|
| Display | 32 / 40 px | 650 | Rare empty-state or onboarding headline |
| Page title | 24 / 32 px | 650 | Project and settings titles |
| Section title | 20 / 28 px | 600 | Dialog and drawer sections |
| Card title | 15 / 21 px | 550 | Issue titles |
| Body | 14 / 20 px | 400 | Main interface text |
| Label | 13 / 18 px | 550 | Field labels, tabs and buttons |
| Metadata | 12 / 16 px | 500 | IDs, dates and counters |

Rules:

- never use font sizes below 12 px;
- avoid uppercase sentences; uppercase is allowed only for short technical IDs;
- card titles may occupy at most three lines on a board;
- truncation must provide the complete value in an accessible tooltip;
- line length in long descriptions should stay near 70–80 characters.

---

## 5. Spacing, shape and layout

### 5.1 Spacing scale

Use a 4 px base grid:

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-10: 40px;
--space-12: 48px;
--space-16: 64px;
```

### 5.2 Radius scale

Essential's tactile rounded geometry is retained:

```css
--radius-xs: 6px;
--radius-sm: 10px;
--radius-md: 14px;
--radius-lg: 20px;
--radius-xl: 28px;
--radius-pill: 999px;
```

Usage:

- tags and status chips: pill;
- buttons and compact inputs: pill or 14 px depending on width;
- multiline inputs: 14 px;
- issue cards and board columns: 20 px;
- dialogs and drawers: 28 px on free corners;
- nested cards must not use a larger radius than their parent.

### 5.3 Application shell

Desktop:

- left navigation: 248 px expanded, 72 px collapsed;
- top app bar: 64 px;
- content gutters: 24 px;
- board column width: 320 px default, 280–400 px allowed;
- issue drawer: `min(720px, 92vw)`;
- maximum settings/form width: 760 px.

Tablet:

- collapsed navigation rail: 72 px;
- issue drawer uses 80–92% width;
- board remains horizontally scrollable.

Mobile:

- bottom navigation for top-level destinations;
- top bar: 56 px;
- content gutter: 12 px;
- board shows one nearly full-width column at a time with horizontal snap;
- issue details open as a full-screen sheet;
- drag-and-drop is supplemented by an explicit `Move to…` action.

---

## 6. Elevation and shadows

Dark surfaces need borders and tonal separation in addition to shadow.

```css
--elevation-0: none;
--elevation-1:
  0 1px 2px rgb(0 0 0 / 0.32),
  0 0 0 1px rgb(255 255 255 / 0.025);
--elevation-2:
  0 4px 12px rgb(0 0 0 / 0.34),
  0 1px 2px rgb(0 0 0 / 0.28),
  0 0 0 1px rgb(255 255 255 / 0.035);
--elevation-3:
  0 12px 28px rgb(0 0 0 / 0.42),
  0 3px 8px rgb(0 0 0 / 0.30),
  0 0 0 1px rgb(120 162 255 / 0.16);
--elevation-4:
  0 20px 48px rgb(0 0 0 / 0.52),
  0 6px 16px rgb(0 0 0 / 0.34),
  0 0 0 1px rgb(255 255 255 / 0.06);
```

Never stack several high-elevation surfaces unnecessarily. A card inside an open drawer normally returns to elevation 0–1 because the drawer already establishes context.

---

## 7. Motion system

### 7.1 Motion principles

- Fast interactions feel immediate.
- Larger surfaces move more slowly than small controls.
- Entering content decelerates; exiting content accelerates.
- Spatial transitions preserve the apparent origin of the element.
- No essential information exists only during animation.
- Layout motion uses transform and opacity where possible.

### 7.2 Motion tokens

```css
--duration-instant: 80ms;
--duration-fast: 140ms;
--duration-medium: 220ms;
--duration-slow: 320ms;
--duration-emphasized: 420ms;

--ease-standard: cubic-bezier(0.2, 0, 0, 1);
--ease-enter: cubic-bezier(0.05, 0.7, 0.1, 1);
--ease-exit: cubic-bezier(0.3, 0, 0.8, 0.15);
--ease-emphasized: cubic-bezier(0.2, 0, 0, 1.2);
```

Do not use spring overshoot for routine navigation. A restrained spring is allowed for drag release and successful drop only.

### 7.3 Interaction matrix

| Interaction | Duration | Properties | Behavior |
|---|---:|---|---|
| Button hover | 140 ms | background, color, shadow | Add state layer; no scale on ordinary hover |
| Button press | 80 ms | transform, state layer | Scale to 0.98, restore on release |
| Tooltip | 140 ms | opacity, translateY | Fade and move 4 px |
| Menu/popover | 180–220 ms | opacity, scale | Scale 0.96→1 from trigger origin |
| Drawer open | 320 ms | transform, scrim opacity | Slide from right; content stays stable |
| Drawer close | 220 ms | transform, scrim opacity | Faster exit |
| Dialog open | 220 ms | opacity, scale | Scale 0.96→1; fade scrim |
| Card hover | 140 ms | surface, border, shadow | Raise one level; translateY no more than −1 px |
| Card drag start | 140 ms | scale, rotate, shadow | Scale 1.02; max rotation 0.5° |
| Card reorder | 220 ms | transform | Other cards make room using FLIP/layout animation |
| Successful drop | 220 ms | transform, shadow | Settle without bounce greater than 2 px |
| Tab change | 220 ms | indicator transform | Indicator glides; content crossfades |
| Toast enter | 320 ms | opacity, translateY | Move 12 px into view |
| Skeleton pulse | 1.4 s | opacity/gradient position | Subtle loop; never flash |
| Status change | 220 ms | container color, icon | Crossfade label and animate indicator |

### 7.4 Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
  }
}
```

The product must remain understandable with all nonessential motion disabled. Progress indicators may continue only when necessary to communicate an ongoing operation.

### 7.5 Performance

- animate `transform` and `opacity` first;
- do not animate large-area blur during board scrolling;
- do not animate width/height continuously during drag;
- virtualized lists must not replay entrance animation during normal scrolling;
- target 60 fps on a typical integrated-GPU laptop;
- never block user input until an animation ends.

---

## 8. Component rules

Every interactive component must define:

- default;
- hover;
- focus-visible;
- active/pressed;
- selected;
- disabled;
- loading when applicable;
- validation/error when applicable.

### 8.1 Buttons

Heights:

- compact: 32 px, toolbars only;
- default: 40 px;
- prominent: 48 px.

Variants:

| Variant | Treatment | Usage |
|---|---|---|
| Filled | Primary fill, on-primary text | One primary action per region |
| Tonal | Primary container | Important secondary action |
| Outlined | Transparent with border | Neutral alternate action |
| Text | Transparent | Inline or low-emphasis action |
| Danger | Danger container; stronger treatment on confirmation | Destructive action only |
| Icon | Circular or rounded square | Recognizable action with tooltip |

Loading buttons retain width, show a small spinner and use `aria-busy="true"`.

### 8.2 Inputs

- visible label is mandatory;
- placeholders are examples, not labels;
- default height: 44 px;
- background: `surface-2`;
- border: subtle by default, focus ring on keyboard focus;
- error state combines color, icon and message;
- multiline Markdown editor uses 14 px radius, not a pill;
- autosaved fields show a subtle saved/error status without success toasts after every keystroke.

### 8.3 Chips and tags

- use pill shape;
- minimum height 28 px;
- selected/filter chips receive a filled tonal surface;
- removable chips have a dedicated 28×28 px remove target;
- labels may carry custom colors, but text contrast must remain AA;
- statuses always pair color with text or icon.

### 8.4 Menus and popovers

- minimum width 200 px;
- maximum height uses internal scrolling;
- selected item includes a checkmark;
- dangerous actions are separated and placed last;
- opening focus moves to the logical first/selected item;
- Escape closes and returns focus to the trigger.

### 8.5 Dialogs

Use a modal only for short, blocking decisions. Editing a full issue belongs in a drawer or page.

- small: 400–480 px;
- default: 560–640 px;
- destructive confirmation names the affected entity and consequence;
- focus is trapped while open and restored when closed;
- clicking the scrim must not close a destructive confirmation accidentally.

### 8.6 Drawers and sheets

The issue detail opens from the right on desktop and full-screen on mobile.

- use a shared-element cue from selected card to drawer when performance allows;
- keep issue ID, title and status visible in the sticky header;
- allow deep linking directly to the open issue;
- browser Back closes the drawer before leaving the board;
- unsaved destructive changes require confirmation.

### 8.7 Toasts

- bottom-right on desktop, bottom-center above navigation on mobile;
- maximum three visible;
- auto-dismiss only informational/success messages;
- errors persist until dismissed or resolved;
- undoable actions include an `Undo` button and remain visible long enough to act.

### 8.8 Skeletons and loading

- preserve the final layout to prevent jumping;
- use skeletons for first load and progress indicators for explicit actions;
- after roughly 8 seconds, replace indefinite loading with useful recovery copy;
- never show an empty board before loading completes.

---

## 9. Taska-specific patterns

### 9.1 Application navigation

Expanded sidebar structure:

1. Workspace switcher.
2. Search / command palette.
3. Primary navigation: My work, Projects, Boards, Roadmap, Dashboards.
4. Current project navigation.
5. Settings and user profile.

The active destination uses a tonal primary container, not a bright filled blue block. Collapsed icons always have tooltips.

### 9.2 Board toolbar

Order from left to right:

- board title and project context;
- saved view/filter name;
- search;
- filters;
- group/swimlane control;
- display density;
- overflow menu;
- `Create issue` as the primary action.

Active filters appear in a removable chip row. The toolbar becomes horizontally scrollable or collapses secondary actions on narrow screens.

### 9.3 Board columns

- `surface-1`, 20 px radius;
- sticky column header;
- status icon, status name, issue count and overflow action;
- subtle category indicator for queue/active/done;
- drop target becomes visible only during drag;
- empty columns keep a clear minimum drop area;
- horizontal board scrolling must not fight vertical card scrolling.

### 9.4 Issue cards

An issue card is one large interactive target. Nested controls stop propagation but remain keyboard accessible.

Content order:

1. issue type icon + monospace ID;
2. title;
3. tags, maximum two plus `+N` overflow;
4. due date / overdue state;
5. assignee avatars;
6. optional estimate, attachment, comment and dependency indicators.

Rules:

- default surface: `surface-2` with elevation 1;
- hover: `surface-3`, elevation 2;
- keyboard focus: 2 px focus ring with 2 px offset;
- selected/open: primary border and selected state layer;
- overdue date: danger color plus warning icon, never color alone;
- avoid permanent kebab menus on every card; reveal on hover/focus but keep keyboard access;
- dragging is available from noninteractive card areas;
- touch devices also provide `Move to…`.

### 9.5 Issue detail

Header:

- breadcrumb/project;
- issue ID;
- editable title;
- type selector;
- status selector;
- copy link and overflow actions.

Main column:

- Markdown description;
- child issues/checklist when applicable;
- attachments;
- tabs for comments and activity.

Metadata rail:

- assignees;
- customer;
- watchers;
- priority;
- estimate;
- start and due dates;
- labels;
- parent and relations.

Below 900 px, the metadata rail becomes collapsible sections in the main flow.

### 9.6 Status selector

- shows status name and its queue/active/done category;
- uses a colored dot or icon plus text;
- opens as a searchable popover when status lists are long;
- status changes optimistically, but roll back visibly if the server rejects them;
- successful routine changes do not produce noisy success toasts.

### 9.7 People picker

- searchable combobox;
- avatars, display name and secondary email;
- selected users appear as chips;
- `Assign to me` is the first quick action where relevant;
- groups and individual users are visually distinguishable;
- a person can occupy multiple roles without an error.

### 9.8 Relations and hierarchy

- relation rows display relation type, issue ID, title, status, project and assignee;
- changing relation type happens inline;
- hierarchy uses indentation and connecting guides, not color alone;
- circular parent selection is prevented before submission with a clear explanation;
- collapsed branches retain a child count.

### 9.9 Activity timeline

- chronological vertical timeline;
- actor avatar, action summary and time are immediately scannable;
- old/new values are visually distinct;
- consecutive events by the same actor may be grouped without hiding individual timestamps;
- technical metadata is available on demand, not shown by default.

### 9.10 Filters and command palette

`Ctrl/Cmd + K` opens global search and commands.

Search supports:

- issue ID;
- title;
- project;
- person;
- saved board or filter;
- navigation commands.

Filter construction should be visual first. A textual query language may be added later but cannot be required for normal use.

### 9.11 Gantt/roadmap

- task rows use the same selection and hover states as tables;
- timeline bars use primary/semantic containers rather than neon fills;
- parent bars are visually heavier than child bars;
- dependencies use thin high-contrast paths and clear arrowheads;
- dragging a bar updates dates with a preview before commit;
- conflicts and overdue states use icon + text in addition to color;
- zoom changes animate only the viewport transformation, not every row independently.

### 9.12 Dashboards

- one key number per metric card;
- charts use a restrained categorical palette;
- default chart accent is primary blue;
- tooltips show exact values and definitions;
- lead time, cycle time and percentiles include plain-language definitions;
- charts must have a table or accessible text equivalent.

---

## 10. Feedback states

Every data view must implement four explicit states.

### Loading

Skeletons match the final structure. Do not show centered spinners on an otherwise empty full page.

### Empty

Explain what is absent and provide one relevant action. Example:

> No issues in this status. Drag an issue here or create a new one.

### Error

Explain what failed, whether data was saved, and what the user can do. Preserve user input whenever possible.

### Partial/stale

If cached data is displayed while refresh fails, mark it as potentially outdated and provide `Retry`. Do not replace useful cached data with a blank error screen.

---

## 11. Accessibility

Target WCAG 2.2 AA.

- regular text contrast: at least 4.5:1;
- large text and meaningful UI graphics: at least 3:1;
- visible `:focus-visible` on every interactive element;
- complete keyboard operation for board, menus, dialogs and drawers;
- drag-and-drop always has a non-drag alternative;
- icon-only controls have accessible names and visible tooltips;
- color is never the only status indicator;
- headings and landmarks follow semantic order;
- errors are connected to their fields programmatically;
- toast announcements use appropriate live regions without interrupting typing;
- modals trap focus and restore it on close;
- touch targets are at least 40×40 px, preferably 44×44 px;
- `prefers-reduced-motion` is respected;
- zoom to 200% does not hide required actions;
- board content remains usable without horizontal precision pointing.

### Keyboard model for board

- `Tab`: move through toolbar, columns and interactive card controls;
- arrow keys: move between cards when a card has roving focus;
- `Enter`: open focused issue;
- `Space`: pick up/drop a card in keyboard drag mode;
- arrow keys while picked up: choose target column and position;
- `Escape`: cancel drag or close the topmost overlay;
- screen readers receive announcements for pickup, movement, valid target and drop result.

---

## 12. Responsive behavior

| Width | Navigation | Board | Issue detail |
|---|---|---|---|
| ≥1280 px | Expanded sidebar | Multi-column free scroll | Right drawer, up to 720 px |
| 768–1279 px | Navigation rail | Multi-column horizontal scroll | Wide drawer/sheet |
| <768 px | Bottom navigation + menu | One-column snap view | Full-screen sheet |

Do not simply scale the desktop layout down. On mobile:

- secondary metadata collapses into sections;
- filters open in a bottom sheet;
- toolbar actions move into an overflow menu;
- drag is optional, explicit move actions are primary;
- dense tables become lists with prioritized fields.

---

## 13. Iconography and imagery

- use one rounded outlined icon family throughout the product;
- standard icon size: 20 px; compact metadata: 16 px; large empty state: 32 px;
- use filled variants only for selected navigation or strongly active state;
- do not mix emoji with interface icons;
- illustrations are optional and should not dominate work screens;
- avatars may use photos or deterministic initials with stable background colors.

---

## 14. Content style

- labels are short and action-oriented;
- button text describes the result: `Create issue`, not `Submit`;
- destructive confirmations name the target;
- error messages state what happened and how to recover;
- do not blame the user;
- issue terminology must be consistent across cards, dialogs, imports and help text;
- avoid exposing implementation language such as database IDs or HTTP errors.

Russian UI examples:

- `Создать задачу`;
- `Назначить на себя`;
- `Переместить в…`;
- `Не удалось сохранить изменения. Проверьте соединение и повторите попытку.`;
- `Удалить TASKA-123? Задача исчезнет с досок, но событие останется в журнале аудита.`

---

## 15. Implementation constraints

- use CSS custom properties for all tokens;
- theme is applied using `data-theme` on the root element;
- components consume semantic tokens, not palette primitives;
- state layers use pseudo-elements when possible to avoid layout shift;
- transitions are disabled until the application has hydrated to prevent first-load flashes;
- use native HTML controls where they satisfy behavior and accessibility;
- custom selects, comboboxes and drag systems require keyboard and screen-reader tests;
- do not introduce a large UI framework solely to recreate the tokens in this file;
- charts and virtualization libraries must support dark theme and accessible output.

Recommended component anatomy:

```text
Component
├── semantic markup
├── base style using tokens
├── hover/focus/active/disabled states
├── loading/error/empty state when relevant
├── responsive behavior
├── reduced-motion behavior
└── interaction and accessibility tests
```

---

## 16. Design QA checklist

A screen is ready only when all applicable checks pass.

### Visual

- [ ] Only semantic color tokens are used.
- [ ] Surface hierarchy is visible without excessive borders.
- [ ] Primary blue is not scattered across noninteractive decoration.
- [ ] Radii follow the defined scale.
- [ ] Shadows correspond to actual elevation.
- [ ] Text hierarchy remains readable at a glance.
- [ ] Long Russian text and long issue titles do not break layout.

### Interaction

- [ ] Hover, focus-visible, active, selected and disabled states exist.
- [ ] Loading does not resize controls.
- [ ] Motion follows the token durations and easing.
- [ ] Animations do not block repeated actions.
- [ ] Drag-and-drop has a keyboard/touch alternative.
- [ ] Optimistic updates visibly recover from errors.

### Responsive

- [ ] Works at 360, 768, 1280 and 1920 px widths.
- [ ] No required action is hidden by overflow.
- [ ] Drawers and dialogs fit the viewport.
- [ ] Board remains usable with mouse, touch and keyboard.

### Accessibility

- [ ] Contrast meets WCAG 2.2 AA.
- [ ] Keyboard-only flow is complete.
- [ ] Focus is visible and restored after overlays.
- [ ] Screen-reader names and announcements are meaningful.
- [ ] Status is not represented by color alone.
- [ ] Reduced-motion mode is functional.

### Product states

- [ ] Loading state exists.
- [ ] Empty state exists.
- [ ] Error and retry state exists.
- [ ] Partial/stale data state exists where caching is used.
- [ ] Permission-denied state explains what is unavailable.

---

## 17. Definition of done for the first design implementation

The initial design system implementation is complete when:

1. Tokens for color, type, spacing, radius, elevation and motion exist in code.
2. Dark theme is applied without flashes of a light canvas.
3. Buttons, inputs, chips, menus, dialogs, drawers, toasts and skeletons implement all states.
4. Application shell, board column, issue card and issue detail follow this specification.
5. A card can be moved with mouse, touch fallback and keyboard.
6. Reduced-motion behavior is tested.
7. Contrast and keyboard navigation pass an automated audit plus manual review.
8. The board stays responsive and animation remains smooth with at least 100 visible cards.

## Reference

- TypeUI Essential: <https://www.typeui.sh/design-skills/essential>
