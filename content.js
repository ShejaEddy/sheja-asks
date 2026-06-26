(() => {
    'use strict';

    // ── Constants ──────────────────────────────────────────────────────────────
    const LOG_KEY         = "__quiz_logs";
    const MAX_LOGS        = 500;
    const DEBOUNCE_MS     = 300;   // wait after last DOM change before recording question
    const DEBOUNCE_Q_MS   = 120;   // shorter debounce for "?"-terminated (complete) questions
    const POLL_MS         = 2500;  // interval to catch answer-only changes
    const IMG_WAIT_MS     = 800;   // max wait for flag images to finish loading
    const AUTOFILL_MS     = 700;   // delay before auto-fill on manual rescan
    const SUBMIT_INIT_MS  = 400;   // delay before first submit attempt (lets quiz register selection)
    const SUBMIT_RETRY_MS = 350;   // delay between submit retries
    const SUBMIT_RETRIES  = 4;
    const ANSWER_COOLDOWN = 4000; // ms to suppress re-detection after an answer is shown
    // Answer-surface readiness gate — wait for options/input before calling the AI
    const GATE_INTERVAL_MS = 150;  // re-check cadence while waiting for the answer surface
    const GATE_MAX_MS      = 5000; // give up waiting and call best-effort after this
    const OPEN_GRACE_MS    = 700;  // grace before treating a text input as "open-ended" (lets MC buttons render)

    // ── State ──────────────────────────────────────────────────────────────────
    let reqId           = 0;      // incremented on each question to discard stale responses
    let lastFingerprint = "";     // question + answers joined — prevents duplicate triggers
    let overlayQuestion = "";
    let overlayAnswers  = [];
    let overlayVisualKey = "";
    let candidateQ      = "";     // best question candidate seen since last flush
    let candidateTimer  = null;
    let questionCount   = 0;
    let questionVisible = false;
    let isPaused        = false;  // when true, all auto-detection is suppressed
    let lastAnswerAt    = 0;      // timestamp of last fill click — drives cooldown
    let filledQuestion  = "";     // question text that was last filled — blocks re-scan until question changes
    let pendingGateTimer = null;  // readiness-gate retry handle (cancelled when a new question arrives)
    let isDragging      = false;
    let dragX = 0, dragY = 0;
    let isResizing      = false;
    let resizeStartX = 0, resizeStartY = 0, resizeStartW = 0, resizeStartH = 0;
    let _fadeTimer      = null;   // cancels in-flight fadeAiTo animation
    let answerEls       = new Map(); // normKey(optionText) → live option element, captured when a question is dispatched

    // ── Logging ────────────────────────────────────────────────────────────────
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

    // ── Text utilities ─────────────────────────────────────────────────────────
    function normalize(s) {
        return s.replace(/\s+/g, " ").trim();
    }

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

    const IGNORED_ANSWERS = new Set([
        "select one", "select one or more", "next", "back", "join", "play",
        "create", "kick players", "try", "try again", "submit", "check",
        "show q", "hide q", "scan", "↺ scan",
        "quiz editor", "quiz generator", "quiz library",
        "keep hosting", "stop hosting", "leave", "cancel",
        "editor", "generator", "hosting", "library",
        "hide incorrect answers", "show incorrect answers", "show correct answer",
        "next question", "finish quiz", "finish", "skip", "continue"
    ]);

    function looksLikeQuestion(text) {
        if (text.endsWith("?")) return true;
        const l = text.toLowerCase();
        return ["what ", "which ", "who ", "where ", "when ", "how ", "why ",
                "name ", "find ", "identify ", "guess ", "choose ",
                "unscramble ", "spell ", "type ", "fill in", "complete ",
                "match ", "select ", "describe ", "calculate ", "solve "].some(w => l.startsWith(w));
    }

    // Strips repeated prefix — quiz.com repeats question text 2×, 3×, 4×, or more in the DOM.
    // Loops until stable so 4× collapses to 2× then to 1× correctly.
    // Quiz.com repeats the whole question (2×, 3×, sometimes with trailing score
    // garbage). Signature approach: find where the opening ~15 chars recur and cut
    // there. Robustly collapses QQ / QQQ / partial repeats / repeat+garbage in one
    // pass, and returns the text unchanged when there is no repeat.
    function dedupeQuestion(text) {
        text = text.trim();
        const sigLen = Math.min(15, Math.floor(text.length / 2));
        if (sigLen < 6) return text;
        const sig = text.slice(0, sigLen);
        const next = text.indexOf(sig, sigLen);
        if (next !== -1) return text.slice(0, next).trim();
        return text;
    }

    function isBetterCandidate(newC, oldC) {
        if (!oldC) return true;
        const nl = newC.toLowerCase(), ol = oldC.toLowerCase();
        const [longer, shorter] = nl.length >= ol.length ? [nl, ol] : [ol, nl];
        // If one is a prefix of the other, prefer the longer (more complete) version
        if (longer.startsWith(shorter)) return newC.length > oldC.length;
        // Otherwise prefer longer — riddles need full context
        return newC.length > oldC.length;
    }

    function compact(s) {
        return s.toLowerCase().replace(/\s+/g, "");
    }

    function looksLikeOptionSuffix(after, answers) {
        if (!answers?.length) return false;
        const tail = compact(after);
        const optionBits = answers
            .map(a => compact(a))
            .filter(a => a.length >= 2);
        if (!optionBits.length) return false;
        const hits = optionBits.filter(a => tail.includes(a)).length;
        return hits >= Math.min(2, optionBits.length);
    }

    // Only strips text after "?" when it looks like concatenated option labels.
    // Riddle clues ("What am I? I get wetter the more I dry.") are preserved.
    function truncateAtQuestionMark(text, answers) {
        const idx = text.indexOf("?");
        if (idx === -1) return text;
        const head = text.slice(0, idx + 1);
        const after = text.slice(idx + 1).trim();
        if (!after) return text;
        // No letters = score numbers / garbage — always truncate
        if (!/[a-zA-Z]/.test(after)) return head;
        // Tail restarts the question stem (e.g. "Q?Q…") — truncate
        const headCore = compact(head).replace(/\?+$/, "");
        if (headCore.length >= 8 &&
            compact(after).startsWith(headCore.slice(0, Math.min(headCore.length, 14)))) return head;
        // Repeated digit run from score animations ("008008008", "198519851985")
        if (/(\d{2,4})\1{2,}/.test(after.replace(/\s+/g, ""))) return head;
        // Otherwise keep riddle clue tails ("What am I? I get wetter the more I dry.")
        if (after.length > 8 && after.includes(" ") && !looksLikeOptionSuffix(after, answers)) return text;
        return head;
    }

    // Fingerprint only the single largest, top-positioned question image by src.
    // Excludes canvas + small images so score animations don't perturb the key
    // (which would make the poll re-fire), and src-only avoids dimension drift.
    function visualFingerprint() {
        const imgs = [...document.querySelectorAll("img")].filter(el => {
            if (el.closest("#qa-overlay")) return false;
            const r = el.getBoundingClientRect();
            return r.width >= 150 && r.height >= 130 && inViewport(r, 10) &&
                   (r.width / r.height) <= 2.5 && r.top >= 50 && r.top <= window.innerHeight * 0.85;
        });
        if (!imgs.length) return "";
        imgs.sort((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            return (rb.width * rb.height) - (ra.width * ra.height);
        });
        return "img:" + (imgs[0].currentSrc || imgs[0].src);
    }

    // ── DOM utilities ──────────────────────────────────────────────────────────
    function extractAnswers() {
        const seen = new Set();
        const results = [];
        document.querySelectorAll("button, [role='button'], [role='option']").forEach(el => {
            const rect = el.getBoundingClientRect();
            const text = normalize(el.textContent || "");
            const skip =
                el.closest("#qa-overlay") ? true :
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

    // Non-interactive input types to skip
    const _SKIP_INPUT_TYPES = new Set(["submit","button","checkbox","radio","file","hidden","image","reset","range","color","date","datetime-local","month","week","time","number","password"]);

    function findTextInput() {
        const all = [...document.querySelectorAll("input, textarea, [contenteditable='true']")];
        return all.find(el => {
            if (el.closest("#qa-overlay") || el.readOnly || el.disabled) return false;
            if (_SKIP_INPUT_TYPES.has((el.type || "").toLowerCase())) return false;
            const r = el.getBoundingClientRect();
            return r.width > 50 && r.height > 10 && inViewport(r);
        }) || null;
    }

    // Uses React's internal setter so controlled inputs register the change
    function fillInput(el, text) {
        el.focus();
        const proto  = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, text); else el.value = text;
        el.dispatchEvent(new Event("input",  { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Fires the full pointer + mouse sequence (so React handlers register) plus a native
    // click() fallback, after bringing the element into view and focusing it.
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
        // quiz.com options are select-one (idempotent), so a second native click is safe and
        // covers handlers that ignore synthetic events.
        try { el.click(); } catch (e) {}
    }

    // The clickable, on-screen option elements right now.
    function liveOptionEls() {
        return [...document.querySelectorAll("button, [role='button'], [role='option']")].filter(el => {
            if (el.closest("#qa-overlay") || el.disabled) return false;
            const r = el.getBoundingClientRect();
            return r.width >= 60 && r.height >= 20 && inViewport(r);
        });
    }

    // The element that actually handles the click (a matched inner <span> isn't it).
    function clickableFrom(el) {
        return el?.closest("button, [role='button'], [role='option'], label, li[role]") || el;
    }

    // Is a previously-captured option element still usable?
    function isLiveOption(el) {
        if (!el || !el.isConnected || el.closest("#qa-overlay") || el.disabled) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 40 && r.height >= 18 && inViewport(r, 4);
    }

    // Snapshot option text → element at the moment a question is dispatched, so click-time
    // has the exact nodes that were on screen when the AI was asked.
    function captureAnswerEls() {
        answerEls = new Map();
        liveOptionEls().forEach(el => {
            const k = normKey(el.textContent || "");
            if (k && !answerEls.has(k)) answerEls.set(k, el);
        });
    }

    function clickAnswer(text) {
        const want = normKey(text);
        if (!want) return false;

        // 1. The element captured at dispatch time, if it's still live (avoids the re-query race).
        const stored = answerEls.get(want);
        if (isLiveOption(stored)) { simulateClick(clickableFrom(stored)); return true; }

        // 2. Re-resolve against the current DOM with the shared matcher.
        const cands = liveOptionEls().map(el => ({ el, key: normKey(el.textContent || "") })).filter(c => c.key);
        let m =
            cands.find(c => c.key === want) ||                                           // exact
            cands.find(c => c.key.startsWith(want)) ||                                    // option starts with answer
            cands.find(c => want.startsWith(c.key) && c.key.length >= 4) ||               // answer starts with option
            cands.find(c => c.key.includes(want) || want.includes(c.key));                // either contains the other
        if (!m) {                                                                          // token overlap ≥ 0.6
            let best = null, bestScore = 0.6;
            for (const c of cands) { const s = tokenOverlap(c.key, want); if (s > bestScore) { bestScore = s; best = c; } }
            m = best;
        }

        if (m) { simulateClick(clickableFrom(m.el)); return true; }
        return false;
    }

    // Retries up to SUBMIT_RETRIES times — quiz.com sometimes takes a moment to enable the Try button
    function autoSubmit(retries) {
        if (retries === undefined) retries = SUBMIT_RETRIES;
        const btn = [...document.querySelectorAll("button")].find(el => {
            if (el.closest("#qa-overlay") || el.disabled) return false;
            const r = el.getBoundingClientRect();
            if (!inViewport(r)) return false;
            const t = normalize(el.innerText || el.textContent || "").toLowerCase();
            // Match "Try", "Try again", "Submit", "Submit answer", "Check", "Check answer"
            return ["try", "submit", "check"].some(w => t === w || t.startsWith(w + " "));
        });
        if (btn) {
            log("submit", { label: normalize(btn.textContent || "") });
            simulateClick(btn);
            return;
        }
        const input = findTextInput();
        if (input) {
            log("submit", { method: "enter" });
            ["keydown", "keypress", "keyup"].forEach(type =>
                input.dispatchEvent(new KeyboardEvent(type, {
                    key: "Enter", code: "Enter", keyCode: 13, which: 13,
                    bubbles: true, cancelable: true
                }))
            );
            return;
        }
        if (retries > 0) setTimeout(() => autoSubmit(retries - 1), SUBMIT_RETRY_MS);
        else log("submit", { method: "none" });
    }

    function looksLikeVisualQuestion(q) {
        const l = q.toLowerCase();
        return l.includes("flag") || l.includes("country") || l.includes("identify") ||
               l.includes("image") || l.includes("picture") || l.includes("photo") ||
               l.includes("logo") || l.includes("guess the");
    }

    // True for questions where any image on screen is decorative — sending it to AI hurts accuracy
    function isImageIrrelevantQuestion(q) {
        const l = q.toLowerCase();
        return l.includes("unscramble") || l.includes("anagram") || l.includes("rearrange") ||
               l.startsWith("fill in") || l.startsWith("complete the") ||
               l.startsWith("type ") || l.startsWith("spell ");
    }

    // Deictic / visual cues in the wording that mean the image actually matters.
    const _VISUAL_CUES = ["this ", "these ", "shown", "pictured", "depicted", " above", " below",
                          "hidden", "in the image", "in the picture", " map", "screenshot"];

    // Decide whether to send a screenshot. Driven by the QUESTION WORDING, not the mere
    // presence of a decorative image — quiz.com shows a background image on nearly every
    // question, so image-presence alone would make almost everything use vision.
    function needsVision(q) {
        if (isImageIrrelevantQuestion(q)) return false;
        const l = (q || "").toLowerCase();
        if (looksLikeVisualQuestion(q)) return true;
        return _VISUAL_CUES.some(c => l.includes(c));
    }

    // Scans visible DOM for a question when MutationObserver misses a transition
    function scanForCurrentQuestion() {
        let best = "";
        const answers = extractAnswers();
        document.querySelectorAll("h1,h2,h3,h4,p,span,div,label").forEach(el => {
            if (el.closest("#qa-overlay") || el.closest("button,[role='button']")) return;
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

    // ── Chrome messaging ───────────────────────────────────────────────────────
    function runtimeSend(msg, callback) {
        try {
            chrome.runtime.sendMessage(msg, response => {
                if (chrome.runtime.lastError) {
                    callback({ error: "Extension context invalidated — reload the page" });
                } else {
                    callback(response);
                }
            });
        } catch (e) {
            callback({ error: String(e) });
        }
    }

    // ── Styles ─────────────────────────────────────────────────────────────────
    const overlayStyle = document.createElement("style");
    overlayStyle.textContent = `
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

    /* ─ Header ─ */
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

    /* ─ Content ─ */
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

    /* ─ Answer card (state accents: ok / warn / err) ─ */
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

    /* loading — spinner ring (distinct from idle / answered) */
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

    /* answer */
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

    /* confidence chip */
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

    /* ─ Footer ─ */
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

    /* ─ Nudge panel ─ */
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

    /* ─ Resize handle ─ */
    #qa-resize { position: absolute; bottom: 0; right: 0; width: 20px; height: 20px; cursor: nwse-resize; z-index: 10; }
    #qa-resize::after {
        content: ""; position: absolute; right: 5px; bottom: 5px; width: 7px; height: 7px;
        border-right: 2px solid var(--qa-border-strong); border-bottom: 2px solid var(--qa-border-strong);
        opacity: .7; transition: opacity .15s;
    }
    #qa-resize:hover::after { opacity: 1; }
    `;

    // ── Overlay HTML ───────────────────────────────────────────────────────────
    const overlay = document.createElement("div");
    overlay.id = "qa-overlay";
    overlay.innerHTML = `
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

    // ── Session persistence ────────────────────────────────────────────────────
    function savePosition() {
        try {
            sessionStorage.setItem("__sheja_pos", JSON.stringify({
                top: overlay.style.top, left: overlay.style.left
            }));
        } catch (e) {}
    }

    function saveSize() {
        try {
            const content = document.getElementById("qa-content");
            sessionStorage.setItem("__sheja_size", JSON.stringify({
                width: overlay.style.width,
                contentH: content?.style.maxHeight || ""
            }));
        } catch (e) {}
    }

    function restorePosition() {
        try {
            const pos = JSON.parse(sessionStorage.getItem("__sheja_pos") || "null");
            if (pos?.left) {
                overlay.style.top = pos.top; overlay.style.left = pos.left;
                overlay.style.right = "auto"; overlay.style.transform = "none";
            }
        } catch (e) {}
        try {
            const sz = JSON.parse(sessionStorage.getItem("__sheja_size") || "null");
            if (sz?.width) overlay.style.width = sz.width;
            if (sz?.contentH) {
                const content = document.getElementById("qa-content");
                if (content) content.style.maxHeight = sz.contentH;
            }
        } catch (e) {}
        const saved = sessionStorage.getItem("__sheja_showq");
        if (saved !== null) questionVisible = saved === "1";
    }

    // ── UI ──────────────────────────────────────────────────────────────────────
    function setProviderBadge(text) {
        const el = document.getElementById("qa-provider-badge");
        if (el) el.textContent = text;
    }

    // Pipeline status pill: ready → reading → waiting → thinking → answer ready → error.
    const _STATUS = {
        idle:      { label: "Ready",                cls: "qa-s-idle" },
        detecting: { label: "Reading question…",    cls: "qa-s-busy" },
        waiting:   { label: "Waiting for options…", cls: "qa-s-busy" },
        asking:    { label: "Thinking…",            cls: "qa-s-busy" },
        answered:  { label: "Answer ready",         cls: "qa-s-ok"   },
        error:     { label: "Error",                cls: "qa-s-err"  },
        paused:    { label: "Paused",               cls: "qa-s-warn" }
    };
    function setStatus(key) {
        const el = document.getElementById("qa-status");
        if (!el) return;
        const s = _STATUS[key] || _STATUS.idle;
        el.className = s.cls || "";
        el.innerHTML = '<span class="qa-led"></span>';
        el.appendChild(document.createTextNode(s.label));
    }

    // Drop the answer-card accent (used between states so a stale colour doesn't linger).
    function clearAnswerState() {
        const card = document.querySelector(".qa-section--answer");
        if (card) card.classList.remove("qa-state-ok", "qa-state-warn", "qa-state-err");
    }

    // Fades #qa-ai out, rebuilds content via buildFn, fades back in.
    // Cancels any pending fade so stale questions can't overwrite a new one.
    function fadeAiTo(buildFn) {
        const el = document.getElementById("qa-ai");
        if (!el) return;
        if (_fadeTimer) { clearTimeout(_fadeTimer); _fadeTimer = null; }
        el.style.opacity   = "0";
        el.style.transform = "translateY(4px)";
        _fadeTimer = setTimeout(() => {
            _fadeTimer = null;
            el.innerHTML = "";
            buildFn(el);
            requestAnimationFrame(() => {
                el.style.opacity   = "1";
                el.style.transform = "translateY(0)";
            });
        }, 90);
    }

    function showLoading(label) {
        setProviderBadge("");
        clearAnswerState();
        fadeAiTo(el => {
            const wrap = document.createElement("div");
            wrap.className = "qa-loading";
            const sp = document.createElement("div");
            sp.className = "qa-spinner";
            const txt  = document.createElement("span");
            txt.textContent = label || "Thinking…";
            wrap.appendChild(sp);
            wrap.appendChild(txt);
            el.appendChild(wrap);
        });
    }

    function showError(msg) {
        setProviderBadge("");
        clearAnswerState();
        const card = document.querySelector(".qa-section--answer");
        if (card) card.classList.add("qa-state-err");
        fadeAiTo(el => {
            const wrap = document.createElement("div");
            wrap.className = "qa-answer-wrap";

            const err = document.createElement("div");
            err.className = "qa-error";
            err.textContent = "⚠ " + msg;
            wrap.appendChild(err);

            el.appendChild(wrap);
        });
    }

    function showAnswer(answer, provider, isVisual, visualPending, autoFill, answerOptions, resolved) {
        const NAMES = { claude: "Claude", openai: "ChatGPT", gemini: "Gemini", mistral: "Mistral" };
        const optionsForAnswer = answerOptions || overlayAnswers;

        const parsed   = resolved || parseAnswer(answer, optionsForAnswer);
        const fillText = parsed.fillText;
        const reason   = parsed.reason;
        const lowConfidence = parsed.lowConfidence;
        const confidence = (parsed.confidence != null) ? parsed.confidence : null;

        // Single letter/digit choice (A–E, 1–9) → show as badge
        const choiceMatch = fillText.match(/^([A-Ea-e]|[1-9])\.?$/);
        const badge       = choiceMatch ? fillText.replace(".", "").toUpperCase() : null;

        setProviderBadge(isVisual ? (NAMES[provider] || provider) + " 📷" : (NAMES[provider] || provider));

        // Answer card accent: green when confident, amber for a best guess.
        const card = document.querySelector(".qa-section--answer");
        if (card) {
            card.classList.remove("qa-state-ok", "qa-state-warn", "qa-state-err");
            card.classList.add(lowConfidence ? "qa-state-warn" : "qa-state-ok");
        }

        fadeAiTo(el => {
            let filled = false;

            // Multi-strategy click: exact (clickAnswer 3-tier) → no leading article → no punctuation.
            function attemptClick(t) {
                if (clickAnswer(t)) return true;
                const noArticle = t.replace(/^(the|a|an)\s+/i, "").trim();
                if (noArticle !== t && clickAnswer(noArticle)) return true;
                const noPunct = t.replace(/[.,!?;:'"()]/g, "").trim();
                if (noPunct !== t && clickAnswer(noPunct)) return true;
                return false;
            }

            function markFilled(method) {
                filledQuestion = overlayQuestion;
                lastAnswerAt   = Date.now();
                log("fill", { ans: fillText, method });
            }

            function doFill() {
                if (filled) return;
                filled = true;
                textEl.classList.add("qa-filled");
                const isMC = optionsForAnswer.length >= 2;

                if (isMC) {
                    // MC: ONLY click an option button. Retry while buttons render; never
                    // type into a text input (that would hit the page's search box).
                    let tries = 0;
                    (function tryClick() {
                        if (filled === false) return;
                        if (attemptClick(fillText)) {
                            markFilled("click_btn");
                            setTimeout(autoSubmit, SUBMIT_INIT_MS);
                            return;
                        }
                        if (++tries < 8) { setTimeout(tryClick, 200); return; }
                        filled = false;
                        textEl.classList.remove("qa-filled");
                        log("fill", { ans: fillText, method: "no_btn", tries });
                    })();
                    return;
                }

                // Open-ended: type into the answer input; fall back to a button if no input.
                const input = findTextInput();
                if (input) {
                    markFilled("fill_input");
                    fillInput(input, fillText);
                    setTimeout(autoSubmit, 60);
                } else if (attemptClick(fillText)) {
                    markFilled("click_btn");
                    setTimeout(autoSubmit, SUBMIT_INIT_MS);
                } else {
                    filled = false;
                    textEl.classList.remove("qa-filled");
                    log("fill", { ans: fillText, method: "no_target" });
                }
            }

            const wrap = document.createElement("div");
            wrap.className = "qa-answer-wrap";

            const row = document.createElement("div");
            row.className = "qa-answer-row";

            if (badge) {
                const badgeEl = document.createElement("span");
                badgeEl.className = "qa-badge";
                badgeEl.textContent = badge;
                row.appendChild(badgeEl);
            }

            const textEl = document.createElement("span");
            textEl.className = "qa-answer-text"
                + (fillText.length > 20 ? " qa-answer-text--sm" : "")
                + (lowConfidence ? " qa-answer-text--guess" : "");
            textEl.textContent = badge ? (reason || fillText) : fillText;
            // Keyboard-operable: Enter/Space selects the answer on the page, same as a click.
            textEl.setAttribute("role", "button");
            textEl.tabIndex = 0;
            textEl.title = optionsForAnswer.length ? "Select this answer on the page" : "Type this answer into the page";
            textEl.addEventListener("click", doFill);
            textEl.addEventListener("keydown", e => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); doFill(); }
            });
            row.appendChild(textEl);

            // Confidence chip — High / Likely / Best guess, with the model's percentage.
            if (confidence != null) {
                const chip = document.createElement("span");
                const pct  = Math.round(confidence * 100);
                let cls = "qa-chip--mid", word = "Likely";
                if (confidence >= 0.85)      { cls = "qa-chip--ok";  word = "High"; }
                else if (confidence < VOTE_CONF) { cls = "qa-chip--low"; word = "Best guess"; }
                chip.className = "qa-chip " + cls;
                chip.textContent = `${word} · ${pct}%`;
                row.appendChild(chip);
            }
            wrap.appendChild(row);

            if (lowConfidence) {
                const g = document.createElement("div");
                g.className = "qa-guess-note";
                g.textContent = "⚠ Best guess — verify before you submit.";
                wrap.appendChild(g);
            }

            if (reason && !badge) {
                const reasonEl = document.createElement("div");
                reasonEl.className = "qa-reason";
                reasonEl.textContent = reason;
                wrap.appendChild(reasonEl);
            }

            if (!optionsForAnswer.length) {
                const hint = document.createElement("div");
                hint.className = "qa-hint";
                hint.textContent = "📝 Open-ended — click the answer to type it in.";
                wrap.appendChild(hint);
            }

            // Auto-fill only on manual rescan, not on auto-detected questions
            if (autoFill) setTimeout(doFill, AUTOFILL_MS);

            el.appendChild(wrap);
        });
    }

    // ── Answer-parsing helpers ──────────────────────────────────────────────────
    // Is `text` exactly `prefix`, or `prefix` followed by a non-word char (word boundary)?
    function startsWithWord(text, prefix) {
        if (!text.startsWith(prefix)) return false;
        if (text.length === prefix.length) return true;
        return !/[a-z0-9]/i.test(text.charAt(prefix.length));
    }

    // Strip wrapping [brackets] and "quotes" the model sometimes adds.
    function stripWrap(s) {
        return (s || "")
            .replace(/^\[(.+)\]$/, "$1")
            .replace(/^["'“”‘’](.+)["'“”‘’]$/, "$1")
            .trim();
    }

    // Keep displayed reasons short.
    function clampReason(r) {
        r = (r || "").trim();
        if (r.length > 120) r = r.slice(0, 117).trimEnd() + "…";
        return r;
    }

    // Closest option by word overlap / substring — last-resort when the model answers
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

        // ── Multiple-choice: always resolve to a real option ──
        if (answerOptions?.length) {
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
                pick((c, o) => c === o) ||                        // exact
                pick((c, o) => startsWithWord(c, o)) ||           // word-boundary prefix
                pick((c, o) => {                                  // whole-word contained
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
                    if (rest.toLowerCase().startsWith(o)) // collapse a repeated answer
                        rest = rest.slice(option.length).trim().replace(/^[—–\-:.]\s*/, "").trim();
                    reason = rest;
                }
                if (!reason && restLines && line1.toLowerCase() === o) reason = restLines;
                return { fillText: option, reason: clampReason(reason), lowConfidence };
            }

            // Nothing matched at all — best-effort short text, flagged for re-ask.
            const fallback = stripWrap(line1 || text).split(/\s+/).slice(0, 4).join(" ");
            return { fillText: fallback, reason: clampReason(restLines), lowConfidence: true };
        }

        // ── Open-ended ──
        if (lines.length >= 2) {
            return { fillText: stripWrap(line1), reason: clampReason(restLines), lowConfidence: false };
        }
        const m = text.match(/^(.+?)\s+[—–-]\s+(.+)$/);
        if (m) {
            return { fillText: stripWrap(m[1].trim()), reason: clampReason(m[2].trim()), lowConfidence: false };
        }
        // No separator — bound the blob: first sentence, else first 3 words.
        let fill = text;
        const sentence = text.match(/^(.*?[.!?])(\s|$)/);
        if (sentence && sentence[1].length <= 60) fill = sentence[1].replace(/[.!?]+$/, "").trim();
        if (fill.split(/\s+/).length > 3) fill = fill.split(/\s+/).slice(0, 3).join(" ");
        return { fillText: stripWrap(fill), reason: "", lowConfidence: false };
    }

    // ── Screenshot ─────────────────────────────────────────────────────────────
    function captureScreen(callback) {
        overlay.style.visibility = "hidden";
        const deadline = Date.now() + IMG_WAIT_MS;

        function checkImages() {
            const pending = [...document.querySelectorAll("img")].find(img => {
                if (img.closest("#qa-overlay") || img.complete) return false;
                const r = img.getBoundingClientRect();
                return r.width > 180 && r.height > 130 && inViewport(r, 10);
            });
            if (!pending || Date.now() >= deadline) {
                requestAnimationFrame(() => setTimeout(() => {
                    runtimeSend({ action: "takeScreenshot" }, resp => {
                        overlay.style.visibility = "";
                        callback(resp?.dataUrl || null, resp?.error || null);
                    });
                }, 40));
            } else {
                setTimeout(checkImages, 80);
            }
        }
        requestAnimationFrame(checkImages);
    }

    // ── AI ──────────────────────────────────────────────────────────────────────
    const VOTE_CONF    = 0.6;   // MC confidence below this triggers a self-consistency vote
    const VOTE_SAMPLES = 2;     // extra samples drawn when voting
    const VOTE_TEMP    = 0.4;   // temperature for vote samples (diversity)

    // Low-level single request to the background; cb receives the normalized response.
    function requestAI(q, ans, image, extra, cb) {
        const nudgeEl = document.getElementById("qa-nudge-input");
        const nudge   = (nudgeEl?.value || "").trim();
        const msg = { action: "askAI", question: q, answers: ans };
        if (image) msg.imageDataUrl = image;
        if (nudge) msg.nudge = nudge;
        if (extra?.strict) msg.strict = true;
        if (typeof extra?.temperature === "number") msg.temperature = extra.temperature;
        runtimeSend(msg, cb);
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

    function askAI(question, answers, imageDataUrl, autoFill, myId, strict) {
        if (myId === undefined) myId = ++reqId;   // direct callers (manual scan) get a fresh id
        const q    = question;
        const ans  = answers || [];
        const isMC = ans.length >= 2;
        setStatus("asking");

        const finish = (resolved, provider, usedImage) => {
            if (myId !== reqId) return;
            setStatus("answered");
            showAnswer(null, provider, !!usedImage, false, autoFill, ans, resolved);
        };

        // Self-consistency vote — sample more times and majority-vote the option index.
        const vote = (firstResp, usedImage) => {
            const tally = {};
            const record = r => {
                const i = r && Number.isInteger(r.answerIndex) ? r.answerIndex : -1;
                if (i >= 0) tally[i] = (tally[i] || 0) + 1;
            };
            record(firstResp);
            let total = 1, pending = VOTE_SAMPLES;
            const done = () => {
                if (myId !== reqId) return;
                let bestIdx = -1, bestCount = 0;
                for (const k in tally) if (tally[k] > bestCount) { bestCount = tally[k]; bestIdx = +k; }
                if (bestIdx >= 0) {
                    finish({
                        fillText: ans[bestIdx], reason: clampReason(firstResp.reasoning || ""),
                        lowConfidence: bestCount <= total / 2, confidence: bestCount / total, inRange: true
                    }, firstResp.provider, usedImage);
                } else {
                    finish(resolveResp(firstResp, ans), firstResp.provider, usedImage);
                }
            };
            log("vote", { id: myId, samples: VOTE_SAMPLES });
            for (let k = 0; k < VOTE_SAMPLES; k++) {
                requestAI(q, ans, usedImage || null, { temperature: VOTE_TEMP }, r => {
                    if (myId !== reqId) return;
                    total++; record(r);
                    if (--pending === 0) done();
                });
            }
        };

        const handle = (resp, usedImage) => {
            if (myId !== reqId) return;
            if (!resp || resp.error) {
                log("err", { id: myId, error: resp?.error });
                setStatus("error");
                showError(resp?.error ?? "No response from AI");
                return;
            }
            log("resp", { id: myId, ans: resp.answer, idx: resp.answerIndex, conf: resp.confidence, prov: resp.provider });

            // Off-list / unparseable on MC → one strict retry (deterministic, temp 0).
            if (isMC && !strict && (resp.parseError || resp.inRange === false)) {
                askAI(q, ans, usedImage || null, autoFill, myId, true);
                return;
            }
            const resolved = resolveResp(resp, ans);
            // Genuinely uncertain MC → vote to raise the hit rate.
            if (isMC && resolved.inRange && resolved.confidence != null && resolved.confidence < VOTE_CONF) {
                vote(resp, usedImage);
                return;
            }
            finish(resolved, resp.provider, usedImage);
        };

        const send = (image) => requestAI(q, ans, image, { strict }, resp => handle(resp, image));

        if (imageDataUrl) {                       // image already captured (manual scan / re-ask)
            showLoading("Reading the screenshot…");
            log("call", { id: myId, mode: "vision-direct" });
            send(imageDataUrl);
            return;
        }

        if (needsVision(q)) {
            showLoading("Reading the screenshot…");
            log("call", { id: myId, mode: "visual" });
            captureScreen((dataUrl, err) => {
                if (myId !== reqId) return;
                if (!dataUrl) { log("err", { id: myId, error: err, mode: "screenshot" }); send(null); return; }
                log("call", { id: myId, mode: "vision+text", kb: Math.round(dataUrl.length / 1024) });
                send(dataUrl);
            });
            return;
        }

        showLoading();
        log("call", { id: myId, mode: "text" });
        send(null);
    }

    // Manual scan — always passes autoFill=true so answer is applied automatically
    function scanScreen(snapQ, snapA) {
        cancelPendingGate();
        const q   = snapQ !== undefined ? snapQ : overlayQuestion;
        const ans = snapA !== undefined ? snapA : extractAnswers();
        showLoading("Scanning screen…");
        captureScreen((dataUrl, err) => {
            if (dataUrl) {
                askAI(q || "What is shown in this image?", ans, dataUrl, true);
            } else {
                setStatus("error");
                showError(err || "Screenshot failed — check extension permissions");
            }
        });
    }

    // ── Overlay mount & controls ───────────────────────────────────────────────
    function applyQuestionVisibility() {
        const qs  = document.getElementById("qa-question-section");
        const os  = document.getElementById("qa-options-section");
        const btn = document.getElementById("qa-toggle");
        qs?.classList.toggle("qa-hidden", !questionVisible);
        os?.classList.toggle("qa-hidden", !questionVisible);
        if (btn) { btn.classList.toggle("qa-on", questionVisible); btn.setAttribute("aria-pressed", String(questionVisible)); }
    }

    function mountOverlay() {
        if (!document.body) { setTimeout(mountOverlay, 200); return; }
        if (document.body.contains(overlay)) return;

        const head = document.head || document.documentElement;
        if (!head.contains(overlayStyle)) head.appendChild(overlayStyle);
        document.body.appendChild(overlay);
        restorePosition();

        overlay.querySelector("#qa-pause").addEventListener("click", () => {
            isPaused = !isPaused;
            const btn = document.getElementById("qa-pause");
            btn.textContent = isPaused ? "▶" : "⏸";
            btn.title = isPaused ? "Resume auto-detection" : "Pause auto-detection";
            btn.setAttribute("aria-label", btn.title);
            overlay.classList.toggle("qa-paused", isPaused);
            if (isPaused) { cancelPendingGate(); setStatus("paused"); }
            else setStatus("idle");
        });

        overlay.querySelector("#qa-close").addEventListener("click", () => {
            observer.disconnect();
            cancelPendingGate();
            if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
            overlay.remove();
        });

        overlay.querySelector("#qa-min").addEventListener("click", () => {
            const c = document.getElementById("qa-content");
            if (c) c.style.display = c.style.display === "none" ? "" : "none";
        });

        overlay.querySelector("#qa-toggle").addEventListener("click", () => {
            questionVisible = !questionVisible;
            applyQuestionVisibility();
            sessionStorage.setItem("__sheja_showq", questionVisible ? "1" : "0");
        });

        const header = document.getElementById("qa-header");
        header.addEventListener("mousedown", e => {
            if (e.target.closest("#qa-controls")) return;
            isDragging = true;
            const rect = overlay.getBoundingClientRect();
            dragX = e.clientX - rect.left;
            dragY = e.clientY - rect.top;
            overlay.style.top = rect.top + "px"; overlay.style.left = rect.left + "px";
            overlay.style.right = "auto"; overlay.style.transform = "none";
            overlay.classList.add("qa-dragging");
            e.preventDefault();
        });

        overlay.querySelector("#qa-resize").addEventListener("mousedown", e => {
            isResizing = true;
            resizeStartX = e.clientX;
            resizeStartY = e.clientY;
            resizeStartW = overlay.offsetWidth;
            const content = document.getElementById("qa-content");
            resizeStartH = content ? content.offsetHeight : 300;
            overlay.classList.add("qa-dragging");
            e.preventDefault();
            e.stopPropagation();
        });

        document.addEventListener("mousemove", e => {
            if (isDragging) {
                overlay.style.left = Math.max(0, Math.min(e.clientX - dragX, window.innerWidth  - overlay.offsetWidth))  + "px";
                overlay.style.top  = Math.max(0, Math.min(e.clientY - dragY, window.innerHeight - overlay.offsetHeight)) + "px";
            }
            if (isResizing) {
                const newW = Math.max(240, Math.min(window.innerWidth - 24, resizeStartW + (e.clientX - resizeStartX)));
                const newH = Math.max(120, Math.min(window.innerHeight * 0.88, resizeStartH + (e.clientY - resizeStartY)));
                overlay.style.width = newW + "px";
                const content = document.getElementById("qa-content");
                if (content) content.style.maxHeight = newH + "px";
            }
        });

        document.addEventListener("mouseup", () => {
            if (isDragging)  { isDragging  = false; overlay.classList.remove("qa-dragging"); savePosition(); }
            if (isResizing)  { isResizing  = false; overlay.classList.remove("qa-dragging"); saveSize(); }
        });

        // Persistent rescan button — uses fresh DOM state at click time
        overlay.querySelector("#qa-scan-main").addEventListener("click", () => {
            const scannedQ = scanForCurrentQuestion();
            const freshQ   = scannedQ || overlayQuestion;
            const freshA   = extractAnswers();
            const sameQ    = scannedQ && scannedQ === overlayQuestion;
            const sameVis  = visualFingerprint() === overlayVisualKey;
            const scanAns  = freshA.length >= 2 ? freshA : (sameQ && sameVis ? overlayAnswers : []);
            scanScreen(freshQ, scanAns);
        });

        // Nudge panel toggle (closed by default)
        overlay.querySelector("#qa-nudge-toggle").addEventListener("click", () => {
            const panel = document.getElementById("qa-nudge-panel");
            const btn   = document.getElementById("qa-nudge-toggle");
            const open  = panel.classList.toggle("qa-hidden") === false;
            btn.classList.toggle("qa-active", open);
            if (open) document.getElementById("qa-nudge-input")?.focus();
        });

        // Save nudge to storage on change (debounced), update indicator
        overlay.querySelector("#qa-nudge-input").addEventListener("input", () => {
            updateNudgeIndicator();
            clearTimeout(overlay._nudgeSave);
            overlay._nudgeSave = setTimeout(() => {
                chrome.storage.local.set({ nudgeHint: (document.getElementById("qa-nudge-input")?.value || "").trim() });
            }, 600);
        });

        // Enter without Shift submits; Submit button also submits
        overlay.querySelector("#qa-nudge-input").addEventListener("keydown", e => {
            if (e.key !== "Enter" || e.shiftKey) return;
            e.preventDefault();
            submitNudge();
        });
        overlay.querySelector("#qa-nudge-submit").addEventListener("click", submitNudge);

        // Clear button — wipes hint, keeps panel open
        overlay.querySelector("#qa-nudge-clear").addEventListener("click", () => {
            const input = document.getElementById("qa-nudge-input");
            if (input) input.value = "";
            clearTimeout(overlay._nudgeSave);
            chrome.storage.local.set({ nudgeHint: "" });
            updateNudgeIndicator();
            input?.focus();
        });

        // Restore saved nudge hint and update indicator
        chrome.storage.local.get("nudgeHint", data => {
            const input = document.getElementById("qa-nudge-input");
            if (input && data.nudgeHint) { input.value = data.nudgeHint; updateNudgeIndicator(); }
        });
    }

    function closeNudgePanel() {
        const panel = document.getElementById("qa-nudge-panel");
        const btn   = document.getElementById("qa-nudge-toggle");
        if (panel) panel.classList.add("qa-hidden");
        if (btn)   btn.classList.remove("qa-active");
    }

    function updateNudgeIndicator() {
        const btn   = document.getElementById("qa-nudge-toggle");
        const input = document.getElementById("qa-nudge-input");
        if (btn && input) btn.classList.toggle("qa-nudge-has-hint", !!input.value.trim());
    }

    // Save nudge, close panel, and immediately re-ask the current question with the hint.
    function submitNudge() {
        const input = document.getElementById("qa-nudge-input");
        clearTimeout(overlay._nudgeSave);
        if (input) chrome.storage.local.set({ nudgeHint: input.value.trim() });
        updateNudgeIndicator();
        closeNudgePanel();
        if (!overlayQuestion) return;
        cancelPendingGate();
        const freshA = extractAnswers();
        const ans = freshA.length >= 2 ? freshA : overlayAnswers;
        showLoading("Re-asking with your hint…");
        setStatus("asking");
        askAI(overlayQuestion, ans, null, false);
    }

    function updateOverlay() {
        mountOverlay();
        closeNudgePanel();

        const qEl  = document.getElementById("qa-question");
        const tsEl = document.getElementById("qa-timestamp");
        const oEl  = document.getElementById("qa-options");

        if (qEl)  qEl.textContent  = overlayQuestion || "Waiting for a question…";
        if (tsEl) tsEl.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

        if (oEl) {
            oEl.innerHTML = "";
            if (overlayAnswers.length) {
                overlayAnswers.forEach(a => {
                    const li = document.createElement("li");
                    li.textContent = a;
                    oEl.appendChild(li);
                });
            } else {
                const li = document.createElement("li");
                li.className = "qa-none";
                li.textContent = "Open-ended — type your answer";
                oEl.appendChild(li);
            }
        }

        applyQuestionVisibility();

        const ansEl = overlay.querySelector(".qa-section--answer");
        if (ansEl) {
            ansEl.classList.remove("qa-pulse");
            requestAnimationFrame(() => ansEl.classList.add("qa-pulse"));
        }

        const cntEl = document.getElementById("qa-q-count");
        if (cntEl) {
            cntEl.style.display = questionCount > 0 ? "" : "none";
            cntEl.textContent   = `#${questionCount}`;
        }
    }

    // ── Question recording ─────────────────────────────────────────────────────
    function cancelPendingGate() {
        if (pendingGateTimer) { clearTimeout(pendingGateTimer); pendingGateTimer = null; }
    }

    // What can we answer against right now? mc = option buttons, open = free-text input,
    // none = nothing rendered yet. Biased toward MC: a bare text input only counts as
    // "open" after a grace period, so a lagging MC question isn't misread as open-ended.
    function classifyAnswerSurface(question, elapsed) {
        const btns = extractAnswers();
        if (btns.length >= 2) return { kind: "mc", answers: btns };
        if (isImageIrrelevantQuestion(question)) return { kind: "open", answers: [] };
        if (findTextInput() && elapsed >= OPEN_GRACE_MS) return { kind: "open", answers: [] };
        return { kind: "none", answers: [] };
    }

    // Poll until the answer surface exists, then dispatch the AI call exactly once.
    function waitForAnswerSurface(question, myId, startedAt) {
        if (myId !== reqId) return;                       // superseded by a newer question
        const elapsed  = performance.now() - startedAt;
        const surface  = classifyAnswerSurface(question, elapsed);
        if (surface.kind !== "none") { dispatchAsk(question, surface, myId); return; }
        if (elapsed >= GATE_MAX_MS) {                      // give up — best effort
            const btns = extractAnswers();
            dispatchAsk(question, btns.length >= 2 ? { kind: "mc", answers: btns } : { kind: "open", answers: [] }, myId);
            return;
        }
        setStatus("waiting");
        pendingGateTimer = setTimeout(() => waitForAnswerSurface(question, myId, startedAt), GATE_INTERVAL_MS);
    }

    function dispatchAsk(question, surface, myId) {
        if (myId !== reqId) return;
        pendingGateTimer = null;
        overlayAnswers = surface.answers;                 // now authoritative
        captureAnswerEls();                               // snapshot live option nodes for click-time
        updateOverlay();
        log("question", { q: question, opts: overlayAnswers, kind: surface.kind, count: questionCount });
        askAI(question, overlayAnswers, null, false, myId);
    }

    function recordQuestion(questionText) {
        if (isPaused) return;
        const answers  = extractAnswers();
        const question = truncateAtQuestionMark(dedupeQuestion(questionText), answers);
        if (question.length < 8) return;
        // If user already filled this question, block re-scans until question text changes
        if (filledQuestion) {
            if (question === filledQuestion) return;
            filledQuestion = "";
        }
        // Cooldown only suppresses re-scans on the same question (result-screen noise).
        if (Date.now() - lastAnswerAt < ANSWER_COOLDOWN && question === overlayQuestion) return;

        const visualKey = needsVision(question) ? visualFingerprint() : "";
        // Fingerprint excludes answers so a question seen first at [] then at [4 options]
        // is ONE question, not two — the readiness gate handles option-waiting.
        const fingerprint = question + "\n" + visualKey;
        if (fingerprint === lastFingerprint) return;

        lastFingerprint = fingerprint;   // claim immediately so gate-window re-entries short-circuit
        const myId = ++reqId;            // gate owns the request id now
        cancelPendingGate();
        questionCount++;

        overlayQuestion  = question;
        overlayVisualKey = visualKey;
        overlayAnswers   = answers.length >= 2 ? answers : [];   // provisional; gate finalizes
        updateOverlay();
        setStatus("detecting");
        showLoading("Reading question…");
        waitForAnswerSurface(question, myId, performance.now());
    }

    // ── Question detection ─────────────────────────────────────────────────────
    function processText(raw) {
        const text = normalize(raw);
        if (text.length < 8 || text.length > 300 || isJunk(text) || !looksLikeQuestion(text)) return;

        const deduped = dedupeQuestion(text);
        const clean = truncateAtQuestionMark(deduped, deduped.includes("?") ? extractAnswers() : []);

        if (clean.length < 8 || clean.trim().split(/\s+/).length < 3) return;
        if (isBetterCandidate(clean, candidateQ)) candidateQ = clean;
    }

    function scheduleFlush() {
        if (candidateTimer) clearTimeout(candidateTimer);
        // A "?"-terminated candidate is a complete question → flush fast. Option-waiting
        // is handled separately by the readiness gate, so an early flush is safe.
        const delay = candidateQ.trim().endsWith("?") ? DEBOUNCE_Q_MS : DEBOUNCE_MS;
        candidateTimer = setTimeout(() => {
            const q    = candidateQ;
            candidateQ = "";
            candidateTimer = null;
            if (q) recordQuestion(q);
        }, delay);
    }

    // RAF-batched MutationObserver — collects all text changes in one frame before processing
    const mutationBatch = new Set();
    let rafPending = false;

    function processBatch() {
        rafPending = false;
        for (const text of mutationBatch) processText(text);
        mutationBatch.clear();
        if (candidateQ) scheduleFlush();
    }

    const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
            if (m.type === "characterData") {
                const p = m.target.parentElement;
                if (!p?.closest("#qa-overlay")) mutationBatch.add(normalize(m.target.textContent || ""));
            } else {
                for (const node of m.addedNodes) {
                    if (node.nodeType === Node.TEXT_NODE && !node.parentElement?.closest("#qa-overlay")) {
                        mutationBatch.add(normalize(node.textContent || ""));
                    } else if (node.nodeType === Node.ELEMENT_NODE && !node.closest?.("#qa-overlay")) {
                        mutationBatch.add(normalize(node.textContent || ""));
                    }
                }
            }
        }
        if (!rafPending && mutationBatch.size > 0) {
            rafPending = true;
            requestAnimationFrame(processBatch);
        }
    });

    // Stored so we can stop everything when the overlay is closed
    let pollInterval = null;

    // Interval poll — catches answer-option changes when question text stays the same
    // (e.g. quiz.com reuses "Guess the country?" for every flag question)
    function startPoll() {
        pollInterval = setInterval(() => {
            const current = extractAnswers();
            const freshQ = scanForCurrentQuestion() || overlayQuestion;
            const currentVisualKey = needsVision(freshQ) ? visualFingerprint() : "";
            const sameAnswers = current.join("|") === overlayAnswers.join("|");
            const sameVisual = currentVisualKey === overlayVisualKey;
            if (!overlayQuestion) return;
            if ((current.length < 2 && !currentVisualKey) || (sameAnswers && sameVisual)) return;
            if (freshQ) recordQuestion(freshQ);
        }, POLL_MS);
    }

    // ── Bootstrap ──────────────────────────────────────────────────────────────
    function start() {
        mountOverlay();
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        startPoll();
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();

})();
