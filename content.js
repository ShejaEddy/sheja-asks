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
    let _fadeTimer      = null;   // cancels in-flight fadeAiTo animation

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

    // Fires the full pointer + mouse sequence so React event handlers register the click
    function simulateClick(el) {
        const r  = el.getBoundingClientRect();
        const cx = r.left + r.width  / 2;
        const cy = r.top  + r.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
        ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(type =>
            el.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, opts))
        );
    }

    function clickAnswer(text) {
        const target = text.toLowerCase().trim();
        const candidates = [...document.querySelectorAll("button, [role='button'], [role='option']")]
            .filter(el => {
                if (el.closest("#qa-overlay") || el.disabled) return false;
                const r = el.getBoundingClientRect();
                return r.width >= 60 && r.height >= 20 && inViewport(r);
            });

        // 1. Exact match (preferred)
        let el = candidates.find(el => normalize(el.innerText || el.textContent || "").toLowerCase() === target);
        // 2. Button text starts with answer (e.g. button has trailing emoji or punctuation)
        if (!el) el = candidates.find(el => normalize(el.innerText || el.textContent || "").toLowerCase().startsWith(target));
        // 3. Answer starts with full button text (button is a prefix of the answer text)
        //    Require button text >= 4 chars to prevent single-letter false matches
        if (!el) el = candidates.find(el => {
            const t = normalize(el.innerText || el.textContent || "").toLowerCase();
            return t.length >= 4 && target.startsWith(t);
        });

        if (el) { simulateClick(el); return true; }
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
        position: fixed; top: 50%; right: 20px;
        transform: translateY(-50%);
        width: min(320px, calc(100vw - 24px));
        background: rgba(9, 8, 22, 0.97);
        -webkit-backdrop-filter: blur(24px) saturate(1.4);
        backdrop-filter: blur(24px) saturate(1.4);
        border: 1px solid rgba(120,100,255,.22);
        border-radius: 22px;
        z-index: 2147483647 !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
        font-size: 13px !important; color: #e8e6f6 !important;
        box-shadow: 0 24px 60px rgba(0,0,0,.7), 0 0 0 1px rgba(120,100,255,.06),
                    inset 0 1px 0 rgba(255,255,255,.05);
        overflow: hidden; transition: box-shadow .2s;
    }
    #qa-overlay.qa-dragging { box-shadow: 0 36px 80px rgba(0,0,0,.75); }
    #qa-overlay * { box-sizing: border-box !important; line-height: normal !important; }

    /* ─ Header ─ */
    #qa-header {
        display: flex; align-items: center;
        padding: 10px 11px 10px 14px;
        background: linear-gradient(135deg, #4a38cc 0%, #7553e0 50%, #a46de6 100%);
        border-bottom: 1px solid rgba(0,0,0,.25);
        cursor: grab; user-select: none; gap: 8px;
    }
    #qa-header:active { cursor: grabbing; }
    #qa-title {
        font-weight: 800 !important; font-size: 13.5px !important;
        color: #fff !important; white-space: nowrap;
        display: flex; align-items: center; gap: 6px;
        text-shadow: 0 1px 4px rgba(0,0,0,.3); flex-shrink: 0;
        letter-spacing: -.1px;
    }
    #qa-q-count {
        font-size: 9px !important; font-weight: 700 !important;
        background: rgba(0,0,0,.28); color: rgba(255,255,255,.75) !important;
        border-radius: 8px; padding: 1px 5px; letter-spacing: .2px;
    }
    #qa-status {
        flex: 1; text-align: center;
        font-size: 9px !important; font-weight: 700 !important;
        letter-spacing: .6px; text-transform: uppercase;
        color: rgba(255,255,255,.38) !important;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #qa-status.qa-s-busy { color: #cfc5ff !important; animation: qa-blink 1.1s ease-in-out infinite; }
    #qa-status.qa-s-ok   { color: #7dffc0 !important; }
    #qa-status.qa-s-err  { color: #ff9999 !important; }
    @keyframes qa-blink { 0%,100%{opacity:.45} 50%{opacity:1} }

    #qa-controls { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }
    .qa-icon-btn {
        background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.14);
        color: rgba(255,255,255,.85) !important; width: 25px; height: 25px; border-radius: 8px;
        cursor: pointer; font-size: 11px !important; font-weight: 700 !important;
        display: flex; align-items: center; justify-content: center;
        transition: background .15s, border-color .15s; flex-shrink: 0; padding: 0; letter-spacing: 0;
    }
    .qa-icon-btn:hover { background: rgba(255,255,255,.24); border-color: rgba(255,255,255,.28); }
    .qa-icon-btn.qa-on { background: rgba(255,255,255,.28); border-color: rgba(255,255,255,.4); }

    /* ─ Content ─ */
    #qa-content {
        max-height: calc(88vh - 50px); overflow-y: auto;
        padding: 10px 10px 8px; display: flex; flex-direction: column; gap: 7px;
    }
    #qa-content::-webkit-scrollbar { width: 3px; }
    #qa-content::-webkit-scrollbar-thumb { background: rgba(120,100,255,.28); border-radius: 3px; }

    .qa-section {
        background: rgba(255,255,255,.028); border-radius: 13px;
        padding: 9px 12px; border: 1px solid rgba(120,100,255,.11);
    }
    .qa-hidden { display: none !important; }
    .qa-label {
        font-size: 8.5px !important; font-weight: 800 !important;
        letter-spacing: 1.5px; color: #625e9a !important;
        margin-bottom: 7px; text-transform: uppercase;
        display: flex; align-items: center; justify-content: space-between;
    }
    .qa-provider-badge {
        font-size: 8.5px !important; font-weight: 700 !important;
        background: rgba(120,100,255,.12); color: #b0a8ff !important;
        border: 1px solid rgba(120,100,255,.2); border-radius: 5px; padding: 1px 6px;
        letter-spacing: .3px;
    }

    #qa-question {
        line-height: 1.65 !important; color: #eae6fb !important;
        font-size: 13px !important; font-weight: 500 !important;
    }
    #qa-timestamp { font-size: 9px !important; color: #565080 !important; font-style: italic; }
    #qa-options {
        list-style: none !important; margin: 0 !important; padding: 0 !important;
        display: flex; flex-direction: column; gap: 4px;
    }
    #qa-options li {
        background: rgba(120,100,255,.06); border: 1px solid rgba(120,100,255,.1);
        border-radius: 8px; padding: 6px 10px;
        color: #c4c0e6 !important; font-size: 12px !important; font-weight: 500 !important;
    }
    #qa-options li::before { content: "› "; color: #8870e8 !important; font-weight: 700 !important; }
    #qa-options li.qa-none {
        color: #4e4a78 !important; font-style: italic; font-size: 11.5px !important;
        background: transparent !important; border: none !important; padding: 2px 0 !important;
    }
    #qa-options li.qa-none::before { content: none !important; }

    /* ─ Answer card ─ */
    .qa-section--answer {
        background: rgba(255,255,255,.025);
        border: 1px solid rgba(120,100,255,.14);
        transition: border-color .4s, background .4s, box-shadow .4s;
        padding-bottom: 10px;
    }
    .qa-section--answer.qa-answered {
        background: rgba(45,190,115,.045);
        border-color: rgba(50,205,125,.26);
        box-shadow: inset 0 0 0 1px rgba(50,205,125,.06);
    }
    .qa-section--answer .qa-label { color: #706aac !important; }
    .qa-section--answer.qa-answered .qa-label { color: #4ad890 !important; }
    .qa-section--answer.qa-pulse { animation: qa-pulse-in .5s ease; }
    @keyframes qa-pulse-in {
        0%   { box-shadow: inset 0 0 0 1px rgba(50,205,125,.06); }
        45%  { box-shadow: inset 0 0 0 1px rgba(50,205,125,.06), 0 0 0 4px rgba(50,205,125,.1); }
        100% { box-shadow: inset 0 0 0 1px rgba(50,205,125,.06); }
    }

    #qa-ai {
        min-height: 26px; display: flex; flex-direction: column; gap: 8px;
        transition: opacity .16s ease, transform .16s ease;
    }
    .qa-idle {
        color: #46426a !important; font-style: italic; font-size: 12px !important;
        padding: 4px 0; animation: qa-breathe 3s ease-in-out infinite;
    }
    @keyframes qa-breathe { 0%,100%{opacity:.28} 50%{opacity:.7} }

    .qa-loading {
        display: flex; align-items: center; gap: 9px; padding: 4px 0;
        color: #a098e0 !important; font-size: 12px !important; font-weight: 500 !important;
    }
    .qa-dots { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }
    .qa-dots span {
        width: 5px; height: 5px; border-radius: 50%; background: #8868e0;
        animation: qa-bounce .85s ease-in-out infinite;
    }
    .qa-dots span:nth-child(2) { animation-delay: .17s; }
    .qa-dots span:nth-child(3) { animation-delay: .34s; }
    @keyframes qa-bounce {
        0%,60%,100% { transform: translateY(0); opacity: .38; }
        30%          { transform: translateY(-5px); opacity: 1; }
    }

    .qa-answer-wrap {
        display: flex; flex-direction: column; gap: 7px;
        animation: qa-appear .28s cubic-bezier(.34,1.56,.64,1);
    }
    @keyframes qa-appear {
        from { opacity: 0; transform: translateY(6px) scale(.97); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .qa-answer-row { display: flex; align-items: center; gap: 9px; }
    .qa-badge {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 36px; height: 36px; padding: 0 6px; flex-shrink: 0;
        background: linear-gradient(135deg, #4a38cc, #8860e8);
        color: #fff !important; font-size: 18px !important; font-weight: 900 !important;
        border-radius: 10px; box-shadow: 0 4px 12px rgba(74,56,204,.38);
    }
    .qa-answer-text {
        color: #52ecaa !important; font-weight: 800 !important;
        font-size: 19px !important; line-height: 1.2 !important; cursor: pointer;
        letter-spacing: -.2px;
    }
    .qa-answer-text:hover { color: #6fffc0 !important; text-decoration: underline; }
    .qa-answer-text--sm { font-size: 14.5px !important; letter-spacing: 0; }
    .qa-answer-text--guess { color: #ffd060 !important; }
    .qa-answer-text--guess:hover { color: #ffe080 !important; }
    .qa-answer-text.qa-filled {
        opacity: .3 !important; text-decoration: line-through !important; cursor: default !important;
    }
    .qa-guess-note {
        font-size: 10px !important; color: #ffc040 !important; font-weight: 600 !important;
        background: rgba(255,170,40,.07); border: 1px solid rgba(255,170,40,.16);
        border-radius: 6px; padding: 3px 9px;
    }
    .qa-reason {
        color: #635f92 !important; font-size: 10.5px !important;
        font-style: italic; line-height: 1.55 !important;
    }
    .qa-hint {
        font-size: 10.5px !important; color: #42d898 !important; font-weight: 600 !important;
        background: rgba(50,205,125,.06); border: 1px solid rgba(50,205,125,.14);
        border-radius: 6px; padding: 3px 9px;
    }
    .qa-visual-pending {
        font-size: 11px !important; color: #a098e0 !important;
        font-style: italic; animation: qa-breathe 2s ease-in-out infinite;
    }
    .qa-error { color: #ff7a7a !important; font-size: 12px !important; font-weight: 500 !important; }

    /* ─ Footer ─ */
    #qa-footer { display: flex; gap: 6px; align-items: center; }
    .qa-btn {
        display: inline-flex; align-items: center; justify-content: center;
        padding: 7px 11px; border-radius: 9px;
        font-size: 11.5px !important; font-weight: 700 !important;
        cursor: pointer; transition: background .15s, transform .1s, border-color .15s;
        border: none; line-height: 1 !important; letter-spacing: .15px;
    }
    .qa-btn:hover:not(:disabled) { transform: translateY(-1px); }
    .qa-btn:active:not(:disabled) { transform: translateY(0); }
    .qa-btn:disabled { opacity: .4; cursor: default; transform: none; }

    .qa-btn--scan {
        flex: 1;
        background: rgba(120,100,255,.1); color: #a098e0 !important;
        border: 1px solid rgba(120,100,255,.2);
    }
    .qa-btn--scan:hover:not(:disabled) {
        background: rgba(120,100,255,.2); color: #c0b8ff !important;
        border-color: rgba(120,100,255,.36);
    }

    /* nudge toggle — relative so the active-hint dot can sit in corner */
    .qa-btn--nudge {
        position: relative;
        background: rgba(255,255,255,.04); color: #5e5a8a !important;
        border: 1px solid rgba(255,255,255,.07); padding: 7px 10px; font-size: 13px !important;
    }
    .qa-btn--nudge:hover:not(:disabled) { background: rgba(255,255,255,.1); color: #9a96cc !important; }
    .qa-btn--nudge.qa-active {
        background: rgba(120,100,255,.16); color: #beb6ff !important;
        border-color: rgba(120,100,255,.32);
    }
    /* green dot when a hint is saved */
    .qa-btn--nudge.qa-nudge-has-hint::after {
        content: ""; position: absolute; top: 4px; right: 4px;
        width: 6px; height: 6px; border-radius: 50%;
        background: #42d898; box-shadow: 0 0 5px rgba(66,216,152,.6);
    }

    /* ─ Nudge panel ─ */
    #qa-nudge-panel {
        display: flex; flex-direction: column; gap: 5px;
        background: rgba(255,255,255,.022); border: 1px solid rgba(120,100,255,.14);
        border-radius: 13px; padding: 9px 10px;
        animation: qa-appear .2s ease;
    }
    #qa-nudge-input {
        width: 100% !important;
        background: rgba(120,100,255,.06) !important;
        border: 1px solid rgba(120,100,255,.18) !important;
        border-radius: 9px !important;
        color: #ccc8ee !important; font-size: 12px !important;
        font-family: inherit !important; padding: 8px 10px !important;
        resize: none !important; line-height: 1.5 !important;
        outline: none !important; transition: border-color .15s, background .15s;
    }
    #qa-nudge-input:focus {
        border-color: rgba(120,100,255,.42) !important;
        background: rgba(120,100,255,.1) !important;
    }
    #qa-nudge-input::placeholder { color: #38345a !important; font-style: italic; }
    .qa-nudge-foot {
        display: flex; align-items: center; gap: 5px;
    }
    .qa-nudge-meta {
        flex: 1; font-size: 8.5px !important; color: #3c395e !important; font-style: italic;
    }
    .qa-btn--nudge-clear {
        background: rgba(255,255,255,.04); color: #5a5680 !important;
        border: 1px solid rgba(255,255,255,.07);
        padding: 4px 9px; border-radius: 7px; flex-shrink: 0;
        font-size: 10.5px !important; font-weight: 600 !important;
        cursor: pointer; transition: background .15s, color .15s;
    }
    .qa-btn--nudge-clear:hover { background: rgba(255,80,80,.1); color: #ff8080 !important; border-color: rgba(255,80,80,.2); }
    .qa-btn--nudge-submit {
        background: linear-gradient(135deg, #4a38cc, #7553e0);
        color: #fff !important; border: none;
        padding: 4px 11px; border-radius: 7px; flex-shrink: 0;
        font-size: 10.5px !important; font-weight: 700 !important;
        cursor: pointer; transition: opacity .15s; letter-spacing: .2px;
        box-shadow: 0 2px 8px rgba(74,56,204,.35);
    }
    .qa-btn--nudge-submit:hover { opacity: .84; }
    `;

    // ── Overlay HTML ───────────────────────────────────────────────────────────
    const overlay = document.createElement("div");
    overlay.id = "qa-overlay";
    overlay.innerHTML = `
        <div id="qa-header">
            <span id="qa-title">✶ Sheja Asks<span id="qa-q-count" style="display:none"></span></span>
            <span id="qa-status">Idle</span>
            <div id="qa-controls">
                <button class="qa-icon-btn" id="qa-toggle" title="Show question &amp; options">Q</button>
                <button class="qa-icon-btn" id="qa-pause" title="Pause auto-detection">⏸</button>
                <button class="qa-icon-btn" id="qa-min" title="Minimize">─</button>
                <button class="qa-icon-btn" id="qa-close" title="Close">×</button>
            </div>
        </div>
        <div id="qa-content">
            <div class="qa-section qa-hidden" id="qa-question-section">
                <div class="qa-label">
                    <span>Question</span>
                    <span id="qa-timestamp"></span>
                </div>
                <div id="qa-question">Waiting for question...</div>
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
                <div id="qa-ai"><span class="qa-idle">Waiting for a question...</span></div>
            </div>
            <div id="qa-footer">
                <button id="qa-scan-main" class="qa-btn qa-btn--scan">↺ Rescan</button>
                <button id="qa-nudge-toggle" class="qa-btn qa-btn--nudge" title="Steer the AI with a context hint">💬</button>
            </div>
            <div id="qa-nudge-panel" class="qa-hidden">
                <textarea id="qa-nudge-input" rows="2" placeholder="Steer the AI — e.g. &quot;This quiz is about 20th century European history&quot;"></textarea>
                <div class="qa-nudge-foot">
                    <span class="qa-nudge-meta">Sent with every call · Enter to submit</span>
                    <button id="qa-nudge-clear" class="qa-btn--nudge-clear">Clear</button>
                    <button id="qa-nudge-submit" class="qa-btn--nudge-submit">Submit ↵</button>
                </div>
            </div>
        </div>
    `;

    // ── Session persistence ────────────────────────────────────────────────────
    function savePosition() {
        try {
            sessionStorage.setItem("__sheja_pos", JSON.stringify({
                top: overlay.style.top, left: overlay.style.left
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
        const saved = sessionStorage.getItem("__sheja_showq");
        if (saved !== null) questionVisible = saved === "1";
    }

    // ── UI ──────────────────────────────────────────────────────────────────────
    function setProviderBadge(text) {
        const el = document.getElementById("qa-provider-badge");
        if (el) el.textContent = text;
    }

    // Pipeline status pill: detecting → waiting → asking → answered → error.
    const _STATUS = {
        detecting: { label: "Detecting…",  cls: "qa-s-busy" },
        waiting:   { label: "Waiting…",    cls: "qa-s-busy" },
        asking:    { label: "Asking AI…",  cls: "qa-s-busy" },
        answered:  { label: "Answered ✓",  cls: "qa-s-ok"   },
        error:     { label: "Error",       cls: "qa-s-err"  },
        paused:    { label: "Paused",      cls: ""          },
        idle:      { label: "Idle",        cls: ""          }
    };
    function setStatus(key) {
        const el = document.getElementById("qa-status");
        if (!el) return;
        const s = _STATUS[key] || _STATUS.idle;
        el.textContent = s.label;
        el.className = s.cls || "";
        const ansCard = document.querySelector(".qa-section--answer");
        if (ansCard) ansCard.classList.toggle("qa-answered", key === "answered");
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
        fadeAiTo(el => {
            const wrap = document.createElement("div");
            wrap.className = "qa-loading";
            const txt  = document.createElement("span");
            txt.textContent = label || "Asking AI…";
            const dots = document.createElement("div");
            dots.className = "qa-dots";
            dots.innerHTML = "<span></span><span></span><span></span>";
            wrap.appendChild(txt);
            wrap.appendChild(dots);
            el.appendChild(wrap);
        });
    }

    function showError(msg) {
        setProviderBadge("");
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

    function showAnswer(answer, provider, isVisual, visualPending, autoFill, answerOptions) {
        const NAMES = { claude: "Claude", openai: "ChatGPT", gemini: "Gemini", mistral: "Mistral" };
        const optionsForAnswer = answerOptions || overlayAnswers;

        const parsed   = parseAnswer(answer, optionsForAnswer);
        const fillText = parsed.fillText;
        const reason   = parsed.reason;
        const lowConfidence = parsed.lowConfidence;

        // Single letter/digit choice (A–E, 1–9) → show as badge
        const choiceMatch = fillText.match(/^([A-Ea-e]|[1-9])\.?$/);
        const badge       = choiceMatch ? fillText.replace(".", "").toUpperCase() : null;

        setProviderBadge(isVisual ? (NAMES[provider] || provider) + " 📷" : (NAMES[provider] || provider));

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
                        if (++tries < 6) { setTimeout(tryClick, 200); return; }
                        filled = false;
                        textEl.classList.remove("qa-filled");
                        log("fill", { ans: fillText, method: "no_btn" });
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
            if (visualPending) {
                textEl.style.cursor = "default";
                textEl.title = "Waiting for image scan…";
            } else {
                textEl.title = "Click to fill answer";
                textEl.addEventListener("click", doFill);
            }
            row.appendChild(textEl);
            wrap.appendChild(row);

            if (lowConfidence) {
                const g = document.createElement("div");
                g.className = "qa-guess-note";
                g.textContent = "⚠ best guess — verify before submitting";
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
                hint.textContent = "📝 Open question — click answer to fill";
                wrap.appendChild(hint);
            }

            if (visualPending) {
                const pend = document.createElement("div");
                pend.className = "qa-visual-pending";
                pend.textContent = "📷 Checking with screenshot...";
                wrap.appendChild(pend);
            }

            // Auto-fill only on manual rescan, not on auto-detected questions
            if (autoFill && !visualPending) setTimeout(doFill, AUTOFILL_MS);

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
    function askAI(question, answers, imageDataUrl, autoFill, myId, strict) {
        if (myId === undefined) myId = ++reqId;   // direct callers (manual scan) get a fresh id
        const q   = question;
        const ans = answers || [];
        setStatus("asking");

        // Shared response handling: parse, optionally re-ask once on a confident MC miss.
        const handle = (resp, usedImage) => {
            if (myId !== reqId) return;
            if (!resp?.answer) {
                log("err", { id: myId, error: resp?.error });
                setStatus("error");
                showError(resp?.error ?? "No response from AI");
                return;
            }
            log("resp", { id: myId, ans: resp.answer, prov: resp.provider });
            // Bounded re-ask: an MC answer that matched no option → ask once more, strictly.
            if (!strict && ans.length >= 2 && parseAnswer(resp.answer, ans).lowConfidence) {
                askAI(q, ans, usedImage || null, autoFill, myId, true);
                return;
            }
            setStatus("answered");
            showAnswer(resp.answer, resp.provider, !!usedImage, false, autoFill, ans);
        };

        const send = (image) => {
            const nudgeEl = document.getElementById("qa-nudge-input");
            const nudge   = (nudgeEl?.value || "").trim();
            const msg = { action: "askAI", question: q, answers: ans };
            if (strict) msg.strict = true;
            if (image)  msg.imageDataUrl = image;
            if (nudge)  msg.nudge = nudge;
            runtimeSend(msg, resp => handle(resp, image));
        };

        if (imageDataUrl) {                       // image already captured (manual scan / re-ask)
            showLoading("Scanning image…");
            log("call", { id: myId, mode: "vision-direct" });
            send(imageDataUrl);
            return;
        }

        if (needsVision(q)) {
            showLoading("Scanning image…");
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
        if (btn) btn.classList.toggle("qa-on", questionVisible);
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
            document.getElementById("qa-header").style.background = isPaused
                ? "linear-gradient(135deg, #5b5b6e, #7c7c93)"
                : "";
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
        document.addEventListener("mousemove", e => {
            if (!isDragging) return;
            overlay.style.left = Math.max(0, Math.min(e.clientX - dragX, window.innerWidth  - overlay.offsetWidth))  + "px";
            overlay.style.top  = Math.max(0, Math.min(e.clientY - dragY, window.innerHeight - overlay.offsetHeight)) + "px";
        });
        document.addEventListener("mouseup", () => { if (isDragging) { isDragging = false; savePosition(); } });

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

        if (qEl)  qEl.textContent  = overlayQuestion || "Waiting for question...";
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
                li.textContent = "No options — open question";
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
