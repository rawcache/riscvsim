# StudyRISC-V Design System

## Design Goal

StudyRISC-V should feel like a premium technical learning product for computer architecture.

The product should look:
- precise
- fast
- dark-first
- technical
- polished
- calm
- modern
- trustworthy

The design should be inspired by Linear and Raycast, but not copied blindly. Use their principles:
- restrained visual hierarchy
- sharp typography
- compact spacing
- subtle gradients
- glassy elevated surfaces
- command-center feel
- buttery interactions
- excellent contrast
- no clutter

StudyRISC-V should not look like a generic AI-generated SaaS template.

## Brand Personality

StudyRISC-V is:
- a simulator
- a learning environment
- a debugging cockpit
- a curriculum
- a practice platform

It should feel closer to a professional developer tool than a school worksheet.

Keywords:
- architecture
- execution
- registers
- memory
- instruction flow
- precision
- inspection
- mastery

## Visual References

### Linear-inspired qualities

Use:
- deep dark backgrounds
- subtle radial gradients
- soft light bloom behind important areas
- clean card boundaries
- crisp typography
- restrained motion
- elegant page structure
- high signal-to-noise ratio

Avoid:
- oversized fake dashboard cards
- random marketing gradients
- weak contrast
- scattered spacing

### Raycast-inspired qualities

Use:
- compact command-center navigation
- glassy translucent surfaces
- strong keyboard/tooling feel
- tasteful purple-blue accent
- small status pills
- refined menus
- subtle hover lift
- dense but readable layouts

Avoid:
- enormous dropdowns
- cartoonish icons
- over-rounded components
- loud colors everywhere

## Core Palette

StudyRISC-V should use a dark navy/graphite base with a purplish-blue primary accent.

Raw values should only be defined in `tokens.css`. Other CSS files should use variables.

Recommended dark palette:

```css
--sr-bg-0: #070914;
--sr-bg-1: #0a0d1a;
--sr-bg-2: #101425;
--sr-bg-3: #171b2f;

--sr-surface-0: rgba(11, 14, 25, 0.72);
--sr-surface-1: rgba(17, 21, 36, 0.78);
--sr-surface-2: rgba(24, 29, 48, 0.86);

--sr-border-0: rgba(255, 255, 255, 0.08);
--sr-border-1: rgba(255, 255, 255, 0.13);
--sr-border-strong: rgba(178, 164, 255, 0.34);

--sr-text-0: #f4f2ff;
--sr-text-1: #d8d3ec;
--sr-text-2: #9f98ba;
--sr-text-3: #6f6888;

--sr-primary: #7468ff;
--sr-primary-strong: #8f7cff;
--sr-primary-soft: rgba(116, 104, 255, 0.18);
--sr-primary-glow: rgba(116, 104, 255, 0.38);

--sr-cyan: #28d7ff;
--sr-cyan-soft: rgba(40, 215, 255, 0.16);

--sr-green: #31e6a1;
--sr-yellow: #ffd166;
--sr-red: #ff6675;
```

If the existing tokens use names like `--accent`, map this palette into the existing token names instead of creating duplicate systems.

Primary color should be purplish-blue, not plain blue and not pink-purple.

Cyan should be used for:
- active execution
- register changes
- memory highlights
- technical status
- simulator feedback

Green should be used only for success.
Red should be used only for destructive or error states.
Yellow should be used only for warning or attention states.

## Light Mode

Light mode should work, but dark mode is the primary product experience.

Light mode should not become plain white with black borders. Use:
- warm off-white backgrounds
- very light lavender-gray surfaces
- purple-blue accents
- soft shadows
- readable dark text

Light mode should still feel premium.

## Typography

### UI and Marketing

Use Geist or the existing sans-serif stack.

Characteristics:
- clean
- modern
- high readability
- not playful
- not overly corporate

### Code and Labels

Use Geist Mono, JetBrains Mono, or the existing monospace stack.

Use monospace for:
- code editor
- assembly instructions
- register names
- addresses
- memory values
- compact metadata
- tabs where appropriate

Do not use monospace for every paragraph on marketing pages.

## Spacing

Use a compact but breathable system.

Recommended spacing scale:
- 4px
- 6px
- 8px
- 10px
- 12px
- 16px
- 20px
- 24px
- 32px
- 48px
- 64px
- 96px

Avoid:
- huge empty gaps with no purpose
- cards touching each other
- inconsistent left/right padding
- oversized nav/dropdowns
- sections that feel randomly spaced

## Radius

Use moderate rounding.

Recommended:
- Small controls: 8px to 10px
- Buttons: 10px to 14px
- Cards/panels: 16px to 22px
- Modals: 24px
- Navbar pill: 22px to 28px

Avoid:
- overly round bubbly shapes
- square harsh panels unless they are code/editor windows

## Shadows and Depth

Use depth sparingly.

Preferred:
- subtle border plus translucent surface
- faint inner highlight
- soft outer shadow
- background glow behind hero/product previews

Avoid:
- heavy black drop shadows
- cards floating randomly
- excessive layered boxes

Example direction:

