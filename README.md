# VayuShield AI — Urban Air Quality & Winter Smog Assistant

> Built for **PromptWars Virtual — Main Challenge 06: Urban Air Quality Assistant**

**VayuShield AI** is a GenAI-powered assistant that helps families and communities navigate severe winter smog and urban air pollution through **live AQI telemetry**, **24-hour thermal inversion scheduling**, **low-emission daily routines**, **budget-tiered indoor air quality (IAQ) hacks**, and an interactive **Choice-to-Impact Simulator** powered by **Google Gemini 2.5 Flash**.

**Live Demo:** ` https://....vercel.app URL HERE AFTER DEPLOY](https://vayushield-ai-five.vercel.app `

---

## Architecture & Data Flow

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                    VayuShield AI (Zero-Bloat Vanilla ESM)               │
│  index.html (Strict Semantic WCAG 2.1)  +  styles/main.css (No CDN JS)  │
└───────────────┬─────────────────────────────────────────┬───────────────┘
                │                                         │
                ▼                                         ▼
┌───────────────────────────────┐        ┌────────────────────────────────┐
│   Pure Core Engines (js/core) │        │    External & Serverless APIs  │
│ • aqiEngine.js (CPCB + Curves)│        │ • /api/gemini.js (Rate-Limited │
│ • recommendationEngine.js     │        │   Gemini 2.5 Flash Proxy)      │
│ • security.js (Zero-XSS DOM)  │        │ • Open-Meteo Live AQI + Geo    │
└───────────────────────────────┘        └────────────────────────────────┘
