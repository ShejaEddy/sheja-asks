/**
 * Sheja Asks — high-performance quiz-automation content script.
 *
 * Modular ES6 architecture (one class per concern), wired over a central EventBus:
 *
 *   IngestionEngine       DOM (MutationObserver + rAF batching) + visual-fingerprint
 *                         polling; runs the answer-surface readiness gate and emits
 *                         `questionDetected` once a question is answerable.
 *   TransitionSensor      Predictive next-question detection (loaders/skeletons +
 *                         layout-shift polling) → emits `transitionStart`.
 *   EventLifecycleManager Capture-phase click interception → emits `lifecycleReset`
 *                         the instant an answer is chosen.
 *   CapturePipeline       Screenshot service (waits for large images, hides overlay,
 *                         delegates to the background script).
 *   Solver                AI request orchestration (vision routing, strict retry,
 *                         self-consistency vote) against the existing background.js.
 *   AnswerFiller          Click/type/submit the chosen answer on the page.
 *   OverlayUI             The draggable/resizable overlay (view only).
 *   Orchestrator          Owns state + back-pressure and wires every module together.
 *
 * Events: questionDetected {question,options,visualKey,timestamp}
 *         transitionStart  {type,timestamp}
 *         lifecycleReset   {timestamp}
 * (plus internal ingest status pings for the overlay pill).
 */