```css
box-shadow:
  0 20px 80px rgba(0, 0, 0, 0.38),
  inset 0 1px 0 rgba(255, 255, 255, 0.06);
```

## Backgrounds

Dark pages should use:
- deep navy/graphite base
- subtle radial gradient near top center
- faint purple-blue glow
- optional fine grid/noise only if subtle

Avoid:
- plain black
- flat gray
- loud gradient blobs
- washed-out backgrounds

Suggested landing background:
- base `#070914`
- radial glow at top center using primary
- secondary cyan glow near product visual
- subtle dotted grid or thin lines at very low opacity

## Shared Navbar

The navbar is a central product element.

It should feel:
- Raycast-like
- compact
- glassy
- centered
- premium
- stable across pages

Requirements:
- Shared implementation through `frontend/src/nav.ts`.
- Logo/brand link goes to `/`.
- Simulator link goes to `/simulator/`.
- Practice/Problems link goes to `/problems/`.
- Learn link goes to `/learn/`.
- GitHub link goes to `https://github.com/rawcache/riscvsim`.
- Same horizontal position across pages.
- No page-specific navbar shifting.
- No duplicate navbars.
- No navbar hidden on problems/detail routes.

Desktop navbar:
- Centered max-width container.
- Height around 52px to 64px.
- Rounded pill container.
- Translucent dark surface.
- Thin glass border.
- Subtle shadow.
- Compact nav items.
- Active page gets small underline or soft pill.

Dropdowns:
- Compact, not oversized.
- Use a small grid or vertical list.
- Avoid giant three-column menus unless content justifies it.
- Max width should feel intentional.
- Use icons only if they improve scanning.
- Text labels must not wrap awkwardly.
- Dropdown should have glass surface, border, and soft shadow.

Mobile navbar:
- Use compact menu.
- No horizontal overflow.
- Keep primary routes visible or accessible.

## Landing Page Direction

The landing page should be the most polished page.

It should feel closer to Linear/Raycast:
- dark hero
- strong centered headline
- refined product visual
- compact CTA buttons
- animated or layered simulator preview
- crisp feature sections
- technical credibility

Avoid:
- light generic hero
- washed-out text
- huge gray blocks
- generic cards with icons
- bland AI SaaS layout
- fake screenshots that do not match the product

### Landing Structure

Recommended sections:

1. Navbar
2. Hero
3. Product preview
4. Feature strip
5. Simulator explanation section
6. Learning path / problems section
7. Final CTA
8. Footer

### Hero

Hero should include:
- small status pill: “Interactive RV32IM simulator”
- headline focused on execution visibility
- concise subheadline
- two CTAs: Launch Simulator, Start Learning
- product preview below

Example headline direction:

```text
See every RISC-V instruction move.
```

Subheadline direction:

```text
Write assembly, step through execution, inspect registers and memory, and learn architecture from the inside out.
```

### Product Preview

The product preview should look like a real simulator cockpit:
- code editor panel
- registers panel
- memory strip
- disassembly/effects panel
- current instruction highlight
- small status chips

It should not be a generic dashboard.

Use dark panels, crisp borders, purple-blue active line, cyan execution highlights.

### Feature Cards

Feature cards should be compact and specific:
- Step execution
- Register and memory inspection
- Guided curriculum
- Practice problems
- Browser-based WASM
- Progress tracking

Avoid generic claims like:
- Powerful
- Seamless
- Next-gen
- AI-powered, unless actually true

## Simulator Page Direction

The simulator should feel like a professional debugging cockpit.

Problems to avoid:
- hidden code until selected
- low contrast text
- too many panels fighting for attention
- huge empty spaces
- controls scattered everywhere
- inconsistent panel heights
- confusing active states

### Simulator Layout

Recommended desktop layout:
- Shared navbar at top
- Main app shell below
- Left panel: program input, examples, controls, warnings/breakpoints
- Center panel: editor/disassembly/effects/memory, depending on active view
- Right panel: registers and machine state
- Bottom/secondary panel: console, memory, call stack, execution log

The editor/code area should be central and readable.

Important:
- Assembly code must be visible by default.
- Text contrast must pass visual inspection.
- Current line highlight should be visible but not loud.
- Buttons should be compact and consistent.
- Assemble/Run/Step/Reset should be grouped logically.

### Simulator Controls

Primary actions:
- Assemble
- Step
- Run
- Reset

Visual hierarchy:
- Assemble: primary or strong neutral
- Step: neutral/primary secondary
- Run: positive/cyan
- Reset: danger/outline

Do not make every button bright.

### Registers Panel

Registers should be readable and compact.

Use:
- grouped register rows
- changed register highlight
- active/cyan flash
- hex/dec/unit tabs
- sticky or stable header
- clear PC display

Avoid:
- overly wide rows
- low contrast register values
- huge blank right side

## Problems Page Direction

Problems should feel like a LeetCode-style coding workspace, but branded for RISC-V.

