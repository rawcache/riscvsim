# StudyRISC-V — Codex Agent Rules

## Project overview
StudyRISC-V is a browser-based RV32IM simulator. The Rust core
compiles to WebAssembly. The frontend is plain HTML/CSS/TypeScript
with no framework. Auth and backend run on AWS via CDK.

## File structure
frontend/simulator/index.html     simulator app
frontend/landing.html             marketing landing page
frontend/about/index.html         about page
frontend/docs/index.html          docs/guide page
frontend/terms/index.html         terms of service
frontend/privacy/index.html       privacy policy
frontend/src/                     TypeScript source files
frontend/src/styles/              CSS files (tokens.css, simulator.css, landing.css)
frontend/src/pkg/                 pre-built wasm-pack output (committed, do not rebuild)
frontend/tests/regression/        Vitest regression suite
rust-core/src/lib.rs              Rust CPU interpreter (compiled to WASM)
infra/lib/stack.ts                AWS CDK stack (Cognito, DynamoDB, API Gateway)
infra/lambda/                     Lambda handlers

## NEVER modify these files
asm.ts
wasm-runtime.ts
types.ts
rust-core/src/lib.rs
vitest.config.ts
setup.ts
helpers.ts
Any file under frontend/tests/regression/ unless explicitly told to add tests

## Always verify after every task
npm run build passes (run from frontend/)
npm test passes (run from frontend/)
All existing tests still pass -- count must not decrease

## Stack
Language:     TypeScript + plain HTML/CSS (no React, no Vue, no Tailwind)
Build:        Vite (rolldown-vite)
Tests:        Vitest
Rust/WASM:    wasm-pack, wasm-bindgen -- pkg is pre-built, never rebuild in CI
Auth:         AWS Cognito via custom PKCE-free modal (USER_PASSWORD_AUTH)
Backend:      AWS CDK -- Cognito, DynamoDB, API Gateway, Lambda
Deploy:       AWS Amplify (frontend only, CDK manages backend separately)

## Design system
tokens.css owns ALL CSS custom properties
Never use hardcoded color values -- always use CSS custom properties
Dark mode: data-theme="dark" on html element
Light/dark toggle persists to localStorage

Simulator UI font:    DM Mono (monospace throughout)
Landing/marketing:    Geist (body), Geist Mono (code/labels only)
About/Docs pages:     Geist (body), Geist Mono (code)

## CSS custom properties (key ones)
--bg-base, --bg-surface, --bg-elevated   backgrounds
--border                                  border color
--text-primary, --text-secondary, --text-muted   text
--accent, --accent-hover, --accent-subtle         blue accent (simulator)
--success, --warning, --danger                    semantic colors
--highlight-new, --highlight-prev                 register/memory flash colors

## Constraints -- always apply
- No React, no Vue, no Tailwind, no Bootstrap, no external CSS frameworks
- No hardcoded colors anywhere -- CSS custom properties only
- Preserve ALL existing element IDs and class names that TypeScript references
- New CSS classes go in the appropriate stylesheet (simulator.css, landing.css, etc)
- The simulator (index.html) is always fully usable when logged out -- no login wall
- All new pages share tokens.css for the base design system
- Both light and dark mode must work correctly on every page
- Mobile responsive at 768px and 480px breakpoints on all pages
- Scrollbars: 6px wide, --border thumb, transparent track, 3px border-radius

## Memory map (fixed, never change)
Text segment:   0x00000000
Data segment:   0x10000000
Stack pointer:  0x7FFFFFFC (sp = x2, register index 2)
Stack region:   addresses >= 0x70000000

## Auth architecture
Cognito User Pool ID:  us-east-1_l7sOznZYZ
Client ID:             5rpv8jp09pq566dajslno6c9rr
Hosted UI domain:      studyriscv.auth.us-east-1.amazoncognito.com
API endpoint:          https://hsyyxozom8.execute-api.us-east-1.amazonaws.com
Tier logic:            email ending in @gatech.edu = Pro, everything else = Free

## WASM pkg
frontend/src/pkg/ is committed to git and must NOT be rebuilt during
Amplify builds. The prebuild script in package.json has been removed.
Only rebuild locally when rust-core/src/lib.rs changes:
  cd rust-core && wasm-pack build --target web --out-dir ../frontend/src/pkg

## Amplify build
amplify.yml runs only: npm ci then npm run build
No Rust install, no wasm-pack, no backend environment
Environment variables are exported inline in the build phase

## Site URLs
Landing:    https://studyriscv.com/
Simulator:  https://studyriscv.com/simulator/
About:      https://studyriscv.com/about/
Docs:       https://studyriscv.com/docs/
Terms:      https://studyriscv.com/terms/
Privacy:    https://studyriscv.com/privacy/

## When adding new pages
1. Create frontend/pagename/index.html
2. Add as entry point in frontend/vite.config.ts
3. Add rewrite rules to README.md Amplify section
4. Add nav link to landing.html, simulator nav, and any other pages
5. Add to Amplify Console rewrites manually after deploy