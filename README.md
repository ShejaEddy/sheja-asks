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
- **Click to fill** — click the suggested answer to auto-select the option (or type
  it into the answer box) and auto-submit.
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
actual internals (~290 assertions total).

```sh
# from the project root
osascript -l JavaScript tests/content.test.js      # modules, helpers, latency, design
osascript -l JavaScript tests/background.test.js   # AI prompts + response parsing
```

Both exit non-zero if any assertion fails. Coverage includes:

- **Unit** — every pure helper (`parseAnswer`, `dedupeQuestion`, `truncateAtQuestionMark`,
  `needsVision`, `extractAnswers`, `classifyAnswerSurface`, …).
- **Behaviour** — each module: EventBus, Solver (vote / strict retry / vision routing),
  AnswerFiller, IngestionEngine (gate + dedup + suppression, idempotent on a repeat click),
  TransitionSensor, EventLifecycleManager, Orchestrator (resets the overlay to idle on
  every applied answer — MC or open-ended, single or repeated click — without clobbering
  a new question that started loading mid-fill).
- **Design decisions** — locked in by name: fingerprint excludes options, `needsVision`
  by wording not image presence, MC never types into an input, transition preserves the
  in-flight solve (only an answer cancels), single-flight back-pressure.
- **Performance guards** — fail if an optimization is reverted: `visualFingerprint` reads
  each image's rect ≤ once, screenshot fast path uses one frame + one image scan, the
  overlay is only hidden right before the actual shot (not for the whole image-wait), it
  fades rather than snaps in/out of a capture, both `IngestionEngine` and
  `TransitionSensor` go quiet for that native-capture window so their own layout-forcing
  polls don't compound the freeze `chrome.tabs.captureVisibleTab` already causes, and the
  visual poll debounces a flickering image fingerprint (2 consecutive polls, never a bare
  single tick or endless alternation) so a churning `src` on a still-unchanged image can't
  re-trigger a whole extra screenshot + AI round trip.
- **Prompt design** — which type-hints fire (negation, superlative, ordering, matching,
  year, anagram, …) and that hints accumulate.

The scripts expose their internals to the suites only when `globalThis.__shejaTestHook` /
`__shejaBgTestHook` are defined — never true in a real browser, so the hooks are inert in
production.

## Privacy

Question text (and, for visual questions, a screenshot of the active tab) is sent to
the AI provider you configure, using your own API key. Nothing is collected or sent
anywhere else.
