(() => {
    'use strict';

    // ── Constants ──────────────────────────────────────────────────────────────
    const LOG_KEY         = "__quiz_logs";
    const MAX_LOGS        = 500;
    const DEBOUNCE_MS     = 300;   // wait after last DOM change before recording question
    const POLL_MS         = 2500;  // interval to catch answer-only changes
    const IMG_WAIT_MS     = 800;   // max wait for flag images to finish loading
    const AUTOFILL_MS     = 700;   // delay before auto-fill on manual rescan
    const SUBMIT_INIT_MS  = 400;   // delay before first submit attempt (lets quiz register selection)
    const SUBMIT_RETRY_MS = 350;   // delay between submit retries
    const SUBMIT_RETRIES  = 4;

    // ── State ──────────────────────────────────────────────────────────────────
    let reqId           = 0;      // incremented on each question to discard stale responses
    let lastFingerprint = "";     // question + answers joined — prevents duplicate triggers
    let overlayQuestion = "";
    let overlayAnswers  = [];
    let candidateQ      = "";     // best question candidate seen since last flush
    let candidateTimer  = null;
    let questionCount   = 0;
    let questionVisible = false;
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
                "name ", "find ", "identify ", "guess ", "choose "].some(w => l.startsWith(w));
    }

    // Strips repeated prefix (quiz.com sometimes doubles question text in the DOM)
    function dedupeQuestion(text) {
        const half = Math.floor(text.length / 2);
        const first = text.slice(0, half);
        return text.slice(half).startsWith(first) ? text.slice(0, half) : text;
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

    // Only strips text after "?" when it looks like concatenated option labels (no spaces).
    // Riddle clues ("What am I? I get wetter the more I dry.") are preserved.
    function truncateAtQuestionMark(text) {
        const idx = text.indexOf("?");
        if (idx === -1) return text;
        const after = text.slice(idx + 1).trim();
        // If what follows has spaces it's a sentence (riddle clue) — keep the full text
        if (after.length > 8 && after.includes(" ")) return text;
        return text.slice(0, idx + 1);
    }

    // ── DOM utilities ──────────────────────────────────────────────────────────
    function extractAnswers() {
        const seen = new Set();
        const results = [];
        document.querySelectorAll("button, [role='button'], [role='option']").forEach(el => {
            if (el.closest("#qa-overlay") || el.disabled) return;
            const rect = el.getBoundingClientRect();
            if (rect.width < 60 || rect.height < 20) return;
            if (rect.top < 0 || rect.bottom > window.innerHeight) return;
            const text = normalize(el.textContent || "");
            if (!text || text.length > 80) return;
            if (IGNORED_ANSWERS.has(text.toLowerCase()) || isJunk(text)) return;
            if (!seen.has(text)) { seen.add(text); results.push(text); }
        });
        return results;
    }

    function findTextInput() {
        return [...document.querySelectorAll("input[type='text'], input:not([type]), textarea")]
            .find(el => {
                if (el.closest("#qa-overlay") || el.readOnly || el.disabled) return false;
                const r = el.getBoundingClientRect();
                return r.width > 50 && r.height > 10 && r.top >= 0 && r.bottom <= window.innerHeight;
            }) || null;
    }

    // Uses React's internal setter so controlled inputs register the change
    function fillInput(el, text) {
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
                return r.width >= 60 && r.height >= 20 && r.top >= 0 && r.bottom <= window.innerHeight;
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
            const t = normalize(el.innerText || el.textContent || "").toLowerCase();
            return t === "try" || t === "try again" || t === "submit" || t === "check";
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

    function detectVisualQuestion() {
        return [...document.querySelectorAll("img")].some(img => {
            if (img.closest("#qa-overlay")) return false;
            const r = img.getBoundingClientRect();
            if (r.width < 150 || r.height < 130) return false;
            if (r.top < 50 || r.bottom > window.innerHeight || r.top > window.innerHeight * 0.85) return false;
            // Skip wide banners (aspect ratio > 2.5 is likely a header/ad, not a quiz image)
            return (r.width / r.height) <= 2.5;
        });
    }

    function looksLikeVisualQuestion(q) {
        const l = q.toLowerCase();
        return l.includes("flag") || l.includes("country") || l.includes("identify") ||
               l.includes("image") || l.includes("picture") || l.includes("photo") ||
               l.includes("logo") || l.includes("guess the");
    }

    // Scans visible DOM for a question when MutationObserver misses a transition
    function scanForCurrentQuestion() {
        let best = "";
        document.querySelectorAll("h1,h2,h3,h4,p,span,div,label").forEach(el => {
            if (el.closest("#qa-overlay") || el.closest("button,[role='button']")) return;
            if (el.querySelectorAll("button,[role='button']").length > 0) return;
            const rect = el.getBoundingClientRect();
            if (rect.width < 80 || rect.top < -10 || rect.bottom > window.innerHeight + 10) return;
            const text = normalize(el.textContent || "");
            if (text.length < 8 || text.length > 300 || isJunk(text) || !looksLikeQuestion(text)) return;
            const clean = truncateAtQuestionMark(dedupeQuestion(text));
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
        background: #fff; border: 1.5px solid #ddd6fe; border-radius: 16px;
        z-index: 2147483647 !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
        font-size: 13px !important;
        box-shadow: 0 12px 40px rgba(109,40,217,.16), 0 2px 8px rgba(0,0,0,.06);
        overflow: hidden; transition: box-shadow .2s;
    }
    #qa-overlay.qa-dragging {
        box-shadow: 0 20px 60px rgba(109,40,217,.26), 0 4px 16px rgba(0,0,0,.12);
    }
    #qa-overlay * { box-sizing: border-box !important; line-height: normal !important; }

    #qa-header {
        display: flex; align-items: center; padding: 11px 12px;
        background: linear-gradient(135deg, #6c63ff, #a78bfa);
        cursor: grab; user-select: none; gap: 8px;
    }
    #qa-header:active { cursor: grabbing; }
    #qa-title {
        font-weight: 700 !important; font-size: 14px !important;
        color: #fff !important; flex: 1; white-space: nowrap;
        display: flex; align-items: center; gap: 7px;
    }
    #qa-q-count {
        font-size: 10px !important; font-weight: 700 !important;
        background: rgba(255,255,255,.22); color: rgba(255,255,255,.9) !important;
        border-radius: 10px; padding: 2px 7px; letter-spacing: .3px;
    }
    #qa-controls { display: flex; gap: 5px; align-items: center; flex-shrink: 0; }
    #qa-toggle {
        background: rgba(255,255,255,.18); border: 1.5px solid rgba(255,255,255,.35);
        color: #fff !important; font-size: 10px !important; font-weight: 700 !important;
        padding: 4px 9px; border-radius: 20px; cursor: pointer;
        letter-spacing: .4px; white-space: nowrap; transition: background .15s;
    }
    #qa-toggle:hover, #qa-toggle.qa-on { background: rgba(255,255,255,.35); }
    .qa-icon-btn {
        background: rgba(255,255,255,.18); border: none;
        color: #fff !important; width: 26px; height: 26px; border-radius: 50%;
        cursor: pointer; font-size: 14px !important;
        display: flex; align-items: center; justify-content: center;
        transition: background .15s; flex-shrink: 0; padding: 0;
    }
    .qa-icon-btn:hover { background: rgba(255,255,255,.38); }

    #qa-content {
        max-height: calc(80vh - 52px); overflow-y: auto;
        padding: 10px; display: flex; flex-direction: column; gap: 8px;
        background: #faf9ff; border-radius: 0 0 16px 16px;
    }
    #qa-content::-webkit-scrollbar { width: 4px; }
    #qa-content::-webkit-scrollbar-thumb { background: #ddd6fe; border-radius: 4px; }

    .qa-section {
        background: #fff; border-radius: 11px;
        padding: 11px 13px; border: 1.5px solid #ede9fe;
    }
    .qa-hidden { display: none !important; }
    .qa-label {
        font-size: 9px !important; font-weight: 800 !important;
        letter-spacing: 1.4px; color: #8b5cf6 !important;
        margin-bottom: 7px; text-transform: uppercase;
        display: flex; align-items: center; justify-content: space-between;
    }
    .qa-provider-badge {
        font-size: 9px !important; font-weight: 700 !important;
        letter-spacing: .3px; background: #f5f3ff; color: #7c3aed !important;
        border: 1px solid #ddd6fe; border-radius: 5px; padding: 2px 6px;
    }

    #qa-question {
        line-height: 1.65 !important; color: #1e1b4b !important;
        font-size: 14px !important; font-weight: 600 !important;
    }
    #qa-timestamp { font-size: 10px !important; color: #a78bfa !important; font-style: italic; }
    #qa-options {
        list-style: none !important; margin: 0 !important; padding: 0 !important;
        display: flex; flex-direction: column; gap: 5px;
    }
    #qa-options li {
        background: #f5f3ff; border-radius: 8px; padding: 7px 11px;
        color: #3730a3 !important; font-size: 13px !important; font-weight: 500 !important;
    }
    #qa-options li::before { content: "> "; color: #a78bfa !important; font-weight: 700 !important; }
    #qa-options li.qa-none {
        color: #9ca3af !important; font-style: italic; font-size: 12px !important;
        background: transparent !important; padding: 2px 0 !important;
    }
    #qa-options li.qa-none::before { content: none !important; }

    .qa-section--answer {
        background: #f0fdf4; border: 2px solid #86efac;
        transition: border-color .3s, box-shadow .3s;
    }
    .qa-section--answer .qa-label { color: #16a34a !important; }
    .qa-section--answer.qa-pulse { animation: qa-pulse-border .65s ease; }
    @keyframes qa-pulse-border {
        0%,100% { border-color: #86efac; box-shadow: none; }
        50%      { border-color: #22c55e; box-shadow: 0 0 0 4px rgba(34,197,94,.15); }
    }

    #qa-ai {
        min-height: 28px; display: flex; flex-direction: column; gap: 8px;
        transition: opacity .18s ease, transform .18s ease;
    }
    .qa-idle {
        color: #c4b5fd !important; font-style: italic; font-size: 13px !important;
        animation: qa-breathe 3s ease-in-out infinite;
    }
    @keyframes qa-breathe { 0%,100%{opacity:.4} 50%{opacity:1} }

    .qa-loading {
        display: flex; align-items: center; gap: 9px;
        color: #7c3aed !important; font-size: 13px !important; font-weight: 500 !important;
    }
    .qa-dots { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }
    .qa-dots span {
        width: 6px; height: 6px; border-radius: 50%; background: #a78bfa;
        animation: qa-bounce .9s ease-in-out infinite;
    }
    .qa-dots span:nth-child(2) { animation-delay: .18s; }
    .qa-dots span:nth-child(3) { animation-delay: .36s; }
    @keyframes qa-bounce {
        0%,60%,100% { transform: translateY(0); opacity: .5; }
        30%          { transform: translateY(-6px); opacity: 1; }
    }

    .qa-answer-wrap {
        display: flex; flex-direction: column; gap: 9px;
        animation: qa-appear .35s cubic-bezier(.34,1.56,.64,1);
    }
    @keyframes qa-appear {
        from { opacity: 0; transform: translateY(8px) scale(.97); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .qa-answer-row { display: flex; align-items: center; gap: 10px; }
    .qa-badge {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 36px; height: 36px; padding: 0 6px; flex-shrink: 0;
        background: linear-gradient(135deg, #6c63ff, #a78bfa);
        color: #fff !important; font-size: 20px !important; font-weight: 900 !important;
        border-radius: 9px;
    }
    .qa-answer-text {
        color: #15803d !important; font-weight: 800 !important;
        font-size: 18px !important; line-height: 1.25 !important; cursor: pointer;
    }
    .qa-answer-text:hover { text-decoration: underline; }
    .qa-answer-text--sm { font-size: 15px !important; }
    .qa-answer-text.qa-filled {
        opacity: .45 !important; text-decoration: line-through !important; cursor: default !important;
    }
    .qa-reason {
        color: #6b7280 !important; font-size: 11px !important;
        font-style: italic; line-height: 1.5 !important; padding-left: 2px;
    }
    .qa-hint {
        font-size: 11px !important; color: #15803d !important; font-weight: 600 !important;
        background: #dcfce7; border-radius: 6px; padding: 4px 9px;
    }
    .qa-visual-pending {
        font-size: 11px !important; color: #a78bfa !important;
        font-style: italic; animation: qa-breathe 2s ease-in-out infinite;
    }
    .qa-error { color: #dc2626 !important; font-size: 13px !important; font-weight: 500 !important; }

    .qa-btn-row { display: flex; gap: 6px; margin-top: 2px; }
    .qa-btn {
        display: inline-flex; align-items: center; justify-content: center;
        padding: 6px 14px; border-radius: 8px; flex: 1;
        font-size: 12px !important; font-weight: 700 !important;
        cursor: pointer; transition: background .15s, transform .1s;
        border: none; line-height: 1 !important;
    }
    .qa-btn:hover:not(:disabled) { transform: translateY(-1px); }
    .qa-btn:disabled { opacity: .55; cursor: default; transform: none; }
    .qa-btn--scan {
        background: #f5f3ff; color: #7c3aed !important; border: 1.5px solid #ddd6fe;
    }
    .qa-btn--scan:hover:not(:disabled) { background: #ede9fe; border-color: #c4b5fd; }
    `;

    // ── Overlay HTML ───────────────────────────────────────────────────────────
    const overlay = document.createElement("div");
    overlay.id = "qa-overlay";
    overlay.innerHTML = `
        <div id="qa-header">
            <span id="qa-title">✶ Sheja Asks<span id="qa-q-count" style="display:none"></span></span>
            <div id="qa-controls">
                <button id="qa-toggle" title="Toggle question &amp; options">Show Q</button>
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
        }, 140);
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

            const row = document.createElement("div");
            row.className = "qa-btn-row";
            const btn = document.createElement("button");
            btn.className = "qa-btn qa-btn--scan";
            btn.textContent = "↺ Scan";
            btn.addEventListener("click", () => scanScreen());
            row.appendChild(btn);
            wrap.appendChild(row);

            el.appendChild(wrap);
        });
    }

    function showAnswer(answer, provider, isVisual, visualPending, autoFill) {
        const NAMES = { claude: "Claude", openai: "ChatGPT", gemini: "Gemini", mistral: "Mistral" };

        // Parse "answer — reason" or "answer - reason"
        const dashIdx = answer.search(/\s*[—–]\s*|\s+-\s+/);
        const raw     = (dashIdx > 0 ? answer.slice(0, dashIdx) : answer).trim();
        const fillText = raw.replace(/\s+logo$/i, "").trim();
        const reason   = dashIdx > 0 ? answer.slice(dashIdx).replace(/^\s*[-—–]\s*/, "").trim() : "";

        // Single letter/digit choice (A–E, 1–9) → show as badge
        const choiceMatch = fillText.match(/^([A-Ea-e]|[1-9])\.?$/);
        const badge       = choiceMatch ? fillText.replace(".", "").toUpperCase() : null;

        setProviderBadge(isVisual ? (NAMES[provider] || provider) + " 📷" : (NAMES[provider] || provider));

        fadeAiTo(el => {
            let filled = false;

            function doFill() {
                if (filled) return;
                filled = true;
                textEl.classList.add("qa-filled");

                const selected = clickAnswer(fillText);
                if (selected) {
                    log("fill", { ans: fillText, method: "click_btn" });
                    setTimeout(autoSubmit, SUBMIT_INIT_MS);
                } else {
                    const input = findTextInput();
                    if (input) {
                        fillInput(input, fillText);
                        log("fill", { ans: fillText, method: "fill_input" });
                        setTimeout(autoSubmit, 60);
                    } else {
                        // Nothing to fill — reset so user can retry
                        filled = false;
                        textEl.classList.remove("qa-filled");
                        log("fill", { ans: fillText, method: "no_target" });
                    }
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
            textEl.className = "qa-answer-text" + (fillText.length > 20 ? " qa-answer-text--sm" : "");
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

            if (reason && !badge) {
                const reasonEl = document.createElement("div");
                reasonEl.className = "qa-reason";
                reasonEl.textContent = reason;
                wrap.appendChild(reasonEl);
            }

            if (!overlayAnswers.length) {
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

            const btnRow = document.createElement("div");
            btnRow.className = "qa-btn-row";
            const scanBtn = document.createElement("button");
            scanBtn.className = "qa-btn qa-btn--scan";
            scanBtn.textContent = "↺ Scan";
            scanBtn.addEventListener("click", () => {
                // Prefer fresh DOM state at click time — quiz may have advanced since render
                const freshQ = scanForCurrentQuestion() || overlayQuestion;
                const freshA = extractAnswers();
                scanScreen(freshQ, freshA.length >= 2 ? freshA : overlayAnswers);
            });
            btnRow.appendChild(scanBtn);
            wrap.appendChild(btnRow);

            // Auto-fill only on manual rescan, not on auto-detected questions
            if (autoFill && !visualPending) setTimeout(doFill, AUTOFILL_MS);

            el.appendChild(wrap);
        });
    }

    // ── Screenshot ─────────────────────────────────────────────────────────────
    function captureScreen(callback) {
        overlay.style.visibility = "hidden";
        const deadline = Date.now() + IMG_WAIT_MS;

        function checkImages() {
            const pending = [...document.querySelectorAll("img")].find(img => {
                if (img.closest("#qa-overlay") || img.complete) return false;
                const r = img.getBoundingClientRect();
                return r.width > 180 && r.height > 130 && r.top < window.innerHeight && r.bottom > 0;
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
    function askAI(question, answers, imageDataUrl, autoFill) {
        const myId = ++reqId;
        const q    = question; // already cleaned during detection via truncateAtQuestionMark
        const ans  = answers || [];

        if (imageDataUrl) {
            // Explicit screenshot provided — send directly to vision model
            showLoading("Scanning image…");
            log("call", { id: myId, mode: "vision-direct", q });
            runtimeSend({ action: "askAI", question: q, answers: ans, imageDataUrl }, resp => {
                if (myId !== reqId) return;
                if (resp?.answer) {
                    log("resp", { id: myId, ans: resp.answer, prov: resp.provider });
                    showAnswer(resp.answer, resp.provider, true, false, autoFill);
                } else {
                    log("err", { id: myId, error: resp?.error });
                    showError(resp?.error ?? "No response from AI");
                }
            });
            return;
        }

        const isVisual = detectVisualQuestion() || looksLikeVisualQuestion(q);

        if (isVisual) {
            // Visual question: fire silent text draft + vision in parallel.
            // Only the vision answer is shown — text draft is a fallback if vision fails.
            showLoading("Scanning image…");
            log("call", { id: myId, mode: "visual", q });

            let visualDone    = false;
            let textDraftAns  = null;
            let textDraftProv = null;

            runtimeSend({ action: "askAI", question: q, answers: ans }, resp => {
                if (myId !== reqId || visualDone) return;
                if (resp?.answer) { textDraftAns = resp.answer; textDraftProv = resp.provider; }
            });

            captureScreen((dataUrl, err) => {
                if (myId !== reqId) return;
                visualDone = true;
                if (!dataUrl) {
                    log("err", { id: myId, error: err, mode: "screenshot" });
                    if (textDraftAns) showAnswer(textDraftAns, textDraftProv, false, false, autoFill);
                    else showError(err || "Screenshot failed");
                    return;
                }
                log("call", { id: myId, mode: "vision", kb: Math.round(dataUrl.length / 1024) });
                runtimeSend({ action: "askAI", question: q, answers: ans, imageDataUrl: dataUrl }, resp => {
                    if (myId !== reqId) return;
                    if (resp?.answer) {
                        log("resp", { id: myId, ans: resp.answer, prov: resp.provider, mode: "vision" });
                        showAnswer(resp.answer, resp.provider, true, false, autoFill);
                    } else {
                        log("err", { id: myId, error: resp?.error, mode: "vision" });
                        if (textDraftAns) showAnswer(textDraftAns, textDraftProv, false, false, autoFill);
                        else showError(resp?.error ?? "No response from AI");
                    }
                });
            });
            return;
        }

        // Text-only question
        showLoading();
        log("call", { id: myId, mode: "text", q });
        runtimeSend({ action: "askAI", question: q, answers: ans }, resp => {
            if (myId !== reqId) return;
            if (resp?.answer) {
                log("resp", { id: myId, ans: resp.answer, prov: resp.provider, mode: "text" });
                showAnswer(resp.answer, resp.provider, false, false, autoFill);
            } else {
                log("err", { id: myId, error: resp?.error, mode: "text" });
                showError(resp?.error ?? "No response from AI");
            }
        });
    }

    // Manual scan — always passes autoFill=true so answer is applied automatically
    function scanScreen(snapQ, snapA) {
        const q   = snapQ !== undefined ? snapQ : overlayQuestion;
        const ans = snapA !== undefined ? snapA : extractAnswers();
        showLoading("Scanning screen…");
        captureScreen((dataUrl, err) => {
            if (dataUrl) {
                askAI(q || "What is shown in this image?", ans, dataUrl, true);
            } else {
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
        if (btn) { btn.textContent = questionVisible ? "Hide Q" : "Show Q"; btn.classList.toggle("qa-on", questionVisible); }
    }

    function mountOverlay() {
        if (!document.body) { setTimeout(mountOverlay, 200); return; }
        if (document.body.contains(overlay)) return;

        const head = document.head || document.documentElement;
        if (!head.contains(overlayStyle)) head.appendChild(overlayStyle);
        document.body.appendChild(overlay);
        restorePosition();

        overlay.querySelector("#qa-close").addEventListener("click", () => {
            observer.disconnect();
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
    }

    function updateOverlay() {
        mountOverlay();

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
    function recordQuestion(questionText) {
        const answers     = extractAnswers();
        const fingerprint = questionText + "\n" + answers.join("|");
        if (fingerprint === lastFingerprint) return;
        lastFingerprint = fingerprint;
        questionCount++;

        overlayQuestion = questionText;
        overlayAnswers  = answers.length >= 2 ? answers : [];

        log("question", { q: questionText, opts: overlayAnswers, count: questionCount });
        updateOverlay();
        askAI(questionText, overlayAnswers);
    }

    // ── Question detection ─────────────────────────────────────────────────────
    function processText(raw) {
        const text = normalize(raw);
        if (text.length < 8 || text.length > 300) return;
        if (isJunk(text) || !looksLikeQuestion(text)) return;

        const clean = truncateAtQuestionMark(dedupeQuestion(text));

        if (clean.length < 8 || clean.trim().split(/\s+/).length < 3) return;
        if (isBetterCandidate(clean, candidateQ)) candidateQ = clean;
    }

    function scheduleFlush() {
        if (candidateTimer) clearTimeout(candidateTimer);
        candidateTimer = setTimeout(() => {
            const q    = candidateQ;
            candidateQ = "";
            candidateTimer = null;
            if (q) recordQuestion(q);
        }, DEBOUNCE_MS);
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
            if (!overlayQuestion) return;
            const current = extractAnswers();
            if (current.length < 2 || current.join("|") === overlayAnswers.join("|")) return;
            const freshQ = scanForCurrentQuestion() || overlayQuestion;
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
