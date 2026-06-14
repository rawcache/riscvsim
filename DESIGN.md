---
version: 1.0
name: StudyRISCV-design-system
description: "StudyRISC-V follows Linear's design language 
but replaces lavender-blue with amber #f59e0b as the single 
chromatic accent. Near-void black canvas #0a0a0a, white text, 
emerald #10b981 for code and success states. Geist at 700-800 
weight with aggressive negative tracking. No purple, no indigo, 
no violet anywhere. Amber is the only warm accent."

colors:
  primary: "#f59e0b"
  primary-hover: "#fbbf24"
  primary-fg: "#000000"
  primary-subtle: "rgba(245,158,11,0.10)"
  primary-border: "rgba(245,158,11,0.30)"
  secondary: "#10b981"
  secondary-subtle: "rgba(16,185,129,0.10)"
  secondary-border: "rgba(16,185,129,0.25)"
  ink: "#f5f5f5"
  ink-muted: "rgba(255,255,255,0.55)"
  ink-subtle: "rgba(255,255,255,0.35)"
  canvas: "#0a0a0a"
  surface-1: "#111111"
  surface-2: "#1a1a1a"
  hairline: "#1e1e1e"
  hairline-hover: "#2e2e2e"
  danger: "#f87171"
  success: "#10b981"

typography:
  display-xl:
    fontFamily: "Geist, Inter, system-ui"
    fontSize: 72px
    fontWeight: 800
    lineHeight: 1.0
    letterSpacing: -0.03em
  display-lg:
    fontFamily: "Geist, Inter, system-ui"
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: -0.025em
  display-md:
    fontFamily: "Geist, Inter, system-ui"
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: -0.02em
  headline:
    fontFamily: "Geist, Inter, system-ui"
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.015em
  body-lg:
    fontFamily: "Geist, Inter, system-ui"
    fontSize: 18px
    fontWeight: 300
    lineHeight: 1.6
    letterSpacing: -0.01em
  body:
    fontFamily: "Geist, Inter, system-ui"
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: -0.005em
  eyebrow:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: 11px
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: 0.14em
  mono:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  button:
    fontFamily: "Geist, Inter, system-ui"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.01em

rounded:
  sm: 4px
  md: 6px
  lg: 8px
  xl: 12px
  pill: 999px

spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
  section: 96px

components:
  button-primary:
    backgroundColor: "#f59e0b"
    textColor: "#000000"
    rounded: "999px"
    padding: "10px 20px"
    fontWeight: 600
  button-secondary:
    backgroundColor: "transparent"
    textColor: "#f5f5f5"
    border: "1px solid #1e1e1e"
    rounded: "999px"
    padding: "10px 20px"
  feature-card:
    backgroundColor: "rgba(255,255,255,0.03)"
    border: "1px solid #1e1e1e"
    rounded: "6px"
    padding: "24px"
  nav:
    backgroundColor: "rgba(10,10,10,0.82)"
    backdropFilter: "blur(12px)"
    height: "64px"
---

## Overview

StudyRISC-V uses Linear's design language with one override:
amber (#f59e0b) replaces lavender-blue as the single accent.

CRITICAL — read before writing any UI:
- PRIMARY ACCENT: #f59e0b amber ONLY
- SECONDARY: #10b981 emerald for code/success ONLY
- CANVAS: #0a0a0a near-void black
- FONT: Geist (display), JetBrains Mono (code/eyebrow)
- NEVER use: purple, indigo, violet, lavender, cyan, blue
  as UI accent colors. These are banned.
- No drop shadows. Depth via surface lift + hairline borders.
- No atmospheric gradients outside the hero section.
- Aurora (hero only): emerald + amber at 8-15% opacity max.

## Linear Design Language — Applied to StudyRISC-V

Follow Linear's patterns exactly:
- Four-step surface ladder: canvas → surface-1 → surface-2
- Hairline borders (#1e1e1e) on all cards
- Dense product UI screenshots as section protagonists
- Negative letter-spacing on all display type
- Pill-rounded CTAs (999px)
- Sticky nav with backdrop-filter blur
- 96px section spacing
- 3-column card grid desktop, 1-column mobile

## Typography Rules

Display: Geist 800, -0.03em tracking, line-height 1.0
Subhead: Geist 300, -0.01em tracking, line-height 1.6
Eyebrow: JetBrains Mono 700, +0.14em tracking (positive)
Code: JetBrains Mono 400, always on surface-1 background
Button: Geist 600, -0.01em tracking

## Color Application Rules

Amber (#f59e0b) appears on:
  Primary CTA buttons
  Active nav state
  Current instruction highlight in simulator
  ALU glow in CPU visualization
  Progress bar fill
  Hover border on feature cards

Emerald (#10b981) appears on:
  Eyebrow labels
  Code surfaces and syntax highlighting
  Success states
  Register write highlights
  Secondary data indicators

Everything else: white text on black surface.

## Do's and Don'ts

### Do
- Read this file before writing any UI
- Use amber for all primary actions and highlights
- Use emerald for all code and success indicators
- Follow Linear's surface ladder for depth
- Use Geist at 700-800 for all headlines
- Use JetBrains Mono for all code and eyebrow text
- Pill-round all CTA buttons

### Don't
- NEVER use purple (#6366f1, #818cf8, #7c3aed or any variant)
- NEVER use indigo or violet as accent
- NEVER use blue (#0050ff or similar) as UI accent
- NEVER add box-shadow
- NEVER bleed aurora into sections below the hero
- NEVER use border-radius above 12px on cards
- NEVER use font-weight above 800
