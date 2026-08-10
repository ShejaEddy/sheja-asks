# ✶ Sheja Asks

An AI-powered quiz assistant for **quiz.com**. It watches the page, detects each
question as it appears, and shows the most likely answer in a sleek overlay —
powered by the AI provider of your choice (Claude, OpenAI, Gemini, or Mistral).

> ⚠️ Built for learning and practice. Use responsibly and in line with quiz.com's
> terms and any rules of the games you play.

## Features

- **Automatic question detection** — a `MutationObserver` + polling pipeline reads
  questions live as quiz.com types them out, including multiple-choice, open-ended
  (type-in), unscramble/anagram, fill-in-the-blank, and image questions.
- **Answers once, accurately** — a readiness gate waits for the answer surface
  (option buttons *or* the text input) to render before calling the AI, so you get
  one correct answer per question instead of an early wrong guess.
- **Smart vision** — sends a screenshot only when the question actually needs it
  (flags, logos, "what is shown"), keeping plain knowledge questions text-only for
  speed and lower cost.
- **Auto-selects by default** — once an answer is ready it clicks/types it in and
  submits automatically. A simulated click isn't assumed to have registered: it
  checks the page for confirmation (a Try/Submit button becoming enabled, or an
  ARIA/selected-state change) and re-clicks immediately if not, for up to ~2s,
  before giving up and leaving the answer clickable so you can apply it manually.
  The answer stays visible and clickable the whole time either way, so if you'd
  rather pick something else, click any other option on the page and it still works.
- **Multi-provider** — bring your own key for:
  - Anthropic **Claude** (`claude-haiku-4-5`)
  - OpenAI **GPT** (`gpt-4o-mini`)
  - Google **Gemini** (`gemini-2.5-flash`)
  - **Mistral** (`mistral-small-latest`, `pixtral-12b` for vision)
- **Polished overlay** — draggable dark-glass panel with a live status pill
  (Detecting → Waiting for options → Asking AI → Answered), pause, minimize, and a
  manual re-scan button.
- **Private by default** — your API key is stored locally via `chrome.storage.local`
  and is sent only to your chosen provider. No analytics, no servers.

## How it works

1. A **content script** detects and cleans the current question and its options.
2. It asks a **background service worker** to call your selected AI provider's API
   (the worker handles cross-origin requests and, for visual questions, captures a
   screenshot of the tab).
3. The answer is parsed into a clean, fillable form and rendered in the overlay,
   ready for you to click and submit.

## Setup

1. Clone or download this repo.
2. Go to `chrome://extensions`, enable **Developer mode**, and **Load unpacked** →
   select the project folder.
3. Click the extension icon, pick a provider, paste your API key, and **Save**.
4. Open a game on **quiz.com** — the overlay appears automatically.

## Getting an API key

- Anthropic — https://console.anthropic.com
- OpenAI — https://platform.openai.com/api-keys
- Google AI Studio — https://aistudio.google.com/apikey
- Mistral — https://console.mistral.ai/api-keys

## Tech

Chrome Extension (Manifest V3) · content script + background service worker ·
vanilla JS, no build step · `chrome.storage.local` for settings.

The content script is organised as modular ES6 classes over a small event bus:
`IngestionEngine` (DOM + visual question capture), `TransitionSensor` (predictive
next-question detection), `EventLifecycleManager` (click-driven reset),
`CapturePipeline` (screenshots), `Solver` (AI calls + self-consistency vote),
`AnswerFiller` (click/type/submit), `OverlayUI` (view), and an `Orchestrator` that
wires them together with single-flight back-pressure.

## Testing

Two suites run on macOS's built-in JavaScriptCore — no Node or install step. They
stand up a fake DOM + `chrome` API, load the real scripts, and assert against their
actual internals (~320 assertions total).

```sh
# from the project root
osascript -l JavaScript tests/content.test.js      # modules, helpers, latency, design
osascript -l JavaScript tests/background.test.js   # AI prompts + response parsing
```

Both exit non-zero if any assertion fails. Coverage includes:

- **Unit** — every pure helper (`parseAnswer`, `dedupeQuestion`, `truncateAtQuestionMark`,
  `needsVision`, `extractAnswers`, `classifyAnswerSurface`, …).
- **Behaviour** — each module: EventBus, Solver (vote / strict retry / vision routing),
  AnswerFiller — confirm-and-retry for BOTH paths, each retrying the right thing rather
  than assuming success: MC confirms via locked options / ARIA state / an enabled submit
  button, retries the CLICK on clear negative evidence (a submit button still disabled) for
  the full budget, and — for a click=submit platform with no submit button and no locked
  signal at all (quiz.com's MC) — does a few quick blind retries rather than trusting a
  single unconfirmed click, before accepting best-effort; open-ended retries FINDING the
  input if it isn't detectable yet (not just confirming a fill that never started), then
  retries the TYPE if a controlled input silently rejects the value. IngestionEngine (gate + dedup + suppression,
  idempotent on a repeat click; the visual/option poll also catches an open-ended question's
  TEXT changing even with no option buttons or image, for pages where a new question appears
  via scroll/virtualization rather than a DOM mutation), TransitionSensor,
  EventLifecycleManager, Orchestrator (auto-selects by default without a manual click; marks
  the answer filled rather than replacing it — MC or open-ended, single or repeated click —
  without clobbering a new question that started loading mid-fill).
- **Design decisions** — locked in by name: fingerprint excludes options, `needsVision`
  by wording not image presence, MC never types into an input, transition preserves the
  in-flight solve (only an answer cancels), single-flight back-pressure.
- **Performance guards** — fail if an optimization is reverted: `visualFingerprint` reads
  each image's rect ≤ once, screenshot fast path uses one frame + one image scan, the
  overlay is only hidden right before the actual shot (not for the whole image-wait), it
  fades rather than snaps in/out of a capture, both `IngestionEngine` and
  `TransitionSensor` go quiet for that native-capture window so their own layout-forcing
  polls don't compound the freeze `chrome.tabs.captureVisibleTab` already causes, a visual
  fingerprint change is confirmed on 2 separate detection calls (from EITHER plan) before
  it's acted on so a still-loading/background image can't re-trigger a whole extra
  screenshot + AI round trip, a predicted-transition `reset()` that turns out to be a false
  positive (same question still on screen) doesn't re-run the pipeline either, a shrinking
  trailing-substring rewrite of the question text (quiz.com's own decorative scroll/reveal
  animation — confirmed via logs to fire ~12 spurious detections per question before this)
  doesn't replace an already-seen longer candidate, and the readiness gate stops blocking
  the AI call on an open-ended answer input becoming detectable (confirmed via logs: it was
  hitting the full 5s gate timeout on every single open-ended question — 2s is now the cap
  specifically for that case, the AI call doesn't actually need the input to exist yet).
- **Prompt design** — which type-hints fire (negation, superlative, ordering, matching,
  year, anagram, categorical syllogism, …) and that hints accumulate.

The scripts expose their internals to the suites only when `globalThis.__shejaTestHook` /
`__shejaBgTestHook` are defined — never true in a real browser, so the hooks are inert in
production.

## Privacy

Question text (and, for visual questions, a screenshot of the active tab) is sent to
the AI provider you configure, using your own API key. Nothing is collected or sent
anywhere else.
