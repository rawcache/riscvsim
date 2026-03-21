# StudyRISC-V Changelog

## Session 4 — March 2026
### Infrastructure
- Deployed AWS CDK stack (Cognito, DynamoDB, API Gateway, Lambda)
- Configured AWS Amplify hosting connected to GitHub main branch
- Removed Rust compile from Amplify build -- pkg committed to repo
- Build time reduced from 2:48 to ~1:30

### Auth
- Custom auth modal (no Cognito hosted UI redirect)
- USER_PASSWORD_AUTH flow via direct Cognito API calls
- GT students (@gatech.edu) auto-verified, others auto-confirmed
- Pro badge for GT students, no badge for free tier
- JWT token storage in localStorage, refresh token in sessionStorage

### Features
- Saved programs (DynamoDB, JWT-authenticated API)
- Free tier: 3 saved programs max
- Pro tier: unlimited saved programs + local session history
- Permalink sharing via URL hash (deflate compressed, base64url encoded)

### Pages
- Landing page at / (marketing)
- Simulator at /simulator/
- About page at /about/
- Docs/Guide page at /docs/
- Terms of service at /terms/
- Privacy policy at /privacy/

## Session 3 — March 2026
### Simulator core
- Rust/WASM contract fix: step delta now emits typed reg/mem/pc/trap effects
- Data directives: .data, .text, .word, .byte, .half, .ascii, .asciz, .space, .align
- la pseudo-instruction
- Fixed memory map: text=0x00000000, data=0x10000000, stack=0x7FFFFFFC
- call pseudo fixed: two-instruction lowering with pass-1 sizing
- imm12 validation across all I-type and S-type paths

### Regression suite
- 101 passing tests
- Covers: pseudos, labels, immediates, branches, memory, ALU, M-ext,
  traps, data directives, permalinks, saved programs API, stack tracker

### UI
- Three-column simulator layout (program input, center, register/memory)
- Assembly syntax highlighting (overlay approach, caret-color accent)
- Line numbers with current line highlight
- Effect log with REG/MEM/PC filters
- Memory panel with address input and follow-register dropdown
- Register file with calling convention group labels
- Center column tab system: Disassembly / Call Stack / Effects / Pseudo-C
- Call stack visualizer with animated frame push/pop
- Animator module for step animations
- Landing page redesign (Geist font, near-black, green accent)
- CPU chip pet on landing page

## Session 2 — March 2026
### Assembler
- Two-pass assembler with label resolution
- Pseudo-instruction expansion (li, mv, nop, j, ret, call)
- Symbol directives (#sym)
- ABI register name support

### UI foundation
- Design system (tokens.css)
- Simulator layout (simulator.css)
- Landing page (landing.css)
- Dark/light mode toggle with localStorage persistence

## Session 1 — March 2026
### Core
- Rust CPU interpreter for RV32IM subset
- wasm-bindgen exports
- TypeScript encoder for all instruction formats
- Initial frontend with textarea editor and disassembly view

