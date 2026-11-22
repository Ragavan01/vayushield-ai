# Prompt Engineering & AI Tool Usage Documentation — VayuShield AI

Built for **PromptWars Virtual — Main Challenge 06: Urban Air Quality Assistant**.

## 1. AI Tools Selected & Why
| Tool | Role in Build | Why It Was Selected |
| :--- | :--- | :--- |
| **Google Gemini 2.5 Flash** | Runtime GenAI Smog Coach (`/api/gemini.js`) + architecture/test co-design | Sub-second structured JSON generation (`responseMimeType: "application/json"`), strong grounded reasoning for Indian winter smog context, and low token latency. |
| **VS Code + Node.js Test Runner** | Local modular engineering & verification | Zero external dependency bloat, native ESM syntax checks, and instant CI execution via GitHub Actions. |
| **Open-Meteo Air Quality & Geocoding API** | Real-time PM2.5, PM10, NO₂ & US AQI telemetry | Free, no-key-required atmospheric data allowing any family worldwide to get live readings instantly. |
| **Vercel Serverless Functions** | Secure production deployment + API proxy | Keeps `GEMINI_API_KEY` server-side while applying hardened CSP, HSTS, and `X-Frame-Options` headers. |

## 2. How Our Prompts Evolved (4 Iterations)
### Iteration 1 — Naive Single-Prompt Prototype (Discarded)
* **Prompt:** *"Give air quality advice for Delhi winter smog."*
* **Failure Mode:** Produced generic tips ("wear a mask, buy an air purifier") with no location awareness, no budget sensitivity for families who cannot spend ₹15,000, and zero quantitative impact.

### Iteration 2 — Context-Injected Structured JSON Prompt
* **Upgrade:** Injected live `city`, `aqi`, `pm25`, `householdProfile`, `commuteMode`, `budgetTier`, `cookingFuel`, and `roomSqFt`, and enforced a strict 6-field JSON schema (`headline`, `immediateSteps`, `indoorHack`, `sustainableSwap`, `directImpact`, `communityTip`).
* **Result:** Eliminated markdown formatting breakage and guaranteed every response addressed indoor hacks, low-emission swaps, and community actions simultaneously.

### Iteration 3 — Physics & Diminishing-Returns Grounding
* **Upgrade:** Separated deterministic atmospheric math (CPCB PM2.5 breakpoints, Berkeley Earth `22 µg/m³ ≈ 1 cigarette/day` passive exposure rule, 24-hour thermal inversion curve, room CADR 4–5 ACH sizing) into pure ES modules (`js/core/`) so GenAI explains **real, defensible numbers** rather than hallucinating savings.

### Iteration 4 — Security, Accessibility & Zero-Downtime Hardening
* **Upgrade:** Added server-side input sanitization, sliding-window IP rate limiting, strict CSP (`script-src 'self'`, zero `'unsafe-inline'`), zero-`innerHTML` DOM rendering, WCAG 2.1 roving-tab keyboard navigation, and a deterministic grounded fallback engine so evaluators can test 100% of flows even without configuring an API key.

## 3. Division of Responsibility: What GenAI Handled vs. What Human Designed
* **Human Engineering & Product Design:**
  * Identified the core Indian winter smog pain points: dawn/night **thermal inversion traps**, **budget barriers** (zero-cost vs. ₹2,200 DIY HEPA box vs. commercial purifiers), indoor combustion myths (houseplants vs. HEPA CADR), and community-level RWA pledges.
  * Defined the strict security boundary (server-side Gemini proxy, CSP headers, zero `innerHTML`) and verified all 4 test suites locally via `npm run verify`.
* **GenAI (Google Gemini):**
  * Accelerated modular code scaffolding, generated tailored conversational smog action plans at runtime grounded in live AQI + household telemetry, and assisted in generating comprehensive edge-case unit and accessibility tests.