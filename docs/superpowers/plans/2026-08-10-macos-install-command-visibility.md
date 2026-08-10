# macOS Install Command Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the landing hero Homebrew command only on macOS desktops.

**Architecture:** Keep the existing pre-hydration `data-landing-platform` marker and CSS-gated command row. Correct mobile/tablet detection and make the hidden rule win over generated utility styles.

**Tech Stack:** Next.js, React, Tailwind CSS, Playwright

## Global Constraints

- macOS desktop shows the Homebrew command.
- Linux, Windows, phones, and tablets hide it without leaving layout space.
- Do not change download button behavior.

---

### Task 1: Platform-gated hero command

**Files:**
- Modify: `frontend/src/landing/src/app/layout.tsx`
- Modify: `frontend/src/landing/src/app/globals.css`
- Test: browser emulation against the running landing site

**Interfaces:**
- Consumes: `navigator.userAgent`, `navigator.maxTouchPoints`
- Produces: `document.documentElement.dataset.landingPlatform` with `mac` or `other`

- [ ] **Step 1: Run the browser-emulation regression check and confirm Linux, Windows, iPhone, and iPad fail.**
- [ ] **Step 2: Update the early detector to classify mobile and touch-capable iPad clients as `other` before macOS matching.**
- [ ] **Step 3: Strengthen the hidden CSS selector so generated display utilities cannot override it.**
- [ ] **Step 4: Re-run browser emulation and confirm only macOS desktop computes a visible command row.**
- [ ] **Step 5: Run landing typecheck and focused tests.**