(() => {
    'use strict';

    // ── Constants ──────────────────────────────────────────────────────────────
    const LOG_KEY          = "__quiz_logs";
    const MAX_LOGS         = 500;
    const DEBOUNCE_MS      = 300;   // settle time after last DOM change (incomplete stems)
    const DEBOUNCE_Q_MS    = 120;   // faster flush for a "?"-terminated (complete) question
    const VISUAL_POLL_MS   = 250;   // rAF-throttled cadence for the visual/option loop
    const IMG_WAIT_MS      = 800;   // max wait for flag images to finish loading
    const SCREENSHOT_SETTLE_MS = 40; // paint settle after hiding the overlay, before capture
    const SCREENSHOT_POLL_MS   = 80; // re-check cadence while waiting for images to load
    const AUTOFILL_MS      = 700;   // delay before auto-fill on manual rescan
    const SUBMIT_INIT_MS   = 400;   // delay before first submit attempt (lets selection register)
    const SUBMIT_RETRY_MS  = 350;   // delay between submit retries
    const SUBMIT_RETRIES   = 4;
    const RESET_COOLDOWN_MS = 200;  // suppress re-detection immediately after an answer click
    // Answer-surface readiness gate — wait for options/input before calling the AI
    const GATE_INTERVAL_MS = 150;   // re-check cadence while waiting for the answer surface
    const GATE_MAX_MS      = 5000;  // give up waiting and call best-effort after this
    const OPEN_GRACE_MS    = 700;   // grace before treating a text input as "open-ended"
    // TransitionSensor tuning
    const TRANSITION_POLL_MS       = 50;   // layout-shift sampling cadence (spec: 50ms)
    const LAYOUT_SHIFT_PX          = 50;   // dimension delta that counts as a transition
    const TRANSITION_REFRACTORY_MS = 700;  // min gap between emitted transitions (anti-spam)
    // Self-consistency voting
    const VOTE_CONF    = 0.6;   // MC confidence below this triggers a vote
    const VOTE_SAMPLES = 2;     // extra samples drawn when voting
    const VOTE_TEMP    = 0.4;   // temperature for vote samples (diversity)

    const OVERLAY_ID = "qa-overlay";

    // ── Logging ────────────────────────────────────────────────────────────────
    // Ring buffer in sessionStorage — capped so it can never grow unbounded.
    let logSeq = 0;
    function log(type, data) {
        const entry = { ts: Date.now(), seq: ++logSeq, t: type, ...data };
        try {
            const stored = JSON.parse(sessionStorage.getItem(LOG_KEY) || "[]");
            stored.push(entry);
            if (stored.length > MAX_LOGS) stored.splice(0, stored.length - MAX_LOGS);
            sessionStorage.setItem(LOG_KEY, JSON.stringify(stored));
        } catch (e) {}
    }

    // ── Chrome messaging ─────────────────────────────────────────────────────────
    function runtimeSend(msg, callback) {
        try {
            chrome.runtime.sendMessage(msg, response => {
                if (chrome.runtime.lastError) callback({ error: "Extension context invalidated — reload the page" });
                else callback(response);
            });
        } catch (e) {
            callback({ error: String(e) });
        }
    }

    // ╔══════════════════════════════════════════════════════════════════════════╗
    // ║ Shared pure utilities — stateless helpers consumed by every module.       ║
    // ╚══════════════════════════════════════════════════════════════════════════╝

    function normalize(s) { return s.replace(/\s+/g, " ").trim(); }

    // Canonical match key shared by answer capture and click-time resolution:
    // strip diacritics, lowercase, collapse punctuation/symbols/whitespace.
    function normKey(s) {
        return (s || "")
            .normalize("NFKD").replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    // Fraction of `want`'s tokens present in `have` (relative to the larger set).
    function tokenOverlap(haveKey, wantKey) {
        const have = new Set(haveKey.split(" ").filter(Boolean));
        const want = wantKey.split(" ").filter(Boolean);
        if (!have.size || !want.length) return 0;
        let hit = 0;
        for (const w of want) if (have.has(w)) hit++;
        return hit / Math.max(have.size, want.length);
    }

    function inViewport(rect, slack) {
        const s = slack || 0;
        return rect.width > 0 && rect.height > 0 &&
            rect.top >= -s && rect.left >= -s &&
            rect.bottom <= window.innerHeight + s &&
            rect.right <= window.innerWidth + s;
    }

    const JUNK_PATTERNS = [
        "window.dataLayer", "__N_SSP", "pageProps", "overflow:", "scrollbar",
        "gtag(", '"props":', "buildId", "scriptLoader", "Play NowPlay",
        "Recently published", "Enter PIN", "Start vote mode", "Quiz.com",
        "PIN#", "hosting?", "Slide 1/", "Slide 2/", "Slide 3/", "Slide 4/",
        "Slide 5/", "Slide 6/", "Slide 7/", "Slide 8/", "Slide 9/",
        ">0(1)", "0 (1)", "would you like to", "continue hosting", "stop hosting"
    ];
    function isJunk(text) {
        const l = text.toLowerCase();
        return JUNK_PATTERNS.some(p => l.includes(p.toLowerCase()));
    }

    // UI/navigation labels that are never quiz answers. Multi-word platform actions are
    // safe to blanket-ignore; ambiguous single words (home/start/menu) are left out
    // because they can be legitimate answers.
    const IGNORED_ANSWERS = new Set([
        "select one", "select one or more", "next", "back", "join", "play",
        "create", "kick players", "try", "try again", "submit", "check",
        "show q", "hide q", "scan", "↺ scan",
        "quiz editor", "quiz generator", "quiz library",
        "keep hosting", "stop hosting", "leave", "cancel",
        "editor", "generator", "hosting", "library",
        "hide incorrect answers", "show incorrect answers", "show correct answer",
        "next question", "finish quiz", "finish", "skip", "continue",
        // platform chrome / account / social actions
        "log in", "login", "sign in", "sign up", "signup", "log out", "sign out",
        "share", "report", "settings", "profile", "help",
        "mute", "unmute", "fullscreen", "exit fullscreen", "got it",
        "play again", "restart", "replay", "new game", "start over",
        "reveal answer", "show hint", "give up", "close"
    ]);

    // Question stems that appear WITHOUT a trailing "?" on quiz.com (imperatives,
    // true/false, ordering, etc.). Kept strongly question-indicative to avoid detecting
    // page chrome as a question — yes/no starters (is/are/do…) are deliberately excluded
    // because those virtually always carry a "?" (already handled) and are otherwise a
    // common false-positive source in body copy.
    const _QUESTION_STEMS = [
        "what ", "which ", "who ", "whom ", "whose ", "where ", "when ", "how ", "why ",
        "name ", "find ", "identify ", "guess ", "choose ", "pick ", "select ",
        "unscramble ", "spell ", "type ", "fill in", "complete ", "finish the",
        "match ", "describe ", "define ", "explain ", "state ",
        "calculate ", "solve ", "compute ", "evaluate ", "convert ", "round ", "estimate ",
        "translate ", "arrange ", "order ", "put ", "sort ", "rank ", "list ", "count ",
        "true or false", "in what", "in which", "at what", "on what", "by what",
        "according to", "based on"
    ];
    function looksLikeQuestion(text) {
        if (text.endsWith("?")) return true;
        const l = text.toLowerCase();
        return _QUESTION_STEMS.some(w => l.startsWith(w));
    }

    // Quiz.com repeats the whole question (2×, 3×, sometimes with trailing score
    // garbage). Find where the opening ~15 chars recur and cut there — collapses
    // QQ / QQQ / partial repeats in one pass, returns unchanged when there's no repeat.
    function dedupeQuestion(text) {
        text = text.trim();
        const sigLen = Math.min(15, Math.floor(text.length / 2));
        if (sigLen < 6) return text;
        const sig = text.slice(0, sigLen);
        const next = text.indexOf(sig, sigLen);
        if (next !== -1) return text.slice(0, next).trim();
        return text;
    }

    // Prefer the longer/more-complete candidate (riddles need full context).
    function isBetterCandidate(newC, oldC) {
        if (!oldC) return true;
        const nl = newC.toLowerCase(), ol = oldC.toLowerCase();
        const [longer, shorter] = nl.length >= ol.length ? [nl, ol] : [ol, nl];
        if (longer.startsWith(shorter)) return newC.length > oldC.length;
        return newC.length > oldC.length;
    }

    function compact(s) { return s.toLowerCase().replace(/\s+/g, ""); }

    function looksLikeOptionSuffix(after, answers) {
        if (!answers?.length) return false;
        const tail = compact(after);
        const optionBits = answers.map(a => compact(a)).filter(a => a.length >= 2);
        if (!optionBits.length) return false;
        const hits = optionBits.filter(a => tail.includes(a)).length;
        return hits >= Math.min(2, optionBits.length);
    }

    // Only strips text after "?" when it looks like concatenated option labels /
    // score garbage. Riddle clues ("What am I? I get wetter the more I dry.") stay.
    function truncateAtQuestionMark(text, answers) {
        const idx = text.indexOf("?");
        if (idx === -1) return text;
        const head = text.slice(0, idx + 1);
        const after = text.slice(idx + 1).trim();
        if (!after) return text;
        if (!/[a-zA-Z]/.test(after)) return head;                       // score numbers / garbage
        const headCore = compact(head).replace(/\?+$/, "");
        if (headCore.length >= 8 &&
            compact(after).startsWith(headCore.slice(0, Math.min(headCore.length, 14)))) return head;
        if (/(\d{2,4})\1{2,}/.test(after.replace(/\s+/g, ""))) return head;   // repeated score run
        if (after.length > 8 && after.includes(" ") && !looksLikeOptionSuffix(after, answers)) return text;
        return head;
    }

    // Fingerprint the single largest, top-positioned question image by src.
    // Excludes small/decorative images and the overlay; src-only avoids dimension drift.
    // PERF: single linear pass tracking the max — exactly one getBoundingClientRect per
    // image. (The old filter+sort read the rect O(n log n) times, forcing layout on the
    // hot visual-poll path that runs every ~250ms.)
    function visualFingerprint() {
        let best = null, bestArea = 0;
        const imgs = document.querySelectorAll("img");
        for (const el of imgs) {
            if (el.closest("#" + OVERLAY_ID)) continue;
            const r = el.getBoundingClientRect();
            if (r.width >= 150 && r.height >= 130 && inViewport(r, 10) &&
                (r.width / r.height) <= 2.5 && r.top >= 50 && r.top <= window.innerHeight * 0.85) {
                const area = r.width * r.height;
                if (area > bestArea) { bestArea = area; best = el; }
            }
        }
        return best ? "img:" + (best.currentSrc || best.src) : "";
    }

    function extractAnswers() {
        const seen = new Set();
        const results = [];
        document.querySelectorAll("button, [role='button'], [role='option']").forEach(el => {
            const rect = el.getBoundingClientRect();
            const text = normalize(el.textContent || "");
            const skip =
                el.closest("#" + OVERLAY_ID) ? true :
                el.disabled              ? true :
                rect.width < 60          ? true :
                rect.height < 20         ? true :
                !inViewport(rect)        ? true :
                !text                    ? true :
                text.length > 80         ? true :
                IGNORED_ANSWERS.has(text.toLowerCase()) ? true :
                isJunk(text)             ? true : false;
            if (skip) return;
            if (!seen.has(text)) { seen.add(text); results.push(text); }
        });
        return results;
    }

    const _SKIP_INPUT_TYPES = new Set(["submit","button","checkbox","radio","file","hidden","image","reset","range","color","date","datetime-local","month","week","time","number","password"]);
    function findTextInput() {
        const all = [...document.querySelectorAll("input, textarea, [contenteditable='true']")];
        return all.find(el => {
            if (el.closest("#" + OVERLAY_ID) || el.readOnly || el.disabled) return false;
            if (_SKIP_INPUT_TYPES.has((el.type || "").toLowerCase())) return false;
            const r = el.getBoundingClientRect();
            return r.width > 50 && r.height > 10 && inViewport(r);
        }) || null;
    }

    // Uses React's internal value setter so controlled inputs register the change.
    function fillInput(el, text) {
        el.focus();
        const proto  = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, text); else el.value = text;
        el.dispatchEvent(new Event("input",  { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Full pointer+mouse sequence (so React handlers register) plus a native click()
    // fallback, after bringing the element into view and focusing it.
    function simulateClick(el) {
        if (!el) return;
        try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
        try { el.focus?.({ preventScroll: true }); } catch (e) {}
        const r  = el.getBoundingClientRect();
        const cx = r.left + r.width  / 2;
        const cy = r.top  + r.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
        ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(type =>
            el.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, opts))
        );
        try { el.click(); } catch (e) {}   // quiz.com options are select-one → a 2nd click is safe
    }

    function liveOptionEls() {
        return [...document.querySelectorAll("button, [role='button'], [role='option']")].filter(el => {
            if (el.closest("#" + OVERLAY_ID) || el.disabled) return false;
            const r = el.getBoundingClientRect();
            return r.width >= 60 && r.height >= 20 && inViewport(r);
        });
    }

    function clickableFrom(el) {
        return el?.closest("button, [role='button'], [role='option'], label, li[role]") || el;
    }

    function isLiveOption(el) {
        if (!el || !el.isConnected || el.closest("#" + OVERLAY_ID) || el.disabled) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 40 && r.height >= 18 && inViewport(r, 4);
    }

    function looksLikeVisualQuestion(q) {
        const l = q.toLowerCase();
        return l.includes("flag") || l.includes("country") || l.includes("identify") ||
               l.includes("image") || l.includes("picture") || l.includes("photo") ||
               l.includes("logo") || l.includes("guess the");
    }

    // Pure text/number tasks where any on-screen image is decorative — sending the
    // (near-ubiquitous) background image to the model only hurts accuracy and costs a
    // screenshot round-trip.
    function isImageIrrelevantQuestion(q) {
        const l = q.toLowerCase();
        // NOTE: "calculate"/"solve" are deliberately NOT here — image-based geometry
        // ("calculate the area of this triangle") genuinely needs vision. Plain
        // arithmetic already stays text-only via the no-visual-cue path in needsVision().
        return l.includes("unscramble") || l.includes("anagram") || l.includes("rearrange") ||
               l.startsWith("fill in") || l.startsWith("complete the") ||
               l.startsWith("type ") || l.startsWith("spell ") ||
               l.startsWith("convert ") || l.startsWith("round ");
    }

    const _VISUAL_CUES = ["this ", "these ", "shown", "pictured", "depicted", " above", " below",
                          "hidden", "in the image", "in the picture", " map", "screenshot"];

    // Decide whether to send a screenshot — driven by QUESTION WORDING, not the mere
    // presence of a decorative image (quiz.com shows a background image almost always).
    function needsVision(q) {
        if (isImageIrrelevantQuestion(q)) return false;
        const l = (q || "").toLowerCase();
        if (looksLikeVisualQuestion(q)) return true;
        return _VISUAL_CUES.some(c => l.includes(c));
    }

    // Fallback whole-DOM scan for a question when the observer misses a transition.
    function scanForCurrentQuestion() {
        let best = "";
        const answers = extractAnswers();
        document.querySelectorAll("h1,h2,h3,h4,p,span,div,label").forEach(el => {
            if (el.closest("#" + OVERLAY_ID) || el.closest("button,[role='button']")) return;
            if (el.querySelectorAll("button,[role='button']").length > 0) return;
            const rect = el.getBoundingClientRect();
            if (rect.width < 80 || !inViewport(rect, 10)) return;
            const text = normalize(el.textContent || "");
            if (text.length < 8 || text.length > 300 || isJunk(text) || !looksLikeQuestion(text)) return;
            const clean = truncateAtQuestionMark(dedupeQuestion(text), answers);
            if (clean.length >= 8 && clean.trim().split(/\s+/).length >= 3 && clean.length > best.length) best = clean;
        });
        return best || null;
    }

    // What can we answer against right now? mc = option buttons, open = free-text input,
    // none = nothing rendered yet. Biased toward MC: a bare text input only counts as
    // "open" after a grace period so a lagging MC question isn't misread as open-ended.
    function classifyAnswerSurface(question, elapsed) {
        const btns = extractAnswers();
        if (btns.length >= 2) return { kind: "mc", answers: btns };
        if (isImageIrrelevantQuestion(question)) return { kind: "open", answers: [] };
        if (findTextInput() && elapsed >= OPEN_GRACE_MS) return { kind: "open", answers: [] };
        return { kind: "none", answers: [] };
    }

    // ── Answer-parsing helpers ──────────────────────────────────────────────────
    function startsWithWord(text, prefix) {
        if (!text.startsWith(prefix)) return false;
        if (text.length === prefix.length) return true;
        return !/[a-z0-9]/i.test(text.charAt(prefix.length));
    }

    function stripWrap(s) {
        return (s || "")
            .replace(/^\[(.+)\]$/, "$1")
            .replace(/^["'“”‘’](.+)["'“”‘’]$/, "$1")
            .trim();
    }

    function clampReason(r) {
        r = (r || "").trim();
        if (r.length > 120) r = r.slice(0, 117).trimEnd() + "…";
        return r;
    }

    // Closest option by word overlap / substring — last resort when the model answers
    // off-list, so the overlay still shows a real option (flagged low-confidence).
    function closestOption(text, options) {
        const t = text.toLowerCase();
        const tWords = new Set(t.split(/[^a-z0-9]+/).filter(Boolean));
        let best = null, bestScore = 0;
        for (const opt of options) {
            const o = opt.toLowerCase();
            let score = 0;
            for (const w of o.split(/[^a-z0-9]+/).filter(Boolean)) if (tWords.has(w)) score += 10;
            if (t && (t.includes(o) || o.includes(t))) score += 5;
            if (score > bestScore) { bestScore = score; best = opt; }
        }
        return bestScore > 0 ? best : null;
    }

    // Returns { fillText, reason, lowConfidence }. fillText is ALWAYS a clean answer:
    // an exact option for MC, or 1-3 words for open-ended — never the reason blob.
    function parseAnswer(answer, answerOptions) {
        const rawText   = (answer || "").replace(/\r/g, "");
        const lines     = rawText.split("\n").map(l => normalize(l)).filter(Boolean);
        const text      = normalize(rawText);
        const line1     = lines[0] || "";
        const restLines = lines.slice(1).join(" ").trim();

        if (answerOptions?.length) {                                   // ── multiple-choice ──
            const options = [...answerOptions].sort((a, b) => b.length - a.length);
            const cands   = [stripWrap(line1).toLowerCase(), line1.toLowerCase(), text.toLowerCase()];
            const pick = (test) => {
                for (const opt of options) {
                    const o = opt.toLowerCase();
                    if (!o) continue;
                    for (const c of cands) if (test(c, o)) return opt;
                }
                return null;
            };
            let option =
                pick((c, o) => c === o) ||
                pick((c, o) => startsWithWord(c, o)) ||
                pick((c, o) => {
                    const i = c.indexOf(o);
                    if (i === -1) return false;
                    const before = i === 0 || !/[a-z0-9]/i.test(c.charAt(i - 1));
                    return before && startsWithWord(c.slice(i), o);
                });
            let lowConfidence = false;
            if (!option) { option = closestOption(text, options); lowConfidence = true; }
            if (option) {
                const o = option.toLowerCase();
                let reason = "";
                const src = line1.toLowerCase().startsWith(o) ? line1
                          : text.toLowerCase().startsWith(o)  ? text : "";
                if (src) {
                    let rest = src.slice(option.length).trim().replace(/^[—–\-:.]\s*/, "").trim();
                    if (rest.toLowerCase().startsWith(o))
                        rest = rest.slice(option.length).trim().replace(/^[—–\-:.]\s*/, "").trim();
                    reason = rest;
                }
                if (!reason && restLines && line1.toLowerCase() === o) reason = restLines;
                return { fillText: option, reason: clampReason(reason), lowConfidence };
            }
            const fallback = stripWrap(line1 || text).split(/\s+/).slice(0, 4).join(" ");
            return { fillText: fallback, reason: clampReason(restLines), lowConfidence: true };
        }

        if (lines.length >= 2) {                                       // ── open-ended ──
            return { fillText: stripWrap(line1), reason: clampReason(restLines), lowConfidence: false };
        }
        const m = text.match(/^(.+?)\s+[—–-]\s+(.+)$/);
        if (m) return { fillText: stripWrap(m[1].trim()), reason: clampReason(m[2].trim()), lowConfidence: false };
        let fill = text;
        const sentence = text.match(/^(.*?[.!?])(\s|$)/);
        if (sentence && sentence[1].length <= 60) fill = sentence[1].replace(/[.!?]+$/, "").trim();
        if (fill.split(/\s+/).length > 3) fill = fill.split(/\s+/).slice(0, 3).join(" ");
        return { fillText: stripWrap(fill), reason: "", lowConfidence: false };
    }

    // Normalize a background response into { fillText, reason, lowConfidence, confidence, inRange }.
    // Structured answers are trusted; parseAnswer is the fallback for free-text / parse failures.
    function resolveResp(resp, ans) {
        if (resp && resp.answer && resp.inRange !== false) {
            const conf = (typeof resp.confidence === "number") ? resp.confidence : null;
            return {
                fillText: resp.answer,
                reason: clampReason(resp.reasoning || ""),
                lowConfidence: conf != null ? conf < VOTE_CONF : false,
                confidence: conf,
                inRange: true
            };
        }
        const p = parseAnswer((resp && resp.raw) || (resp && resp.answer) || "", ans);
        return {
            fillText: p.fillText, reason: p.reason, lowConfidence: true,
            confidence: (resp && typeof resp.confidence === "number") ? resp.confidence : null,
            inRange: false
        };
    }

    // ╔══════════════════════════════════════════════════════════════════════════╗
    // ║ EventBus — minimal publish/subscribe hub connecting the modules.          ║
    // ╚══════════════════════════════════════════════════════════════════════════╝
    class EventBus {
        constructor() { this._handlers = new Map(); }
        on(evt, fn)  { (this._handlers.get(evt) || this._handlers.set(evt, new Set()).get(evt)).add(fn); return () => this.off(evt, fn); }
        off(evt, fn) { this._handlers.get(evt)?.delete(fn); }
        emit(evt, payload) {
            const set = this._handlers.get(evt);
            if (!set) return;
            for (const fn of set) { try { fn(payload); } catch (e) { log("bus_err", { evt, error: String(e) }); } }
        }
        clear() { this._handlers.clear(); }
    }

    // ╔══════════════════════════════════════════════════════════════════════════╗
    // ║ CapturePipeline — screenshot service.                                      ║
    // ╚══════════════════════════════════════════════════════════════════════════╝
    class CapturePipeline {
        constructor({ hide, show }) { this._hide = hide; this._show = show; }

        // Resolves { dataUrl, error }. Waits (up to IMG_WAIT_MS) for large images to
        // finish loading, THEN hides the overlay so it isn't in the shot, and delegates
        // JPEG encoding to the background script.
        //
        // UX: the overlay (with its "Reading the screenshot…" spinner) stays fully visible
        // and live through the image-wait — hide() only fires right before the actual shot.
        // The old code hid it for the ENTIRE capture (up to IMG_WAIT_MS + native-capture
        // time), which reads as the extension itself freezing/vanishing for the better part
        // of a second. Now the invisible window is just one paint frame + settle + the
        // native chrome.tabs.captureVisibleTab round trip — the part that genuinely can't
        // be shortened, not the part we were free to keep visible.
        //
        // PERF: the common case (text/logo questions where the large images are already
        // decoded) takes ONE image scan and fires immediately — no polling, no upfront
        // frame wait (nothing is hidden yet, so there's nothing to wait on a paint for).
        // Only genuinely-loading images incur the ~80ms re-check loop, and the one
        // unavoidable requestAnimationFrame is spent right before the hide, where it's
        // actually needed (so the hide paints before the native capture reads the frame).
        capture() {
            return new Promise(resolve => {
                const deadline = Date.now() + IMG_WAIT_MS;
                const fire = () => {
                    this._hide();
                    requestAnimationFrame(() => setTimeout(() => {
                        runtimeSend({ action: "takeScreenshot" }, resp => {
                            this._show();
                            resolve({ dataUrl: resp?.dataUrl || null, error: resp?.error || null });
                        });
                    }, SCREENSHOT_SETTLE_MS));
                };
                const check = () => {
                    const pending = [...document.querySelectorAll("img")].some(img => {
                        if (img.closest("#" + OVERLAY_ID) || img.complete) return false;
                        const r = img.getBoundingClientRect();
                        return r.width > 180 && r.height > 130 && inViewport(r, 10);
                    });
                    if (!pending || Date.now() >= deadline) fire();
                    else setTimeout(check, SCREENSHOT_POLL_MS);
                };
                check();   // overlay stays visible through the wait; we only go dark right before the shot
            });
        }
    }

    // ╔══════════════════════════════════════════════════════════════════════════╗
    // ║ Solver — AI request orchestration against background.js.                   ║
    // ╚══════════════════════════════════════════════════════════════════════════╝
    class Solver {
        constructor({ capture, getNudge }) { this._capture = capture; this._getNudge = getNudge; }

        // Single background round-trip. Promise resolves with the normalized response.
        _ask(q, ans, image, { strict, temperature } = {}) {
            return new Promise(resolve => {
                const msg = { action: "askAI", question: q, answers: ans };
                if (image) msg.imageDataUrl = image;
                const nudge = (this._getNudge() || "").trim();
                if (nudge) msg.nudge = nudge;
                if (strict) msg.strict = true;
                if (typeof temperature === "number") msg.temperature = temperature;
                runtimeSend(msg, resolve);
            });
        }

        // Full solve. Returns { resolved, provider, usedImage } or null when superseded.
        // imageDataUrl bypasses vision routing (manual scan / re-ask already have a shot).
        async solve(q, ans, { imageDataUrl = null, onProgress = () => {}, isStale = () => false } = {}) {
            const isMC = ans.length >= 2;
            let image = imageDataUrl;

            if (!image && needsVision(q)) {
                onProgress("screenshot");
                const shot = await this._capture.capture();
                if (isStale()) return null;
                image = shot.dataUrl || null;   // null → best-effort text-only
            }

            onProgress(image ? "asking-vision" : "asking");
            log("call", { mode: image ? "vision" : "text" });
            let resp = await this._ask(q, ans, image);
            if (isStale()) return null;
            if (!resp || resp.error) throw new Error(resp?.error || "No response from AI");
            log("resp", { ans: resp.answer, idx: resp.answerIndex, conf: resp.confidence, prov: resp.provider });

            // Off-list / unparseable on MC → one strict, deterministic retry.
            if (isMC && (resp.parseError || resp.inRange === false)) {
                onProgress("strict");
                const r2 = await this._ask(q, ans, image, { strict: true });
                if (isStale()) return null;
                if (r2 && !r2.error) resp = r2;
            }

            let resolved = resolveResp(resp, ans);

            // Genuinely uncertain MC → self-consistency vote to raise the hit rate.
            if (isMC && resolved.inRange && resolved.confidence != null && resolved.confidence < VOTE_CONF) {
                onProgress("voting");
                const voted = await this._vote(q, ans, image, resp, isStale);
                if (isStale()) return null;
                if (voted) resolved = voted;
            }

            return { resolved, provider: resp.provider, usedImage: !!image };
        }

        // Draw extra samples at higher temperature and majority-vote the option index.
        async _vote(q, ans, image, firstResp, isStale) {
            log("vote", { samples: VOTE_SAMPLES });
            const tally = {};
            const record = r => {
                const i = r && Number.isInteger(r.answerIndex) ? r.answerIndex : -1;
                if (i >= 0) tally[i] = (tally[i] || 0) + 1;
            };
            record(firstResp);
            const extra = await Promise.all(
                Array.from({ length: VOTE_SAMPLES }, () => this._ask(q, ans, image, { temperature: VOTE_TEMP }))
            );
            if (isStale()) return null;
            let total = 1;
            for (const r of extra) { total++; if (r && !r.error) record(r); }
            let bestIdx = -1, bestCount = 0;
            for (const k in tally) if (tally[k] > bestCount) { bestCount = tally[k]; bestIdx = +k; }
            if (bestIdx < 0) return null;
            return {
                fillText: ans[bestIdx],
                reason: clampReason(firstResp.reasoning || ""),
                lowConfidence: bestCount <= total / 2,
                confidence: bestCount / total,
                inRange: true
            };
        }
    }

    // ╔══════════════════════════════════════════════════════════════════════════╗
    // ║ AnswerFiller — applies the chosen answer to the page.                      ║
    // ╚══════════════════════════════════════════════════════════════════════════╝
    class AnswerFiller {
        constructor() { this._answerEls = new Map(); }   // normKey(optionText) → live element

        // Snapshot option text → element at dispatch time, so click-time uses the exact
        // nodes that were on screen when the AI was asked (avoids a re-query race).
        capture() {
            this._answerEls = new Map();
            liveOptionEls().forEach(el => {
                const k = normKey(el.textContent || "");
                if (k && !this._answerEls.has(k)) this._answerEls.set(k, el);
            });
        }

        clickAnswer(text) {
            const want = normKey(text);
            if (!want) return false;
            const stored = this._answerEls.get(want);
            if (isLiveOption(stored)) { simulateClick(clickableFrom(stored)); return true; }

            const cands = liveOptionEls().map(el => ({ el, key: normKey(el.textContent || "") })).filter(c => c.key);
            let m =
                cands.find(c => c.key === want) ||
                cands.find(c => c.key.startsWith(want)) ||
                cands.find(c => want.startsWith(c.key) && c.key.length >= 4) ||
                cands.find(c => c.key.includes(want) || want.includes(c.key));
            if (!m) {
                let best = null, bestScore = 0.6;
                for (const c of cands) { const s = tokenOverlap(c.key, want); if (s > bestScore) { bestScore = s; best = c; } }
                m = best;
            }
            if (m) { simulateClick(clickableFrom(m.el)); return true; }
            return false;
        }

        // Multi-strategy click: exact → no leading article → no punctuation.
        _attemptClick(t) {
            if (this.clickAnswer(t)) return true;
            const noArticle = t.replace(/^(the|a|an)\s+/i, "").trim();
            if (noArticle !== t && this.clickAnswer(noArticle)) return true;
            const noPunct = t.replace(/[.,!?;:'"()]/g, "").trim();
            if (noPunct !== t && this.clickAnswer(noPunct)) return true;
            return false;
        }

        // Apply an answer. Promise resolves true on success. MC only ever clicks an
        // option (retries while buttons render, never types into a page search box);
        // open-ended types into the input, falling back to a button.
        fill(fillText, isMC) {
            return new Promise(resolve => {
                if (isMC) {
                    let tries = 0;
                    const tryClick = () => {
                        if (this._attemptClick(fillText)) {
                            log("fill", { ans: fillText, method: "click_btn" });
                            setTimeout(() => this.autoSubmit(), SUBMIT_INIT_MS);
                            resolve(true); return;
                        }
                        if (++tries < 8) { setTimeout(tryClick, 200); return; }
                        log("fill", { ans: fillText, method: "no_btn", tries });
                        resolve(false);
                    };
                    tryClick();
                    return;
                }
                const input = findTextInput();
                if (input) {
                    log("fill", { ans: fillText, method: "fill_input" });
                    fillInput(input, fillText);
                    setTimeout(() => this.autoSubmit(), 60);
                    resolve(true);
                } else if (this._attemptClick(fillText)) {
                    log("fill", { ans: fillText, method: "click_btn" });
                    setTimeout(() => this.autoSubmit(), SUBMIT_INIT_MS);
                    resolve(true);
                } else {
                    log("fill", { ans: fillText, method: "no_target" });
                    resolve(false);
                }
            });
        }

        // Retries — quiz.com sometimes takes a moment to enable the Try/Submit button.
        autoSubmit(retries) {
            if (retries === undefined) retries = SUBMIT_RETRIES;
            const btn = [...document.querySelectorAll("button")].find(el => {
                if (el.closest("#" + OVERLAY_ID) || el.disabled) return false;
                if (!inViewport(el.getBoundingClientRect())) return false;
                const t = normalize(el.innerText || el.textContent || "").toLowerCase();
                return ["try", "submit", "check"].some(w => t === w || t.startsWith(w + " "));
            });
            if (btn) { log("submit", { label: normalize(btn.textContent || "") }); simulateClick(btn); return; }
            const input = findTextInput();
            if (input) {
                log("submit", { method: "enter" });
                ["keydown", "keypress", "keyup"].forEach(type =>
                    input.dispatchEvent(new KeyboardEvent(type, {
                        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true
                    }))
                );
                return;
            }
            if (retries > 0) setTimeout(() => this.autoSubmit(retries - 1), SUBMIT_RETRY_MS);
            else log("submit", { method: "none" });
        }
    }

    // ╔══════════════════════════════════════════════════════════════════════════╗
    // ║ OverlayUI — the view (draggable/resizable overlay). No detection logic.    ║
    // ╚══════════════════════════════════════════════════════════════════════════╝
    const _STATUS = {
        idle:      { label: "Ready",                cls: "qa-s-idle" },
        detecting: { label: "Reading question…",    cls: "qa-s-busy" },
        waiting:   { label: "Waiting for options…", cls: "qa-s-busy" },
        asking:    { label: "Thinking…",            cls: "qa-s-busy" },
        answered:  { label: "Answer ready",         cls: "qa-s-ok"   },
        error:     { label: "Error",                cls: "qa-s-err"  },
        paused:    { label: "Paused",               cls: "qa-s-warn" }
    };

    class OverlayUI {
        constructor(handlers) {
            this.handlers = handlers;                 // { onClose, onPauseToggle, onRescan, onNudgeSubmit, onFill }
            this._questionVisible = false;
            this._fadeTimer = null;
            this._filling = false;
            this._isDragging = false; this._dragX = 0; this._dragY = 0;
            this._isResizing = false; this._rsX = 0; this._rsY = 0; this._rsW = 0; this._rsH = 0;
            this._style = null; this.overlay = null;
            this._onMouseMove = this._onMouseMove.bind(this);
            this._onMouseUp   = this._onMouseUp.bind(this);
        }

        get isResizing() { return this._isResizing; }

        // ── Mount / teardown ──
        mount() {
            if (!document.body) { setTimeout(() => this.mount(), 200); return; }
            if (this.overlay && document.body.contains(this.overlay)) return;
            this._injectStyle();
            this._build();
            document.body.appendChild(this.overlay);
            this._restore();
            this._wireControls();
            document.addEventListener("mousemove", this._onMouseMove);
            document.addEventListener("mouseup", this._onMouseUp);
        }

        destroy() {
            document.removeEventListener("mousemove", this._onMouseMove);
            document.removeEventListener("mouseup", this._onMouseUp);
            this.overlay?.remove();
            this._style?.remove();
            this.overlay = null;
        }

        _injectStyle() {
            if (this._style) return;
            this._style = document.createElement("style");
            this._style.textContent = OVERLAY_CSS;
            (document.head || document.documentElement).appendChild(this._style);
        }

        _build() {
            this.overlay = document.createElement("div");
            this.overlay.id = OVERLAY_ID;
            this.overlay.innerHTML = OVERLAY_HTML;
        }

        // ── Status / provider ──
        setStatus(key) {
            const el = document.getElementById("qa-status");
            if (!el) return;
            const s = _STATUS[key] || _STATUS.idle;
            el.className = s.cls || "";
            el.innerHTML = '<span class="qa-led"></span>';
            el.appendChild(document.createTextNode(s.label));
        }
        setProviderBadge(text) {
            const el = document.getElementById("qa-provider-badge");
            if (el) el.textContent = text;
        }
        clearAnswerAccent() {
            const card = document.querySelector(".qa-section--answer");
            if (card) card.classList.remove("qa-state-ok", "qa-state-warn", "qa-state-err");
        }
        setPausedVisual(paused) { this.overlay?.classList.toggle("qa-paused", paused); }
        setHidden(hidden) { if (this.overlay) this.overlay.style.visibility = hidden ? "hidden" : ""; }

        // Fades #qa-ai out, rebuilds via buildFn, fades in. Cancels any pending fade so a
        // stale question can't overwrite a newer one.
        _fadeAiTo(buildFn) {
            const el = document.getElementById("qa-ai");
            if (!el) return;
            if (this._fadeTimer) { clearTimeout(this._fadeTimer); this._fadeTimer = null; }
            el.style.opacity = "0"; el.style.transform = "translateY(4px)";
            this._fadeTimer = setTimeout(() => {
                this._fadeTimer = null;
                el.innerHTML = "";
                buildFn(el);
                requestAnimationFrame(() => { el.style.opacity = "1"; el.style.transform = "translateY(0)"; });
            }, 90);
        }

        showLoading(label) {
            this.setProviderBadge("");
            this.clearAnswerAccent();
            this._fadeAiTo(el => {
                const wrap = document.createElement("div"); wrap.className = "qa-loading";
                const sp = document.createElement("div"); sp.className = "qa-spinner";
                const txt = document.createElement("span"); txt.textContent = label || "Thinking…";
                wrap.appendChild(sp); wrap.appendChild(txt); el.appendChild(wrap);
            });
        }

        showError(msg) {
            this.setProviderBadge("");
            this.clearAnswerAccent();
            document.querySelector(".qa-section--answer")?.classList.add("qa-state-err");
            this._fadeAiTo(el => {
                const wrap = document.createElement("div"); wrap.className = "qa-answer-wrap";
                const err = document.createElement("div"); err.className = "qa-error";
                err.textContent = "⚠ " + msg;
                wrap.appendChild(err); el.appendChild(wrap);
            });
        }

        // Neutral resting state — used to clear a spinner when a solve is abandoned.
        showIdle(msg) {
            this.setProviderBadge("");
            this.clearAnswerAccent();
            this._fadeAiTo(el => {
                const span = document.createElement("span");
                span.className = "qa-idle";
                span.textContent = msg || "Ready — waiting for a question.";
                el.appendChild(span);
            });
        }

        // Render the question + options panels and pulse the answer card.
        renderQuestion(question, options, count) {
            this.mount();
            this.closeNudgePanel();
            this._filling = false;

            const qEl = document.getElementById("qa-question");
            const tsEl = document.getElementById("qa-timestamp");
            const oEl = document.getElementById("qa-options");
            if (qEl)  qEl.textContent = question || "Waiting for a question…";
            if (tsEl) tsEl.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            if (oEl) {
                oEl.innerHTML = "";
                if (options.length) {
                    options.forEach(a => { const li = document.createElement("li"); li.textContent = a; oEl.appendChild(li); });
                } else {
                    const li = document.createElement("li"); li.className = "qa-none";
                    li.textContent = "Open-ended — type your answer"; oEl.appendChild(li);
                }
            }
            this._applyQuestionVisibility();

            const ansEl = this.overlay.querySelector(".qa-section--answer");
            if (ansEl) { ansEl.classList.remove("qa-pulse"); requestAnimationFrame(() => ansEl.classList.add("qa-pulse")); }

            const cntEl = document.getElementById("qa-q-count");
            if (cntEl) { cntEl.style.display = count > 0 ? "" : "none"; cntEl.textContent = `#${count}`; }
        }

        // Present a resolved answer. `autoFill` clicks it automatically after a delay
        // (manual rescan); otherwise the user clicks the answer text to apply it.
        showAnswer(resolved, provider, usedImage, autoFill, options) {
            const NAMES = { claude: "Claude", openai: "ChatGPT", gemini: "Gemini", mistral: "Mistral" };
            const { fillText, reason, lowConfidence, confidence } = resolved;
            const isMC = options.length >= 2;

            const choiceMatch = (fillText || "").match(/^([A-Ea-e]|[1-9])\.?$/);
            const badge = choiceMatch ? fillText.replace(".", "").toUpperCase() : null;

            this.setProviderBadge(usedImage ? (NAMES[provider] || provider) + " 📷" : (NAMES[provider] || provider));

            const card = document.querySelector(".qa-section--answer");
            if (card) {
                card.classList.remove("qa-state-ok", "qa-state-warn", "qa-state-err");
                card.classList.add(lowConfidence ? "qa-state-warn" : "qa-state-ok");
            }

            this._fadeAiTo(el => {
                const wrap = document.createElement("div"); wrap.className = "qa-answer-wrap";
                const row = document.createElement("div"); row.className = "qa-answer-row";

                if (badge) {
                    const b = document.createElement("span"); b.className = "qa-badge"; b.textContent = badge; row.appendChild(b);
                }

                const textEl = document.createElement("span");
                textEl.className = "qa-answer-text"
                    + (fillText.length > 20 ? " qa-answer-text--sm" : "")
                    + (lowConfidence ? " qa-answer-text--guess" : "");
                textEl.textContent = badge ? (reason || fillText) : fillText;
                textEl.setAttribute("role", "button");
                textEl.tabIndex = 0;
                textEl.title = options.length ? "Select this answer on the page" : "Type this answer into the page";
                const requestFill = () => this._requestFill(textEl, fillText, isMC);
                textEl.addEventListener("click", requestFill);
                textEl.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); requestFill(); } });
                row.appendChild(textEl);

                if (confidence != null) {
                    const chip = document.createElement("span");
                    const pct = Math.round(confidence * 100);
                    let cls = "qa-chip--mid", word = "Likely";
                    if (confidence >= 0.85)          { cls = "qa-chip--ok";  word = "High"; }
                    else if (confidence < VOTE_CONF) { cls = "qa-chip--low"; word = "Best guess"; }
                    chip.className = "qa-chip " + cls;
                    chip.textContent = `${word} · ${pct}%`;
                    row.appendChild(chip);
                }
                wrap.appendChild(row);

                if (lowConfidence) {
                    const g = document.createElement("div"); g.className = "qa-guess-note";
                    g.textContent = "⚠ Best guess — verify before you submit."; wrap.appendChild(g);
                }
                if (reason && !badge) {
                    const r = document.createElement("div"); r.className = "qa-reason"; r.textContent = reason; wrap.appendChild(r);
                }
                if (!options.length) {
                    const h = document.createElement("div"); h.className = "qa-hint";
                    h.textContent = "📝 Open-ended — click the answer to type it in."; wrap.appendChild(h);
                }

                if (autoFill) setTimeout(requestFill, AUTOFILL_MS);
                el.appendChild(wrap);
            });
        }

        // Route a fill request through the controller; strike the answer through on success.
        _requestFill(textEl, fillText, isMC) {
            if (this._filling) return;
            this._filling = true;
            Promise.resolve(this.handlers.onFill(fillText, isMC)).then(ok => {
                this._filling = false;
                if (ok) textEl.classList.add("qa-filled");
            });
        }

        // ── Nudge panel ──
        getNudge() { return document.getElementById("qa-nudge-input")?.value || ""; }
        saveNudge() {
            const v = this.getNudge().trim();
            clearTimeout(this._nudgeSave);
            chrome.storage.local.set({ nudgeHint: v });
            this._updateNudgeIndicator();
        }
        closeNudgePanel() {
            document.getElementById("qa-nudge-panel")?.classList.add("qa-hidden");
            document.getElementById("qa-nudge-toggle")?.classList.remove("qa-active");
        }
        _updateNudgeIndicator() {
            const btn = document.getElementById("qa-nudge-toggle");
            const input = document.getElementById("qa-nudge-input");
            if (btn && input) btn.classList.toggle("qa-nudge-has-hint", !!input.value.trim());
        }

        // ── Question visibility toggle ──
        _applyQuestionVisibility() {
            const qs = document.getElementById("qa-question-section");
            const os = document.getElementById("qa-options-section");
            const btn = document.getElementById("qa-toggle");
            qs?.classList.toggle("qa-hidden", !this._questionVisible);
            os?.classList.toggle("qa-hidden", !this._questionVisible);
            if (btn) { btn.classList.toggle("qa-on", this._questionVisible); btn.setAttribute("aria-pressed", String(this._questionVisible)); }
        }

        // ── Controls wiring ──
        _wireControls() {
            const o = this.overlay;
            o.querySelector("#qa-pause").addEventListener("click", () => {
                const btn = document.getElementById("qa-pause");
                const paused = this.handlers.onPauseToggle();   // controller flips + returns new state
                btn.textContent = paused ? "▶" : "⏸";
                btn.title = paused ? "Resume auto-detection" : "Pause auto-detection";
                btn.setAttribute("aria-label", btn.title);
                this.setPausedVisual(paused);
            });
            o.querySelector("#qa-close").addEventListener("click", () => this.handlers.onClose());
            o.querySelector("#qa-min").addEventListener("click", () => {
                const c = document.getElementById("qa-content");
                if (c) c.style.display = c.style.display === "none" ? "" : "none";
            });
            o.querySelector("#qa-toggle").addEventListener("click", () => {
                this._questionVisible = !this._questionVisible;
                this._applyQuestionVisibility();
                try { sessionStorage.setItem("__sheja_showq", this._questionVisible ? "1" : "0"); } catch (e) {}
            });

            const header = o.querySelector("#qa-header");
            header.addEventListener("mousedown", e => {
                if (e.target.closest("#qa-controls")) return;
                this._isDragging = true;
                const rect = o.getBoundingClientRect();
                this._dragX = e.clientX - rect.left; this._dragY = e.clientY - rect.top;
                o.style.top = rect.top + "px"; o.style.left = rect.left + "px";
                o.style.right = "auto"; o.style.transform = "none";
                o.classList.add("qa-dragging");
                e.preventDefault();
            });
            o.querySelector("#qa-resize").addEventListener("mousedown", e => {
                this._isResizing = true;
                this._rsX = e.clientX; this._rsY = e.clientY;
                this._rsW = o.offsetWidth;
                const content = document.getElementById("qa-content");
                this._rsH = content ? content.offsetHeight : 300;
                o.classList.add("qa-dragging");
                e.preventDefault(); e.stopPropagation();
            });

            o.querySelector("#qa-scan-main").addEventListener("click", () => this.handlers.onRescan());

            o.querySelector("#qa-nudge-toggle").addEventListener("click", () => {
                const panel = document.getElementById("qa-nudge-panel");
                const btn = document.getElementById("qa-nudge-toggle");
                const open = panel.classList.toggle("qa-hidden") === false;
                btn.classList.toggle("qa-active", open);
                if (open) document.getElementById("qa-nudge-input")?.focus();
            });
            o.querySelector("#qa-nudge-input").addEventListener("input", () => {
                this._updateNudgeIndicator();
                clearTimeout(this._nudgeSave);
                this._nudgeSave = setTimeout(() => {
                    chrome.storage.local.set({ nudgeHint: (document.getElementById("qa-nudge-input")?.value || "").trim() });
                }, 600);
            });
            o.querySelector("#qa-nudge-input").addEventListener("keydown", e => {
                if (e.key !== "Enter" || e.shiftKey) return;
                e.preventDefault(); this.handlers.onNudgeSubmit();
            });
            o.querySelector("#qa-nudge-submit").addEventListener("click", () => this.handlers.onNudgeSubmit());
            o.querySelector("#qa-nudge-clear").addEventListener("click", () => {
                const input = document.getElementById("qa-nudge-input");
                if (input) input.value = "";
                clearTimeout(this._nudgeSave);
                chrome.storage.local.set({ nudgeHint: "" });
                this._updateNudgeIndicator();
                input?.focus();
            });

            chrome.storage.local.get("nudgeHint", data => {
                const input = document.getElementById("qa-nudge-input");
                if (input && data.nudgeHint) { input.value = data.nudgeHint; this._updateNudgeIndicator(); }
            });
        }

        _onMouseMove(e) {
            const o = this.overlay;
            if (!o) return;
            if (this._isDragging) {
                o.style.left = Math.max(0, Math.min(e.clientX - this._dragX, window.innerWidth  - o.offsetWidth))  + "px";
                o.style.top  = Math.max(0, Math.min(e.clientY - this._dragY, window.innerHeight - o.offsetHeight)) + "px";
            }
            if (this._isResizing) {
                const newW = Math.max(240, Math.min(window.innerWidth - 24, this._rsW + (e.clientX - this._rsX)));
                const newH = Math.max(120, Math.min(window.innerHeight * 0.88, this._rsH + (e.clientY - this._rsY)));
                o.style.width = newW + "px";
                const content = document.getElementById("qa-content");
                if (content) content.style.maxHeight = newH + "px";
            }
        }
        _onMouseUp() {
            if (this._isDragging) { this._isDragging = false; this.overlay?.classList.remove("qa-dragging"); this._savePosition(); }
            if (this._isResizing) { this._isResizing = false; this.overlay?.classList.remove("qa-dragging"); this._saveSize(); }
        }

        // ── Session persistence ──
        _savePosition() {
            try { sessionStorage.setItem("__sheja_pos", JSON.stringify({ top: this.overlay.style.top, left: this.overlay.style.left })); } catch (e) {}
        }
        _saveSize() {
            try {
                const content = document.getElementById("qa-content");
                sessionStorage.setItem("__sheja_size", JSON.stringify({ width: this.overlay.style.width, contentH: content?.style.maxHeight || "" }));
            } catch (e) {}
        }
        _restore() {
            try {
                const pos = JSON.parse(sessionStorage.getItem("__sheja_pos") || "null");
                if (pos?.left) { this.overlay.style.top = pos.top; this.overlay.style.left = pos.left; this.overlay.style.right = "auto"; this.overlay.style.transform = "none"; }
            } catch (e) {}
            try {
                const sz = JSON.parse(sessionStorage.getItem("__sheja_size") || "null");
                if (sz?.width) this.overlay.style.width = sz.width;
                if (sz?.contentH) { const c = document.getElementById("qa-content"); if (c) c.style.maxHeight = sz.contentH; }
            } catch (e) {}
            const saved = sessionStorage.getItem("__sheja_showq");
            if (saved !== null) this._questionVisible = saved === "1";
        }
    }

    // ╔══════════════════════════════════════════════════════════════════════════╗
    // ║ IngestionEngine — DOM (Plan A) + visual (Plan B) question ingestion.       ║
    // ╚══════════════════════════════════════════════════════════════════════════╝
    class IngestionEngine {
        constructor(bus) {
            this.bus = bus;
            this._paused = false;
            // Detection state
            this._candidateQ = "";
            this._candidateTimer = null;
            this._lastFingerprint = "";
            this._suppressed = "";              // just-answered fingerprint (skip until it changes)
            this._cooldownUntil = 0;
            this._detectSeq = 0;                // cancels superseded readiness gates
            this._gateTimer = null;
            // Current authoritative question (for the poll loop)
            this._currentQuestion = "";
            this._currentOptions = [];
            this._currentVisualKey = "";
            // MutationObserver — rAF-batched so we process at most once per frame.
            this._batch = new Set();            // deduped text this frame
            this._pendingTexts = [];            // recycled scratch array (GC-friendly)
            this._rafPending = false;
            this._seenNodes = new WeakSet();    // WeakMap-style guard: skip re-seen nodes, no leak
            this._observer = new MutationObserver(muts => this._onMutations(muts));
            // Visual/option poll — rAF loop, work throttled to VISUAL_POLL_MS.
            this._raf = null;
            this._lastPollAt = 0;
            this._running = false;
            // True for the (short) window a screenshot is actually being captured — see
            // CapturePipeline. Chrome's native tab-capture forces a compositor readback of
            // the whole page; running our own layout-forcing DOM scans (extractAnswers,
            // scanForCurrentQuestion, visualFingerprint) on the SAME thread at that exact
            // moment competes with it and visibly deepens the freeze the user sees (which in
            // turn makes any page-side countdown/timer skip ahead). Skipping this poll for
            // that one short window removes the contention without weakening detection —
            // Plan A (MutationObserver) stays live throughout as the safety net.
            this._capturing = false;
        }

        start() {
            this._running = true;
            this._observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
            this.bus.on("transitionStart", () => this.reset());
            this.bus.on("lifecycleReset", () => this.suppressCurrent());
            this.bus.on("captureStart", () => { this._capturing = true; });
            this.bus.on("captureEnd", () => { this._capturing = false; });
            this._raf = requestAnimationFrame(t => this._visualTick(t));
        }

        stop() {
            this._running = false;
            this._observer.disconnect();
            if (this._raf) cancelAnimationFrame(this._raf);
            this._cancelGate();
            if (this._candidateTimer) clearTimeout(this._candidateTimer);
            this._batch.clear();
            this._pendingTexts.length = 0;
        }

        setPaused(p) { this._paused = p; }

        // Full pipeline reset (on a predicted transition) — drop buffers so the NEXT
        // question is captured cleanly; clear the fingerprint so a still-visible question
        // can recover if the transition was a false positive.
        reset() {
            this._candidateQ = "";
            if (this._candidateTimer) { clearTimeout(this._candidateTimer); this._candidateTimer = null; }
            this._cancelGate();
            this._batch.clear();
            this._pendingTexts.length = 0;
            this._lastFingerprint = "";
        }

        // After an answer is chosen: suppress the exact just-answered question until it
        // changes; a genuinely new question still comes through immediately.
        suppressCurrent() {
            this._suppressed = this._lastFingerprint;
            this._cooldownUntil = performance.now() + RESET_COOLDOWN_MS;
            this._lastFingerprint = "";
            this._cancelGate();
        }

        _cancelGate() { if (this._gateTimer) { clearTimeout(this._gateTimer); this._gateTimer = null; } }

        // ── Plan A: DOM mutations ──
        _onMutations(mutations) {
            for (const m of mutations) {
                if (m.type === "characterData") {
                    const p = m.target.parentElement;
                    if (p && !p.closest("#" + OVERLAY_ID)) this._batch.add(normalize(m.target.textContent || ""));
                } else {
                    for (const node of m.addedNodes) {
                        if (this._seenNodes.has(node)) continue;
                        if (node.nodeType === Node.TEXT_NODE && !node.parentElement?.closest("#" + OVERLAY_ID)) {
                            this._seenNodes.add(node);
                            this._batch.add(normalize(node.textContent || ""));
                        } else if (node.nodeType === Node.ELEMENT_NODE && !node.closest?.("#" + OVERLAY_ID)) {
                            this._seenNodes.add(node);
                            this._batch.add(normalize(node.textContent || ""));
                        }
                    }
                }
            }
            if (!this._rafPending && this._batch.size > 0) {
                this._rafPending = true;
                requestAnimationFrame(() => this._processBatch());
            }
        }

        _processBatch() {
            this._rafPending = false;
            // Drain into the recycled array, then clear the Set (avoids per-frame allocation).
            this._pendingTexts.length = 0;
            for (const t of this._batch) this._pendingTexts.push(t);
            this._batch.clear();
            for (const t of this._pendingTexts) this._processText(t);
            this._pendingTexts.length = 0;
            if (this._candidateQ) this._scheduleFlush();
        }

        _processText(raw) {
            const text = normalize(raw);
            if (text.length < 8 || text.length > 300 || isJunk(text) || !looksLikeQuestion(text)) return;
            const deduped = dedupeQuestion(text);
            const clean = truncateAtQuestionMark(deduped, deduped.includes("?") ? extractAnswers() : []);
            if (clean.length < 8 || clean.trim().split(/\s+/).length < 3) return;
            if (isBetterCandidate(clean, this._candidateQ)) this._candidateQ = clean;
        }

        // Micro-debounce so partial hydration doesn't fire early. A complete ("?") stem
        // flushes fast; the readiness gate handles option-waiting separately.
        _scheduleFlush() {
            if (this._candidateTimer) clearTimeout(this._candidateTimer);
            const delay = this._candidateQ.trim().endsWith("?") ? DEBOUNCE_Q_MS : DEBOUNCE_MS;
            this._candidateTimer = setTimeout(() => {
                const q = this._candidateQ;
                this._candidateQ = "";
                this._candidateTimer = null;
                if (q) this._tryRecord(q);
            }, delay);
        }

        // ── Plan B: visual fingerprint + option-change poll (rAF, throttled) ──
        _visualTick(_ts) {
            if (!this._running) return;
            this._raf = requestAnimationFrame(t => this._visualTick(t));
            const now = performance.now();
            if (now - this._lastPollAt < VISUAL_POLL_MS) return;   // throttle real work
            this._lastPollAt = now;
            if (this._paused || !this._currentQuestion || now < this._cooldownUntil || this._capturing) return;

            const current = extractAnswers();
            const freshQ = scanForCurrentQuestion() || this._currentQuestion;
            const currentVisualKey = needsVision(freshQ) ? visualFingerprint() : "";
            const sameAnswers = current.join("|") === this._currentOptions.join("|");
            const sameVisual = currentVisualKey === this._currentVisualKey;
            // Nothing actionable, or nothing changed (e.g. a decorative image swap).
            if ((current.length < 2 && !currentVisualKey) || (sameAnswers && sameVisual)) return;
            // A new flag with the SAME question text, or new options → re-detect.
            this._tryRecord(freshQ);
        }

        // ── Shared detection entry (from both plans) ──
        _tryRecord(questionText) {
            if (this._paused) return;
            const answers = extractAnswers();
            const question = truncateAtQuestionMark(dedupeQuestion(questionText), answers);
            if (question.length < 8) return;
            if (performance.now() < this._cooldownUntil) return;

            const visualKey = needsVision(question) ? visualFingerprint() : "";
            // Fingerprint excludes options so [] → [4 options] is ONE question; the
            // readiness gate handles option-waiting.
            const fingerprint = question + "\n" + visualKey;
            if (fingerprint === this._suppressed) return;      // just-answered, unchanged
            this._suppressed = "";                             // any different question clears suppression
            if (fingerprint === this._lastFingerprint) return; // dedupe

            this._lastFingerprint = fingerprint;               // claim immediately (re-entry short-circuits)
            const seq = ++this._detectSeq;
            this._cancelGate();
            // Provisional emit so the overlay shows the question text right away.
            this.bus.emit("question:detecting", { question, options: answers.length >= 2 ? answers : [] });
            this._waitForSurface(question, visualKey, seq, performance.now());
        }

        // Poll until the answer surface exists, then emit questionDetected exactly once.
        _waitForSurface(question, visualKey, seq, startedAt) {
            if (seq !== this._detectSeq) return;               // superseded
            const elapsed = performance.now() - startedAt;
            const surface = classifyAnswerSurface(question, elapsed);
            if (surface.kind !== "none") { this._emitDetected(question, visualKey, surface, seq); return; }
            if (elapsed >= GATE_MAX_MS) {                       // give up — best effort
                const btns = extractAnswers();
                this._emitDetected(question, visualKey, btns.length >= 2 ? { kind: "mc", answers: btns } : { kind: "open", answers: [] }, seq);
                return;
            }
            this.bus.emit("question:waiting", {});
            this._gateTimer = setTimeout(() => this._waitForSurface(question, visualKey, seq, startedAt), GATE_INTERVAL_MS);
        }

        _emitDetected(question, visualKey, surface, seq) {
            if (seq !== this._detectSeq) return;
            this._gateTimer = null;
            this._currentQuestion = question;
            this._currentOptions = surface.answers;
            this._currentVisualKey = visualKey;
            this.bus.emit("questionDetected", { question, options: surface.answers, visualKey, timestamp: Date.now() });
        }
    }

    // ╔══════════════════════════════════════════════════════════════════════════╗
    // ║ TransitionSensor — predictive next-question detection.                     ║
    // ╚══════════════════════════════════════════════════════════════════════════╝
    class TransitionSensor {
        constructor(bus) {
            this.bus = bus;
            this._interval = null;
            this._loaderWasPresent = false;
            this._lastH = null; this._lastW = null;
            this._refractoryUntil = 0;
            this._capturing = false;   // see IngestionEngine._capturing — same reasoning
        }
        start() {
            this._interval = setInterval(() => this._tick(), TRANSITION_POLL_MS);
            this.bus.on("captureStart", () => { this._capturing = true; });
            this.bus.on("captureEnd", () => { this._capturing = false; });
        }
        stop()  { if (this._interval) { clearInterval(this._interval); this._interval = null; } }

        _container() { return document.querySelector("main, article, [role='main']") || document.body; }

        _loaderPresent() {
            const els = document.querySelectorAll("[role='progressbar'], .loader, .skeleton, .spinner");
            for (const el of els) {
                if (el.closest("#" + OVERLAY_ID)) continue;
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0 && inViewport(r, 50)) return true;
            }
            return false;
        }

        _emit(type) {
            const now = performance.now();
            if (now < this._refractoryUntil) return;
            this._refractoryUntil = now + TRANSITION_REFRACTORY_MS;
            this.bus.emit("transitionStart", { type, timestamp: Date.now() });
        }

        _tick() {
            if (this._capturing) return;   // don't fight the native screenshot for the main thread
            // Primary, reliable signal: a loader/skeleton appearing (rising edge).
            const loader = this._loaderPresent();
            if (loader && !this._loaderWasPresent) this._emit("loader");
            this._loaderWasPresent = loader;

            // Secondary heuristic: a large layout shift of the main content container.
            const c = this._container();
            if (!c) return;
            const r = c.getBoundingClientRect();
            if (this._lastH != null &&
                (Math.abs(r.height - this._lastH) > LAYOUT_SHIFT_PX || Math.abs(r.width - this._lastW) > LAYOUT_SHIFT_PX)) {
                this._emit("layout");
            }
            this._lastH = r.height; this._lastW = r.width;
        }
    }

    // ╔══════════════════════════════════════════════════════════════════════════╗
    // ║ EventLifecycleManager — capture-phase click interception.                  ║
    // ╚══════════════════════════════════════════════════════════════════════════╝
    class EventLifecycleManager {
        constructor(bus, getOptions) {
            this.bus = bus;
            this._getOptions = getOptions;                 // () => current option strings
            this._onClick = this._onClick.bind(this);
        }
        start() { document.addEventListener("click", this._onClick, true); }   // capture phase = earliest
        stop()  { document.removeEventListener("click", this._onClick, true); }

        _onClick(e) {
            const el = clickableFrom(e.target);
            if (!el || el.closest("#" + OVERLAY_ID)) return;   // overlay clicks handled by the view
            const r = el.getBoundingClientRect();
            if (r.width < 60 || r.height < 20) return;         // answer-like size gate
            const key = normKey(el.textContent || "");
            if (!key) return;
            const opts = this._getOptions() || [];
            const isAnswer = opts.some(o => {
                const k = normKey(o);
                return k && (k === key || key.startsWith(k) || k.startsWith(key) || tokenOverlap(k, key) >= 0.6);
            });
            if (isAnswer) this.bus.emit("lifecycleReset", { timestamp: Date.now() });
        }
    }

    // ╔══════════════════════════════════════════════════════════════════════════╗
    // ║ Orchestrator — owns state + back-pressure and wires everything together.   ║
    // ╚══════════════════════════════════════════════════════════════════════════╝
    class Orchestrator {
        constructor() {
            this.bus = new EventBus();
            this.reqId = 0;                 // back-pressure: discards stale AI responses
            this._loading = false;
            this._paused = false;
            this.questionCount = 0;
            this.currentQuestion = "";
            this.currentOptions = [];
            this.currentVisualKey = "";
            this._lastAnswerAt = 0;

            this.overlay = new OverlayUI({
                onClose:       () => this.destroy(),
                onPauseToggle: () => this._togglePause(),
                onRescan:      () => this.onRescan(),
                onNudgeSubmit: () => this.onNudgeSubmit(),
                onFill:        (t, isMC) => this.onFill(t, isMC)
            });
            // captureStart/captureEnd bracket the ENTIRE native-capture window (overlay-hide
            // through image-wait through the actual chrome.tabs.captureVisibleTab round trip)
            // so IngestionEngine/TransitionSensor can go quiet for that one short stretch —
            // see their _capturing fields for why.
            this.capture = new CapturePipeline({
                hide: () => { this.overlay.setHidden(true); this.bus.emit("captureStart"); },
                show: () => { this.overlay.setHidden(false); this.bus.emit("captureEnd"); }
            });
            this.solver = new Solver({ capture: this.capture, getNudge: () => this.overlay.getNudge() });
            this.filler = new AnswerFiller();
            this.ingestion = new IngestionEngine(this.bus);
            this.transition = new TransitionSensor(this.bus);
            this.lifecycle = new EventLifecycleManager(this.bus, () => this.currentOptions);
        }

        start() {
            this.overlay.mount();
            this.overlay.setStatus("idle");
            this.bus.on("question:detecting", p => this._onDetecting(p));
            this.bus.on("question:waiting",   () => { if (this._loading) this.overlay.setStatus("waiting"); });
            this.bus.on("questionDetected",   p => this.onQuestionDetected(p));
            this.bus.on("transitionStart",    p => this.onTransition(p));
            this.bus.on("lifecycleReset",     p => this.onReset(p));
            this.ingestion.start();
            this.transition.start();
            this.lifecycle.start();
        }

        destroy() {
            this.ingestion.stop();
            this.transition.stop();
            this.lifecycle.stop();
            this.overlay.destroy();
            this.bus.clear();
        }

        _togglePause() {
            this._paused = !this._paused;
            this.ingestion.setPaused(this._paused);
            if (this._paused) {
                this.reqId++;                  // abandon any in-flight solve
                if (this._loading) { this._loading = false; this.overlay.showIdle("Paused."); }
                this.overlay.setStatus("paused");
            } else {
                this.overlay.setStatus("idle");
            }
            return this._paused;
        }

        // Provisional: show the question text as soon as it's found (before options settle).
        _onDetecting({ question, options }) {
            if (this._paused) return;
            this.questionCount++;
            this.currentQuestion = question;
            this.currentOptions = options;
            this.overlay.renderQuestion(question, options, this.questionCount);
            this.overlay.setStatus("detecting");
            this._loading = true;
            this.overlay.showLoading("Reading question…");
        }

        // Answer surface is ready → run the AI with back-pressure.
        onQuestionDetected({ question, options, visualKey }) {
            if (this._paused) return;
            const myId = ++this.reqId;
            this.currentQuestion = question;
            this.currentOptions = options;
            this.currentVisualKey = visualKey;
            this.filler.capture();                                  // snapshot option nodes for click-time
            this.overlay.renderQuestion(question, options, this.questionCount);
            this.overlay.setStatus("asking");
            this._loading = true;
            this.overlay.showLoading(needsVision(question) ? "Reading the screenshot…" : "Thinking…");
            log("question", { q: question, opts: options, count: this.questionCount });
            this._solve(question, options, myId, { autoFill: false });
        }

        _solve(question, options, myId, { imageDataUrl = null, autoFill = false } = {}) {
            this.solver.solve(question, options, {
                imageDataUrl,
                onProgress: s => this._onProgress(s),
                isStale: () => myId !== this.reqId
            }).then(res => {
                if (myId !== this.reqId || !res) return;
                this._loading = false;
                this.overlay.setStatus("answered");
                this.overlay.showAnswer(res.resolved, res.provider, res.usedImage, autoFill, options);
            }).catch(err => {
                if (myId !== this.reqId) return;
                this._loading = false;
                this.overlay.setStatus("error");
                this.overlay.showError(err.message || "AI error");
                log("err", { error: err.message });
            });
        }

        _onProgress(stage) {
            const MAP = {
                screenshot:     "Reading the screenshot…",
                "asking-vision":"Reading the screenshot…",
                asking:         "Thinking…",
                strict:         "Double-checking…",
                voting:         "Verifying answer…"
            };
            this.overlay.showLoading(MAP[stage] || "Thinking…");
        }

        // A transition was predicted. Ingestion resets its own pipeline (via its
        // subscription) so the NEXT question is captured cleanly. We deliberately do NOT
        // cancel an in-flight solve here: if a real new question follows, its detection
        // supersedes the old one via reqId (no stale answer lands); if this was a false
        // positive (layout jitter with no new question), the in-flight answer still
        // arrives instead of leaving a hung spinner. Back-pressure, not eager cancel.
        onTransition({ type }) {
            log("transition", { type });
            if (!this._loading) this.overlay.clearAnswerAccent();   // shown answer reads as stale
        }

        // An answer was chosen (by us or the user) — the user has moved on, so abandon any
        // in-flight solve for this question rather than waste an answer they won't use.
        onReset() {
            log("reset", {});
            this._lastAnswerAt = Date.now();
            if (this._loading) {
                this.reqId++;
                this._loading = false;
                this.overlay.setStatus("idle");
                this.overlay.showIdle("Answer selected.");
            }
        }

        // Apply the AI's answer to the page. suppressCurrent() also covers open-ended,
        // where no page answer-click fires the lifecycle reset.
        onFill(fillText, isMC) {
            return this.filler.fill(fillText, isMC).then(ok => {
                if (ok) { this.ingestion.suppressCurrent(); this._lastAnswerAt = Date.now(); }
                return ok;
            });
        }

        // Manual "Re-ask AI" — always screenshots and auto-fills.
        onRescan() {
            const scannedQ = scanForCurrentQuestion();
            const freshQ = scannedQ || this.currentQuestion || "";
            const freshA = extractAnswers();
            const sameQ = scannedQ && scannedQ === this.currentQuestion;
            const sameVis = visualFingerprint() === this.currentVisualKey;
            const scanAns = freshA.length >= 2 ? freshA : (sameQ && sameVis ? this.currentOptions : []);

            const myId = ++this.reqId;
            this.currentQuestion = freshQ;
            this.currentOptions = scanAns;
            this.filler.capture();
            this.overlay.renderQuestion(freshQ, scanAns, this.questionCount);
            this.overlay.setStatus("asking");
            this._loading = true;
            this.overlay.showLoading("Scanning screen…");
            log("call", { mode: "manual-scan" });

            this.capture.capture().then(({ dataUrl, error }) => {
                if (myId !== this.reqId) return;
                if (!dataUrl) {
                    this._loading = false;
                    this.overlay.setStatus("error");
                    this.overlay.showError(error || "Screenshot failed — check extension permissions");
                    return;
                }
                this._solve(freshQ || "What is shown in this image?", scanAns, myId, { imageDataUrl: dataUrl, autoFill: true });
            });
        }

        // Nudge submitted — re-ask the current question with the hint (no auto-fill).
        onNudgeSubmit() {
            this.overlay.saveNudge();
            this.overlay.closeNudgePanel();
            if (!this.currentQuestion) return;
            const freshA = extractAnswers();
            const ans = freshA.length >= 2 ? freshA : this.currentOptions;
            const myId = ++this.reqId;
            this.currentOptions = ans;
            this.filler.capture();
            this.overlay.setStatus("asking");
            this._loading = true;
            this.overlay.showLoading("Re-asking with your hint…");
            log("call", { mode: "nudge" });
            this._solve(this.currentQuestion, ans, myId, { autoFill: false });
        }
    }

    // ╔══════════════════════════════════════════════════════════════════════════╗
    // ║ Overlay markup + styles (unchanged look; kept out of the class for clarity)║
    // ╚══════════════════════════════════════════════════════════════════════════╝
    const OVERLAY_CSS = `
    #qa-overlay {
        --qa-bg: rgba(14, 12, 28, 0.97);
        --qa-surface: rgba(255,255,255,.045);
        --qa-border: rgba(132,112,255,.20);
        --qa-border-strong: rgba(132,112,255,.42);
        --qa-text: #ece9f8;
        --qa-text-dim: #a39ecb;
        --qa-text-faint: #726d9e;
        --qa-accent: #8b6dff;
        --qa-accent-2: #bb93ff;
        --qa-ok: #46e3a0;
        --qa-warn: #ffce5c;
        --qa-err: #ff7d8a;

        position: fixed; top: 50%; right: 20px; transform: translateY(-50%);
        width: min(340px, calc(100vw - 24px));
        background: var(--qa-bg);
        -webkit-backdrop-filter: blur(26px) saturate(1.5);
        backdrop-filter: blur(26px) saturate(1.5);
        border: 1px solid var(--qa-border);
        border-radius: 18px;
        z-index: 2147483647 !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
        font-size: 13px !important; color: var(--qa-text) !important;
        box-shadow: 0 28px 70px rgba(0,0,0,.66), 0 0 0 1px rgba(132,112,255,.05),
                    inset 0 1px 0 rgba(255,255,255,.06);
        overflow: hidden; transition: box-shadow .2s, opacity .2s;
    }
    #qa-overlay.qa-dragging { box-shadow: 0 40px 90px rgba(0,0,0,.72); }
    #qa-overlay.qa-paused { opacity: .94; }
    #qa-overlay * { box-sizing: border-box !important; line-height: normal !important; }
    #qa-overlay :focus-visible {
        outline: 2px solid var(--qa-accent-2) !important; outline-offset: 2px !important; border-radius: 7px;
    }

    #qa-header {
        display: flex; align-items: center; gap: 8px;
        padding: 11px 11px 11px 14px;
        background: linear-gradient(135deg, #5a44d6 0%, #7d5ae6 55%, #a877ec 100%);
        border-bottom: 1px solid rgba(0,0,0,.22);
        cursor: grab; user-select: none;
    }
    #qa-overlay.qa-paused #qa-header { background: linear-gradient(135deg, #4a4a5e, #6c6c86); }
    #qa-header:active { cursor: grabbing; }
    #qa-title {
        font-weight: 800 !important; font-size: 13.5px !important; color: #fff !important;
        white-space: nowrap; display: flex; align-items: center; gap: 6px;
        text-shadow: 0 1px 4px rgba(0,0,0,.3); flex-shrink: 0; letter-spacing: -.1px;
    }
    #qa-q-count {
        font-size: 10px !important; font-weight: 700 !important;
        background: rgba(0,0,0,.26); color: rgba(255,255,255,.85) !important;
        border-radius: 7px; padding: 1px 6px;
    }
    #qa-status {
        flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
        font-size: 11px !important; font-weight: 700 !important;
        color: rgba(255,255,255,.62) !important; white-space: nowrap; overflow: hidden;
    }
    #qa-status .qa-led { width: 7px; height: 7px; border-radius: 50%; background: currentColor;
        box-shadow: 0 0 6px currentColor; flex-shrink: 0; }
    #qa-status.qa-s-busy { color: #fff !important; }
    #qa-status.qa-s-busy .qa-led { animation: qa-pulse-led 1s ease-in-out infinite; }
    #qa-status.qa-s-ok   { color: #b9ffe0 !important; }
    #qa-status.qa-s-warn { color: #ffe6a6 !important; }
    #qa-status.qa-s-err  { color: #ffc0c6 !important; }
    @keyframes qa-pulse-led { 0%,100%{opacity:.35} 50%{opacity:1} }

    #qa-controls { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }
    .qa-icon-btn {
        background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.16);
        color: #fff !important; width: 26px; height: 26px; border-radius: 8px;
        cursor: pointer; font-size: 12px !important; font-weight: 700 !important;
        display: flex; align-items: center; justify-content: center;
        transition: background .15s, border-color .15s; flex-shrink: 0; padding: 0;
    }
    .qa-icon-btn:hover { background: rgba(255,255,255,.26); border-color: rgba(255,255,255,.34); }
    .qa-icon-btn.qa-on { background: #fff; color: #5a44d6 !important; border-color: #fff; }

    #qa-content {
        max-height: calc(86vh - 52px); overflow-y: auto;
        padding: 11px; display: flex; flex-direction: column; gap: 9px;
    }
    #qa-content::-webkit-scrollbar { width: 6px; }
    #qa-content::-webkit-scrollbar-thumb { background: rgba(132,112,255,.34); border-radius: 6px; }

    .qa-section {
        background: var(--qa-surface); border-radius: 13px;
        padding: 10px 12px; border: 1px solid var(--qa-border);
    }
    .qa-hidden { display: none !important; }
    .qa-label {
        font-size: 10px !important; font-weight: 800 !important;
        letter-spacing: .8px; color: var(--qa-text-dim) !important;
        margin-bottom: 7px; text-transform: uppercase;
        display: flex; align-items: center; justify-content: space-between; gap: 6px;
    }
    .qa-provider-badge {
        font-size: 10px !important; font-weight: 700 !important;
        background: rgba(132,112,255,.16); color: var(--qa-accent-2) !important;
        border: 1px solid rgba(132,112,255,.28); border-radius: 6px; padding: 1px 7px;
        text-transform: none; letter-spacing: 0;
    }

    #qa-question {
        line-height: 1.6 !important; color: var(--qa-text) !important;
        font-size: 13.5px !important; font-weight: 500 !important;
    }
    #qa-timestamp {
        font-size: 10px !important; color: var(--qa-text-faint) !important; font-weight: 600 !important;
        text-transform: none; letter-spacing: 0;
    }
    #qa-options {
        list-style: none !important; margin: 0 !important; padding: 0 !important;
        display: flex; flex-direction: column; gap: 5px;
    }
    #qa-options li {
        background: rgba(132,112,255,.08); border: 1px solid rgba(132,112,255,.14);
        border-radius: 8px; padding: 6px 10px;
        color: var(--qa-text) !important; font-size: 12.5px !important; font-weight: 500 !important;
    }
    #qa-options li::before { content: "› "; color: var(--qa-accent) !important; font-weight: 700 !important; }
    #qa-options li.qa-none {
        color: var(--qa-text-faint) !important; font-style: italic; font-size: 12px !important;
        background: transparent !important; border: none !important; padding: 2px 0 !important;
    }
    #qa-options li.qa-none::before { content: none !important; }

    .qa-section--answer {
        background: var(--qa-surface); border: 1px solid var(--qa-border);
        transition: border-color .35s, background .35s, box-shadow .35s;
    }
    .qa-section--answer.qa-state-ok   { background: rgba(70,227,160,.06); border-color: rgba(70,227,160,.32); }
    .qa-section--answer.qa-state-warn { background: rgba(255,206,92,.06);  border-color: rgba(255,206,92,.34); }
    .qa-section--answer.qa-state-err  { background: rgba(255,125,138,.06); border-color: rgba(255,125,138,.34); }
    .qa-section--answer .qa-label { color: var(--qa-text-dim) !important; }
    .qa-section--answer.qa-state-ok   .qa-label { color: var(--qa-ok) !important; }
    .qa-section--answer.qa-state-warn .qa-label { color: var(--qa-warn) !important; }
    .qa-section--answer.qa-pulse { animation: qa-pulse-in .5s ease; }
    @keyframes qa-pulse-in {
        0%   { box-shadow: 0 0 0 0 rgba(132,112,255,0); }
        45%  { box-shadow: 0 0 0 4px rgba(132,112,255,.16); }
        100% { box-shadow: 0 0 0 0 rgba(132,112,255,0); }
    }

    #qa-ai {
        min-height: 28px; display: flex; flex-direction: column; gap: 9px;
        transition: opacity .16s ease, transform .16s ease;
    }
    .qa-idle { color: var(--qa-text-faint) !important; font-size: 12.5px !important; padding: 3px 0; }

    .qa-loading {
        display: flex; align-items: center; gap: 10px; padding: 3px 0;
        color: var(--qa-text-dim) !important; font-size: 12.5px !important; font-weight: 600 !important;
    }
    .qa-spinner {
        width: 16px; height: 16px; border-radius: 50%; flex-shrink: 0;
        border: 2px solid rgba(132,112,255,.25); border-top-color: var(--qa-accent-2);
        animation: qa-spin .7s linear infinite;
    }
    @keyframes qa-spin { to { transform: rotate(360deg); } }

    .qa-answer-wrap {
        display: flex; flex-direction: column; gap: 8px;
        animation: qa-appear .26s cubic-bezier(.34,1.56,.64,1);
    }
    @keyframes qa-appear {
        from { opacity: 0; transform: translateY(6px) scale(.98); }
        to   { opacity: 1; transform: none; }
    }
    .qa-answer-row { display: flex; align-items: center; gap: 10px; }
    .qa-badge {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 38px; height: 38px; padding: 0 7px; flex-shrink: 0;
        background: linear-gradient(135deg, #5a44d6, #9a6cf0);
        color: #fff !important; font-size: 19px !important; font-weight: 900 !important;
        border-radius: 11px; box-shadow: 0 5px 14px rgba(90,68,214,.42);
    }
    .qa-answer-text {
        color: var(--qa-ok) !important; font-weight: 800 !important;
        font-size: 20px !important; line-height: 1.2 !important; cursor: pointer;
        letter-spacing: -.2px; border-radius: 7px; flex: 1;
    }
    .qa-answer-text:hover { color: #74ffc4 !important; text-decoration: underline; }
    .qa-answer-text--sm { font-size: 15px !important; letter-spacing: 0; }
    .qa-answer-text--guess { color: var(--qa-warn) !important; }
    .qa-answer-text--guess:hover { color: #ffe08a !important; }
    .qa-answer-text.qa-filled { opacity: .32 !important; text-decoration: line-through !important; cursor: default !important; }

    .qa-chip {
        flex-shrink: 0; font-size: 10px !important; font-weight: 800 !important;
        border-radius: 999px; padding: 2px 9px;
    }
    .qa-chip--ok  { background: rgba(70,227,160,.16);  color: var(--qa-ok) !important;       border: 1px solid rgba(70,227,160,.3); }
    .qa-chip--mid { background: rgba(132,112,255,.16); color: var(--qa-accent-2) !important; border: 1px solid rgba(132,112,255,.3); }
    .qa-chip--low { background: rgba(255,206,92,.14);  color: var(--qa-warn) !important;     border: 1px solid rgba(255,206,92,.32); }

    .qa-guess-note {
        font-size: 11px !important; color: var(--qa-warn) !important; font-weight: 600 !important;
        background: rgba(255,206,92,.08); border: 1px solid rgba(255,206,92,.2);
        border-radius: 7px; padding: 5px 10px;
    }
    .qa-reason { color: var(--qa-text-dim) !important; font-size: 12px !important; line-height: 1.5 !important; }
    .qa-hint {
        font-size: 11.5px !important; color: var(--qa-ok) !important; font-weight: 600 !important;
        background: rgba(70,227,160,.07); border: 1px solid rgba(70,227,160,.18);
        border-radius: 7px; padding: 5px 10px;
    }
    .qa-error {
        color: var(--qa-err) !important; font-size: 12.5px !important; font-weight: 600 !important;
        background: rgba(255,125,138,.08); border: 1px solid rgba(255,125,138,.24);
        border-radius: 8px; padding: 8px 11px;
    }

    #qa-footer { display: flex; gap: 7px; align-items: stretch; }
    .qa-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        padding: 9px 12px; border-radius: 10px;
        font-size: 12.5px !important; font-weight: 700 !important;
        cursor: pointer; transition: background .15s, transform .1s, border-color .15s;
        border: 1px solid transparent; line-height: 1 !important;
    }
    .qa-btn:hover:not(:disabled) { transform: translateY(-1px); }
    .qa-btn:active:not(:disabled) { transform: translateY(0); }
    .qa-btn:disabled { opacity: .45; cursor: default; transform: none; }

    .qa-btn--scan {
        flex: 1; background: rgba(132,112,255,.2); color: #d8d0ff !important;
        border-color: rgba(132,112,255,.34);
    }
    .qa-btn--scan:hover:not(:disabled) { background: rgba(132,112,255,.32); border-color: var(--qa-border-strong); }

    .qa-btn--nudge {
        position: relative; background: rgba(255,255,255,.05); color: var(--qa-text-dim) !important;
        border-color: rgba(255,255,255,.1); padding: 9px 12px;
    }
    .qa-btn--nudge:hover:not(:disabled) { background: rgba(255,255,255,.12); color: var(--qa-text) !important; }
    .qa-btn--nudge.qa-active { background: rgba(132,112,255,.2); color: #d8d0ff !important; border-color: rgba(132,112,255,.34); }
    .qa-btn--nudge.qa-nudge-has-hint::after {
        content: ""; position: absolute; top: 5px; right: 5px; width: 6px; height: 6px;
        border-radius: 50%; background: var(--qa-ok); box-shadow: 0 0 5px rgba(70,227,160,.7);
    }

    #qa-nudge-panel {
        display: flex; flex-direction: column; gap: 7px;
        background: var(--qa-surface); border: 1px solid var(--qa-border);
        border-radius: 13px; padding: 10px; animation: qa-appear .2s ease;
    }
    #qa-nudge-input {
        width: 100% !important; background: rgba(132,112,255,.08) !important;
        border: 1px solid rgba(132,112,255,.22) !important; border-radius: 9px !important;
        color: var(--qa-text) !important; font-size: 12.5px !important; font-family: inherit !important;
        padding: 8px 10px !important; resize: none !important; line-height: 1.5 !important;
        outline: none !important; transition: border-color .15s, background .15s;
    }
    #qa-nudge-input:focus { border-color: var(--qa-border-strong) !important; background: rgba(132,112,255,.12) !important; }
    #qa-nudge-input::placeholder { color: var(--qa-text-faint) !important; }
    .qa-nudge-foot { display: flex; align-items: center; gap: 6px; }
    .qa-nudge-meta { flex: 1; font-size: 10px !important; color: var(--qa-text-faint) !important; }
    .qa-btn--nudge-clear {
        background: rgba(255,255,255,.05); color: var(--qa-text-dim) !important;
        border: 1px solid rgba(255,255,255,.1); padding: 5px 10px; border-radius: 7px; flex-shrink: 0;
        font-size: 11px !important; font-weight: 600 !important; cursor: pointer; transition: background .15s, color .15s;
    }
    .qa-btn--nudge-clear:hover { background: rgba(255,125,138,.14); color: var(--qa-err) !important; border-color: rgba(255,125,138,.3); }
    .qa-btn--nudge-submit {
        background: linear-gradient(135deg, #5a44d6, #7d5ae6); color: #fff !important; border: none;
        padding: 5px 12px; border-radius: 7px; flex-shrink: 0;
        font-size: 11px !important; font-weight: 700 !important; cursor: pointer; transition: opacity .15s;
        box-shadow: 0 2px 8px rgba(90,68,214,.4);
    }
    .qa-btn--nudge-submit:hover { opacity: .88; }

    #qa-resize { position: absolute; bottom: 0; right: 0; width: 20px; height: 20px; cursor: nwse-resize; z-index: 10; }
    #qa-resize::after {
        content: ""; position: absolute; right: 5px; bottom: 5px; width: 7px; height: 7px;
        border-right: 2px solid var(--qa-border-strong); border-bottom: 2px solid var(--qa-border-strong);
        opacity: .7; transition: opacity .15s;
    }
    #qa-resize:hover::after { opacity: 1; }
    `;

    const OVERLAY_HTML = `
        <div id="qa-header">
            <span id="qa-title">✶ Sheja Asks<span id="qa-q-count" style="display:none"></span></span>
            <span id="qa-status" role="status" aria-live="polite"><span class="qa-led"></span>Ready</span>
            <div id="qa-controls">
                <button class="qa-icon-btn" id="qa-toggle" title="Show question & options" aria-label="Show question and options" aria-pressed="false">Q</button>
                <button class="qa-icon-btn" id="qa-pause" title="Pause auto-detection" aria-label="Pause auto-detection">⏸</button>
                <button class="qa-icon-btn" id="qa-min" title="Minimize" aria-label="Minimize">─</button>
                <button class="qa-icon-btn" id="qa-close" title="Close" aria-label="Close">×</button>
            </div>
        </div>
        <div id="qa-content">
            <div class="qa-section qa-hidden" id="qa-question-section">
                <div class="qa-label">
                    <span>Question</span>
                    <span id="qa-timestamp"></span>
                </div>
                <div id="qa-question">Waiting for a question…</div>
            </div>
            <div class="qa-section qa-hidden" id="qa-options-section">
                <div class="qa-label">Options</div>
                <ul id="qa-options"></ul>
            </div>
            <div class="qa-section qa-section--answer">
                <div class="qa-label">
                    <span>✶ Answer</span>
                    <span class="qa-provider-badge" id="qa-provider-badge"></span>
                </div>
                <div id="qa-ai" role="status" aria-live="polite"><span class="qa-idle">Ready — waiting for a question.</span></div>
            </div>
            <div id="qa-footer">
                <button id="qa-scan-main" class="qa-btn qa-btn--scan" title="Re-scan the page and ask the AI again">Re-ask AI</button>
                <button id="qa-nudge-toggle" class="qa-btn qa-btn--nudge" title="Add a hint to steer the AI" aria-label="Add a hint to steer the AI">💬 Hint</button>
            </div>
            <div id="qa-nudge-panel" class="qa-hidden">
                <textarea id="qa-nudge-input" rows="2" aria-label="Context hint for the AI" placeholder="Steer the AI — e.g. &quot;1990s pop music&quot;"></textarea>
                <div class="qa-nudge-foot">
                    <span class="qa-nudge-meta">Sent with every question · Enter to submit</span>
                    <button id="qa-nudge-clear" class="qa-btn--nudge-clear">Clear</button>
                    <button id="qa-nudge-submit" class="qa-btn--nudge-submit">Submit ↵</button>
                </div>
            </div>
        </div>
        <div id="qa-resize" title="Drag to resize" aria-hidden="true"></div>
    `;

    // ╔══════════════════════════════════════════════════════════════════════════╗
    // ║ Test hook — exposes internals to a test harness. Completely inert in a     ║
    // ║ real browser, where `globalThis.__shejaTestHook` is never defined.         ║
    // ╚══════════════════════════════════════════════════════════════════════════╝
    if (typeof globalThis !== "undefined" && typeof globalThis.__shejaTestHook === "function") {
        globalThis.__shejaTestHook({
            // pure helpers
            normalize, normKey, tokenOverlap, inViewport, isJunk, looksLikeQuestion,
            dedupeQuestion, isBetterCandidate, compact, looksLikeOptionSuffix,
            truncateAtQuestionMark, visualFingerprint, extractAnswers, findTextInput,
            fillInput, simulateClick, liveOptionEls, clickableFrom, isLiveOption,
            looksLikeVisualQuestion, isImageIrrelevantQuestion, needsVision,
            scanForCurrentQuestion, classifyAnswerSurface,
            startsWithWord, stripWrap, clampReason, closestOption, parseAnswer, resolveResp,
            // classes
            EventBus, CapturePipeline, Solver, AnswerFiller, OverlayUI,
            IngestionEngine, TransitionSensor, EventLifecycleManager, Orchestrator,
            // constants
            constants: {
                VOTE_CONF, VOTE_SAMPLES, VOTE_TEMP, DEBOUNCE_MS, DEBOUNCE_Q_MS,
                GATE_INTERVAL_MS, GATE_MAX_MS, OPEN_GRACE_MS, RESET_COOLDOWN_MS,
                LAYOUT_SHIFT_PX, TRANSITION_REFRACTORY_MS, VISUAL_POLL_MS, SUBMIT_RETRIES
            }
        });
    }

    // ╔══════════════════════════════════════════════════════════════════════════╗
    // ║ Bootstrap                                                                  ║
    // ╚══════════════════════════════════════════════════════════════════════════╝
    let app = null;
    function boot() {
        if (app) return;
        app = new Orchestrator();
        app.start();
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();

})();
