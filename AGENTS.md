# StudyRISC-V — Agent Rules

## Project Overview

StudyRISC-V is a browser-based RV32IM simulator and interactive learning platform.

The core simulator is written in Rust and compiled to WebAssembly. The frontend is plain HTML, CSS, and TypeScript with no framework. Auth and backend services run on AWS through CDK, Cognito, API Gateway, Lambda, and DynamoDB.

The product includes:
- Marketing landing page
- RISC-V simulator
- Curriculum/learn pages
- Practice/problems pages
- Checkpoints
- Docs/about/legal pages
- Auth modal and gated progress features

## Required Reading Before UI Work

Before making any visual, layout, navigation, CSS, or component changes, read:

1. `DESIGN.md`
2. `frontend/src/styles/tokens.css`
3. The relevant page stylesheet
4. The relevant page TypeScript file
5. `frontend/src/nav.ts` if the shared navbar is involved

`DESIGN.md` is the source of truth for the visual system. Do not invent a new design direction unless explicitly asked.

## File Structure

```text
frontend/landing.html                  marketing landing page
frontend/simulator/index.html          simulator app
frontend/problems/index.html           practice/problems app
frontend/learn/index.html              curriculum/learning page
frontend/checkpoints/index.html        checkpoints page
frontend/about/index.html              about page
frontend/docs/index.html               docs/guide page
frontend/terms/index.html              terms of service
frontend/privacy/index.html            privacy policy

frontend/src/                          TypeScript source files
frontend/src/nav.ts                    shared navbar implementation
frontend/src/styles/                   CSS files
frontend/src/styles/tokens.css         global design tokens
frontend/src/pkg/                      committed wasm-pack output, do not rebuild casually
frontend/tests/regression/             Vitest regression suite

rust-core/src/lib.rs                   Rust CPU interpreter compiled to WASM
infra/lib/stack.ts                     AWS CDK stack
infra/lambda/                          Lambda handlers
```

## Protected Files

Do not modify these unless the user explicitly asks:

```text
frontend/src/asm.ts
frontend/src/wasm-runtime.ts
frontend/src/types.ts
rust-core/src/lib.rs
frontend/vitest.config.ts
frontend/tests/regression/setup.ts
frontend/tests/regression/helpers.ts
frontend/tests/regression/*
frontend/src/pkg/*
```

Do not rebuild or regenerate `frontend/src/pkg/` unless the Rust core is intentionally changed.

## Build and Verification

Run commands from `frontend/`.

```bash
npm run build
npm test
```

Expected behavior:
- `npm run build` must pass.
- `npm test` should pass.
- If a test fails due to an unrelated pre-existing issue, report the exact test name and failure.
- Test count must not decrease.
- Do not silently change test expectations.

## Stack

```text
Frontend:     TypeScript + plain HTML/CSS
Frameworks:   None
CSS:          Plain CSS only
Build:        Vite / rolldown-vite
Tests:        Vitest
Rust/WASM:    wasm-pack + wasm-bindgen, pkg committed
Auth:         AWS Cognito, custom modal
Backend:      AWS CDK, API Gateway, Lambda, DynamoDB
Deploy:       AWS Amplify for frontend
```

## Hard Constraints

- No React.
- No Vue.
- No Tailwind.
- No Bootstrap.
- No external CSS framework.
- No large new dependency unless explicitly requested.
- Preserve existing element IDs and class names that TypeScript references.
- New CSS belongs in the relevant stylesheet.
- Shared design values belong in `tokens.css`.
- The simulator must remain usable while logged out.
- Light and dark mode must both work.
- Mobile responsive behavior is required at 768px and 480px.
- Do not create one-off navbars. Use the shared nav system.
- Do not hide content behind low contrast styling.
- Do not introduce layout shifts between pages.

## CSS Rules

`tokens.css` owns the design system.

Use CSS custom properties for colors, shadows, borders, radii, spacing, and major layout constants.

Allowed:
- Defining raw color values inside `tokens.css`.
- Using CSS variables everywhere else.

Not allowed:
- Hardcoding colors in page CSS.
- Duplicating token values across files.
- Creating page-specific palettes that fight the global design.

## Typography

Marketing and content pages:
- Use Geist or the existing sans-serif stack for body text.
- Use Geist Mono or the existing monospace stack only for code, labels, tabs, metadata, and simulator content.

Simulator:
- Code/editor/instruction areas should use a clear monospace font.
- UI chrome can use the sans-serif stack unless the existing page intentionally uses monospace.

## Routes

Primary production routes:

```text
Landing:      https://studyriscv.com/
Simulator:    https://studyriscv.com/simulator/
Problems:     https://studyriscv.com/problems/
Learn:        https://studyriscv.com/learn/
Checkpoints:  https://studyriscv.com/checkpoints/
About:        https://studyriscv.com/about/
Docs:         https://studyriscv.com/docs/
Terms:        https://studyriscv.com/terms/
Privacy:      https://studyriscv.com/privacy/
```

The GitHub link should point to:

```text
https://github.com/rawcache/riscvsim
```

## Shared Navbar Requirements

The shared navbar must:
- Appear on all major public pages.
- Keep the logo and brand link pointed to `/`.
- Keep Simulator pointed to `/simulator/`.
- Keep Practice/Problems pointed to `/problems/`.
- Keep Learn pointed to `/learn/`.
- Use the same dropdown implementation across pages.
- Avoid page-to-page horizontal shifting.
- Avoid oversized dropdown menus.
- Work in dark and light mode.
- Be usable on mobile.

## Memory Map

Do not change this unless explicitly requested:

```text
Text segment:   0x00000000
Data segment:   0x10000000
Stack pointer:  0x7FFFFFFC
Stack region:   addresses >= 0x70000000
```

## Auth Architecture

The simulator must remain usable without auth.

Auth is for:
- progress
- saved work
- gated features
- Pro/Free tier logic

Current known backend configuration:

```text
Cognito User Pool ID:  us-east-1_l7sOznZYZ
Client ID:             5rpv8jp09pq566dajslno6c9rr
Hosted UI domain:      studyriscv.auth.us-east-1.amazoncognito.com
API endpoint:          https://hsyyxozom8.execute-api.us-east-1.amazonaws.com
Tier logic:            @gatech.edu = Pro, everything else = Free
```

Do not expose secrets. Do not add private keys.

## Amplify Build

Amplify frontend build should not rebuild Rust/WASM.

Expected flow:
- `npm ci`
- `npm run build`

Backend is managed separately through CDK.

## When Adding a New Page

1. Create `frontend/<page>/index.html`.
2. Add it to `frontend/vite.config.ts`.
3. Add route/rewrite support where required.
4. Add the shared navbar correctly.
5. Add or update CSS using tokens.
6. Verify build and tests.
7. Report changed files and verification results.

## Agent Reporting Format

At the end of every task, report:

```text
Changed files:
- ...

Verification:
- npm run build: pass/fail
- npm test: pass/fail
- Any known unrelated failures

Notes:
- ...
```