Requirements:
- Shared navbar visible on `/problems/`.
- Shared navbar visible on `/problems/<slug>`.
- Two-pane workspace on desktop.
- Left pane: problem description, examples, constraints, hints/editorial/submissions tabs.
- Right pane: code editor and tests/output.
- Bottom action bar with Run and Submit.
- Good dark mode contrast.

Avoid:
- huge empty panes
- fake skeleton blocks left in final UI
- text that looks randomly positioned
- clipped labels
- generic cards

The problems page should be dense, useful, and precise.

## Learn / Curriculum Page Direction

The learn page should feel like a technical path through architecture.

Use:
- clear module hierarchy
- progress indicators
- cards that do not overlap
- clean readable lesson descriptions
- compact module metadata
- no clipped text
- no vertical cards so narrow that labels wrap badly

Avoid:
- broken timeline layouts
- huge footer overlapping content
- text squeezed into tiny cards
- module cards that look like placeholders

Recommended layout:
- left intro column
- right learning path grid/timeline
- module cards arranged in a readable flow
- progress shown as chips or thin bars

## Checkpoints Page Direction

The checkpoints page must not shift the navbar.

Use:
- stable scrollbar gutter
- no body-wide overflow lock that changes layout
- same nav width and x-position as other pages

## Auth Modal Direction

Auth should feel integrated with the product.

Use:
- dark glass modal
- readable labels and input text
- compact spacing
- clear error states
- Cloudflare/Turnstile area should not dominate the modal

Do not show raw developer error text prominently to normal users unless needed. If config is missing, show a concise friendly message and log technical detail where appropriate.

## Buttons

Button hierarchy:

Primary:
- purple-blue fill
- white text
- subtle glow on hover

Secondary:
- translucent surface
- border
- light text

Ghost:
- no fill
- hover surface

Danger:
- red text or red subtle background
- use sparingly

Buttons should:
- have clear hit targets
- not be oversized
- have consistent height
- use smooth hover/focus transitions

## Forms

Inputs:
- dark elevated surface
- clear border
- visible text
- visible placeholder
- purple-blue or cyan focus ring
- no invisible typed text

Labels:
- small but readable
- not too dim

## Tabs

Tabs should:
- be compact
- use clear active state
- avoid huge tab bars
- support keyboard/focus states

Active tab options:
- bottom border in primary color
- soft active pill
- text color shift

Do not use low-contrast inactive text that becomes unreadable.

## Motion

Motion should be subtle and fast.

Use:
- 120ms to 220ms transitions
- hover lift of 1px to 2px
- opacity/transform transitions
- gentle menu reveal

Avoid:
- bouncy animations
- slow transitions
- distracting shimmer
- constant motion

## Icons

Icons should:
- be minimal
- same stroke width
- same size within a region
- used to aid scanning

Avoid:
- random icon styles
- icons replacing necessary labels
- oversized icons in cards

## Copywriting

Tone:
- clear
- technical
- concise
- confident

Avoid:
- generic marketing fluff
- “revolutionary”
- “seamless”
- “unlock your potential”
- “next-gen”
- vague claims

Preferred wording:
- “Step through instructions”
- “Inspect register changes”
- “Trace memory writes”
- “Practice architecture problems”
- “Run RV32IM in the browser”

## Accessibility

Required:
- sufficient text contrast
- visible focus states
- keyboard-friendly controls
- no important content conveyed by color alone
- input labels should be clear
- interactive elements should have accessible names

## Responsive Behavior

At 768px:
- Stack major columns.
- Keep nav compact.
- Avoid horizontal overflow.
- Editor panels should remain usable.

At 480px:
- Reduce hero type size.
- Stack CTAs.
- Collapse simulator panels.
- Keep controls reachable.
- Avoid tiny unreadable code.

## Implementation Rules

When implementing the design:
- Use existing class names if TypeScript depends on them.
- Add wrapper classes only where needed.
- Prefer improving existing CSS over replacing large sections blindly.
- Keep changes scoped.
- Do not remove functionality to make layout easier.
- Do not hide broken components.
- Do not leave placeholder skeletons in production UI unless loading state requires them.
- Verify every changed route in browser or local server when possible.

## Page Quality Checklist

Before considering UI work complete, verify:

### All Pages
- Navbar appears correctly.
- No horizontal page shift.
- No hidden or low-contrast text.
- Light/dark mode works.
- Mobile does not overflow.
- GitHub link is correct.
- Build passes.

### Landing
- Hero looks premium and dark-first.
- Product preview reflects actual simulator.
- CTA buttons are clear.
- Feature cards are not generic.

### Simulator
- Code is visible without selecting text.
- Controls are grouped logically.
- Register values are readable.
- Memory/disassembly panels are not empty-looking unless genuinely empty.
- Current instruction highlight is clear.

### Problems
- Navbar appears on list and detail pages.
- Two-pane workspace is usable.
- Problem text is readable.
- Editor area is readable.
- Run/Submit are clear.

### Learn
- Cards do not overlap.
- Text is not clipped.
- Progress indicators make sense.
- Footer does not collide with content.

## Final Design Standard

If a change makes the site look more like a generic generated template, reject it.

If a change makes the site feel more like a precise, premium developer tool for learning RISC-V, keep going.
