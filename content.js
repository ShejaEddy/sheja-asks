(() => {
    'use strict';

    // ── State ──────────────────────────────────────────────────────────────────
    const STORAGE_KEY = "__quiz_logs";
    const MAX_LOGS    = 1000;
    const logs        = [];

    let lastFingerprint   = "";
    let candidateQuestion = "";
    let candidateTimer    = null;
    let overlayQuestion   = "";
    let overlayAnswers    = [];
    let isDragging        = false;
    let dragX = 0, dragY = 0;
    let questionVisible   = false;
    let reqId             = 0;
    let currentProvider   = "claude";
    let questionCount     = 0;
    let logSeq            = 0;

    const mutationBatch = new Set();
    let rafPending = false;

    const PROVIDER_NAMES = {
        claude: "Claude", openai: "ChatGPT", gemini: "Gemini", mistral: "Mistral"
    };

    const IGNORED_PATTERNS = [
        "window.dataLayer", "__N_SSP", "pageProps", ".indiana-scroll-container",
        "overflow:", "scrollbar", "gtag(", '"props":', "buildId",
        "scriptLoader", "Play NowPlay", "Recently published",
        "Enter PIN", "Start vote mode", "Quiz.com",
        // Quiz.com host/lobby UI blobs
        "PIN#", "hosting?", "continue hosting", "stop hosting",
        "Slide 1/", "Slide 2/", "Slide 3/", "Slide 4/", "Slide 5/",
        "Slide 6/", "Slide 7/", "Slide 8/", "Slide 9/",
        ">0(1)", "0 (1)", "would you like to"
    ];

    const IGNORED_ANSWERS = [
        "Select one", "Select one or more", "Next", "Back", "Join",
        "Play", "Create", "Kick Players", "Try", "Submit", "Check",
        "Show Q", "Hide Q", "Scan", "↺ Scan",
        // Quiz.com host toolbar buttons
        "Quiz editor", "Quiz generator", "Quiz library",
        "Keep hosting", "Stop hosting", "Leave", "Cancel",
        "editor", "generator", "hosting", "library"
    ];

    // ── Debug logging ──────────────────────────────────────────────────────────
    const DBG_STYLES = {
        question:     "color:#7c3aed;font-weight:bold",
        options:      "color:#16a34a;font-weight:bold",
        ai_call:      "color:#0ea5e9;font-weight:bold",
        ai_response:  "color:#f59e0b;font-weight:bold",
        ai_error:     "color:#dc2626;font-weight:bold",
        visual:       "color:#8b5cf6;font-weight:bold",
        screenshot:   "color:#ec4899;font-weight:bold",
        candidate:    "color:#64748b",
        deduped:      "color:#94a3b8",
        filter:       "color:#94a3b8",
        default:      "color:#6b7280"
    };

    function dbg(type, ...args) {
        const style = DBG_STYLES[type] || DBG_STYLES.default;
        console.log(`%c[Sheja:${type}]`, style, ...args);
    }

    // ── Provider cache ─────────────────────────────────────────────────────────
    chrome.storage.sync.get("provider", s => {
        if (s.provider) currentProvider = s.provider;
    });
    chrome.storage.onChanged.addListener(changes => {
        if (changes.provider?.newValue) currentProvider = changes.provider.newValue;
    });

    // ── Utilities ──────────────────────────────────────────────────────────────
    function normalize(text) {
        return (text || "").replace(/\s+/g, " ").trim();
    }

    function saveLogs() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(logs)); } catch (e) {}
    }

    // Structured log — entries are objects spread directly into the record.
    // Run in console:  copy(localStorage.getItem("__quiz_logs"))  to export.
    function log(t, payload) {
        const entry = { ts: Date.now(), seq: ++logSeq, t };
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
            Object.assign(entry, payload);
        } else {
            entry.d = payload;
        }
        logs.push(entry);
        if (logs.length > MAX_LOGS) logs.shift();
        saveLogs();
    }

    // Snapshot of relevant DOM state — images, buttons, input presence.
    // Kept compact so logs stay under localStorage quota.
    function capturePageState() {
        const vh = window.innerHeight, vw = window.innerWidth;
        const imgs = [...document.querySelectorAll("img, canvas")]
            .filter(el => !el.closest("#qa-overlay"))
            .map(el => {
                const r = el.getBoundingClientRect();
                const src = el.tagName === "IMG"
                    ? (el.src || "").replace(/^.*\//, "").slice(0, 60)
                    : "canvas";
                return { tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height), src, inVp: r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0 };
            })
            .filter(i => i.w > 30 || i.h > 30)
            .slice(0, 8);

        const btns = [...document.querySelectorAll("button, [role='button'], [role='option']")]
            .filter(el => !el.closest("#qa-overlay"))
            .map(el => {
                const r = el.getBoundingClientRect();
                const t = normalize(el.innerText || el.textContent || "").slice(0, 50);
                return { t, w: Math.round(r.width), h: Math.round(r.height), inVp: r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw };
            })
            .filter(b => b.t.length > 0 && b.w > 10)
            .slice(0, 15);

        return { imgs, btns, inp: !!findTextInput(), visQ: detectVisualQuestion() };
    }

    function isJunk(text) {
        if (!text || text.length < 8) return true;
        return IGNORED_PATTERNS.some(p => text.includes(p));
    }

    function looksLikeQuestion(text) {
        return (
            text.includes("?") ||
            /^(who|what|which|where|when|why|how|name|identify|describe|choose|select|guess)\b/i.test(text)
        );
    }

    // Quiz.com renders the question text 2-3× in a row inside the same element.
    // "Guess the logoGuess the logo..." → "Guess the logo"
    function dedupeQuestion(text) {
        for (let len = 5; len <= Math.floor(text.length / 2); len++) {
            if (text.slice(0, len) === text.slice(len, len * 2)) {
                dbg("deduped", `"${text.slice(0,40)}..." → "${text.slice(0,len)}"`);
                return text.slice(0, len).trim();
            }
        }
        return text;
    }

    // Returns true when a content-sized image/canvas is visible — avoids triggering on icons/avatars
    function detectVisualQuestion() {
        for (const el of document.querySelectorAll("img, canvas")) {
            if (el.closest("#qa-overlay")) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 180 && r.height > 130 && r.top < window.innerHeight && r.bottom > 0) {
                return true;
            }
        }
        return false;
    }

    // Returns true when the question text implies a visual/image answer
    function looksLikeVisualQuestion(text) {
        return /\b(logo|flag|country|animal|image|photo|picture|brand|icon|landmark|artwork)\b/i.test(text) ||
               /^guess\b/i.test(text);
    }

    // A candidate looks like the START of a sentence when it begins with an uppercase letter
    // or a known question-opener word. Fragments like "long to?" (from quiz.com's animated
    // multi-span rendering of "be|long to?") start lowercase and are not question openers.
    function candidateIsClean(s) {
        return /^[A-Z]/.test(s) ||
               /^(who|what|which|where|when|why|how|name|identify|describe|choose|select|guess)\b/i.test(s);
    }

    function isBetterCandidate(newC, oldC) {
        const newClean = candidateIsClean(newC);
        const oldClean = candidateIsClean(oldC);
        // Always prefer a clean-starting candidate over a fragment
        if (newClean && !oldClean) return true;
        if (!newClean && oldClean) return false;
        // Both clean (or both fragments) — prefer longer when one is a prefix of the other
        const nl = newC.toLowerCase(), ol = oldC.toLowerCase();
        const [longer, shorter] = nl.length >= ol.length ? [nl, ol] : [ol, nl];
        if (longer.startsWith(shorter)) return newC.length > oldC.length;
        // Neither is a prefix — prefer longer: riddles/multi-line questions need full context
        return newC.length > oldC.length;
    }

    // Simulate a real user click — dispatches full pointer+mouse sequence so React picks it up
    function simulateClick(el) {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top  + r.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
        ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(type => {
            el.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, opts));
        });
    }

    // Click the on-page answer button whose text matches the given answer string
    function clickAnswer(text) {
        const target = text.toLowerCase().trim();
        const buttons = [...document.querySelectorAll("button, [role='button'], [role='option']")]
            .filter(el => {
                if (el.closest("#qa-overlay")) return false;
                const t = normalize(el.innerText || el.textContent || "").toLowerCase();
                const rect = el.getBoundingClientRect();
                return rect.width >= 60 && rect.height >= 20 &&
                    (t === target || t.startsWith(target) || target.startsWith(t.slice(0, Math.min(t.length, 6))));
            });
        if (buttons.length) { simulateClick(buttons[0]); return true; }
        return false;
    }

    // ── Styles ─────────────────────────────────────────────────────────────────
    const overlayStyle = document.createElement("style");
    overlayStyle.textContent = `
    #qa-overlay {
        position: fixed;
        top: 50%;
        right: 20px;
        transform: translateY(-50%);
        width: min(320px, calc(100vw - 24px));
        background: #fff;
        border: 1.5px solid #ddd6fe;
        border-radius: 16px;
        z-index: 2147483647 !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
        font-size: 13px !important;
        box-shadow: 0 12px 40px rgba(109,40,217,.16), 0 2px 8px rgba(0,0,0,.06);
        overflow: hidden;
        transition: box-shadow .2s;
    }
    #qa-overlay.qa-dragging {
        box-shadow: 0 20px 60px rgba(109,40,217,.26), 0 4px 16px rgba(0,0,0,.12);
    }
    #qa-overlay * { box-sizing: border-box !important; line-height: normal !important; }

    #qa-header {
        display: flex; align-items: center;
        padding: 11px 12px;
        background: linear-gradient(135deg, #6c63ff, #a78bfa);
        cursor: grab; user-select: none; gap: 8px;
    }
    #qa-header:active { cursor: grabbing; }
    #qa-title { font-weight: 700 !important; font-size: 14px !important; color: #fff !important; flex: 1; white-space: nowrap; display: flex; align-items: center; gap: 7px; }
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
        color: #fff !important; width: 26px; height: 26px;
        border-radius: 50%; cursor: pointer; font-size: 14px !important;
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
    #qa-content::-webkit-scrollbar-track { background: transparent; }

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

    #qa-question { line-height: 1.65 !important; color: #1e1b4b !important; font-size: 14px !important; font-weight: 600 !important; }
    #qa-timestamp { font-size: 10px !important; color: #a78bfa !important; font-style: italic; }

    #qa-options { list-style: none !important; margin: 0 !important; padding: 0 !important; display: flex; flex-direction: column; gap: 5px; }
    #qa-options li {
        background: #f5f3ff; border-radius: 8px; padding: 7px 11px;
        color: #3730a3 !important; font-size: 13px !important; font-weight: 500 !important;
    }
    #qa-options li::before { content: "> "; color: #a78bfa !important; font-weight: 700 !important; }

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

    /* ── Answer display ─────────────────────────────────── */
    .qa-answer-main-row {
        display: flex; align-items: center; gap: 10px;
    }
    .qa-type-hint {
        font-size: 11px !important; color: #15803d !important; font-weight: 600 !important;
        background: #dcfce7; border-radius: 6px; padding: 4px 9px; margin-top: 2px;
    }
    .qa-options-none {
        color: #9ca3af !important; font-style: italic; font-size: 12px !important;
        background: transparent !important; padding: 2px 0 !important;
    }
    .qa-options-none::before { content: none !important; }
    /* Badge for single-letter/number choices: A B C D / 1 2 3 4 */
    .qa-choice-badge {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 36px; height: 36px; padding: 0 6px; flex-shrink: 0;
        background: linear-gradient(135deg, #6c63ff, #a78bfa);
        color: #fff !important; font-size: 20px !important; font-weight: 900 !important;
        border-radius: 9px; letter-spacing: -0.5px;
    }
    /* The answer word/phrase — clickable to auto-select on the page */
    .qa-answer-text {
        color: #15803d !important; font-weight: 800 !important;
        font-size: 18px !important; line-height: 1.25 !important;
        cursor: pointer;
    }
    .qa-answer-text:hover { text-decoration: underline; }
    .qa-answer-text--sm {
        font-size: 15px !important;
    }
    /* The explanation below */
    .qa-answer-reason {
        color: #6b7280 !important; font-size: 11px !important;
        font-style: italic; line-height: 1.5 !important;
        padding-left: 2px;
    }

    .qa-error  { color: #dc2626 !important; font-size: 13px !important; font-weight: 500 !important; }

    .qa-visual-tag {
        font-size: 9px !important; font-weight: 700 !important;
        background: #fef3c7; color: #92400e !important;
        border: 1px solid #fcd34d; border-radius: 5px; padding: 2px 6px;
        vertical-align: middle; margin-left: 4px;
    }

    .qa-visual-pending {
        font-size: 11px !important; color: #a78bfa !important;
        font-style: italic; animation: qa-breathe 2s ease-in-out infinite;
    }

    .qa-scan-notice {
        font-size: 11px !important; color: #92400e !important;
        background: #fef3c7; border-radius: 6px; padding: 5px 9px; font-style: italic;
    }

    .qa-btn-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }

    .qa-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 4px;
        padding: 6px 14px; border-radius: 8px; flex: 1;
        font-size: 12px !important; font-weight: 700 !important;
        cursor: pointer; transition: background .15s, transform .1s;
        border: none; line-height: 1 !important;
    }
    .qa-btn:hover:not(:disabled) { transform: translateY(-1px); }
    .qa-btn:disabled { opacity: .55; cursor: default; transform: none; }
    .qa-btn--fill    { background: #16a34a; color: #fff !important; }
    .qa-btn--fill:hover:not(:disabled) { background: #15803d; }
    .qa-btn--outline { background: #f5f3ff; color: #7c3aed !important; border: 1.5px solid #ddd6fe; }
    .qa-btn--outline:hover:not(:disabled) { background: #ede9fe; border-color: #c4b5fd; }
    `;

    // ── Overlay HTML ───────────────────────────────────────────────────────────
    const overlay = document.createElement("div");
    overlay.id = "qa-overlay";
    overlay.innerHTML = `
        <div id="qa-header">
            <span id="qa-title">✶ Sheja Asks<span id="qa-q-count" style="display:none"></span></span>
            <div id="qa-controls">
                <button id="qa-toggle" title="Toggle question &amp; options">Show Q</button>
                <button class="qa-icon-btn" id="qa-min" title="Minimize/restore">─</button>
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
                <div id="qa-ai">
                    <span class="qa-idle">Waiting for a question...</span>
                </div>
            </div>
        </div>
    `;

    // ── Session persistence ────────────────────────────────────────────────────
    function restoreSession() {
        try {
            const pos = JSON.parse(sessionStorage.getItem("__sheja_pos") || "null");
            if (pos?.left) {
                overlay.style.top       = pos.top;
                overlay.style.left      = pos.left;
                overlay.style.right     = "auto";
                overlay.style.transform = "none";
            }
        } catch (e) {}

        if (sessionStorage.getItem("__sheja_showq") === "1") {
            questionVisible = true;
            const btn = overlay.querySelector("#qa-toggle");
            if (btn) { btn.textContent = "Hide Q"; btn.classList.add("qa-on"); }
            overlay.querySelector("#qa-question-section")?.classList.remove("qa-hidden");
            overlay.querySelector("#qa-options-section")?.classList.remove("qa-hidden");
        }
    }

    function savePosition() {
        sessionStorage.setItem("__sheja_pos", JSON.stringify({
            left: overlay.style.left,
            top:  overlay.style.top
        }));
    }

    // ── AI state helpers ───────────────────────────────────────────────────────
    let _fadeTimer = null;

    function fadeAiTo(buildFn) {
        const el = document.getElementById("qa-ai");
        if (!el) return;
        // Cancel any in-flight fade — prevents stale "Done" state from a previous question
        // briefly appearing after the new question clears the element
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

    function updateProviderBadge(name) {
        const b = document.getElementById("qa-provider-badge");
        if (b) b.textContent = name || "";
    }

    function showLoading(label) {
        const name = PROVIDER_NAMES[currentProvider] || "AI";
        updateProviderBadge(name);
        fadeAiTo(el => {
            el.innerHTML = `
                <span class="qa-loading">
                    <span class="qa-dots"><span></span><span></span><span></span></span>
                    ${label || "Asking " + name + "..."}
                </span>`;
        });
    }

    // isVisual: answer came from a screenshot call; visualPending: text answer shown while vision still processing
    function showAnswer(answer, provider, isVisual, visualPending, autoFill) {
        const name = PROVIDER_NAMES[provider || currentProvider] || "AI";

        // Parse "Answer text — Reason sentence" (also handles Mistral's " - " hyphen separator)
        const dashIdx = answer.search(/\s*[—–]\s*|\s+-\s+/);
        const rawFill = (dashIdx > 0 ? answer.slice(0, dashIdx) : answer).trim();
        // Strip trailing " logo" / " Logo" — quiz inputs expect just the brand name
        const fillText = rawFill.replace(/\s+logo$/i, "").trim();
        const reason   = dashIdx > 0 ? answer.slice(dashIdx).replace(/^\s*[-—–]\s*/, "").trim() : "";

        // Single letter (A–E) or single digit (1–9) → show as badge
        const choiceMatch = fillText.match(/^([A-Ea-e]|[1-9])\.?$/);
        const badge       = choiceMatch ? fillText.replace(".", "").toUpperCase() : null;

        updateProviderBadge(isVisual ? name + " 📷" : name);

        fadeAiTo(el => {
            const wrap = document.createElement("div");
            wrap.className = "qa-answer-wrap";

            const mainRow = document.createElement("div");
            mainRow.className = "qa-answer-main-row";

            if (badge) {
                const badgeEl = document.createElement("span");
                badgeEl.className = "qa-choice-badge";
                badgeEl.textContent = badge;
                mainRow.appendChild(badgeEl);
            }

            const mainLabel = badge ? (reason || fillText) : fillText;
            const textEl = document.createElement("span");
            textEl.className = "qa-answer-text" + (mainLabel.length > 20 ? " qa-answer-text--sm" : "");
            textEl.textContent = mainLabel;
            // Click answer text → try to click the matching button on the page
            // Disabled while vision scan is pending so the text draft can't be submitted early
            textEl.style.cursor = visualPending ? "default" : "pointer";
            textEl.style.opacity = visualPending ? "0.55" : "1";
            textEl.title = visualPending ? "Waiting for image scan…" : "Click to select this answer";
            let filled = false;

            function doFill() {
                if (filled) return;
                filled = true;
                textEl.style.opacity = "0.5";
                textEl.style.textDecoration = "line-through";
                const selected = clickAnswer(fillText);
                if (selected) {
                    log("fill", { ans: fillText, method: "click_btn" });
                    setTimeout(autoSubmit, 400);
                } else {
                    const target = findTextInput();
                    if (target) {
                        fillInput(target, fillText);
                        log("fill", { ans: fillText, method: "fill_input" });
                        setTimeout(autoSubmit, 60);
                    } else {
                        log("fill", { ans: fillText, method: "no_target" });
                        filled = false;
                        textEl.style.opacity = "1";
                        textEl.style.textDecoration = "";
                    }
                }
            }

            textEl.addEventListener("click", () => {
                if (visualPending) return;
                doFill();
            });
            mainRow.appendChild(textEl);
            wrap.appendChild(mainRow);

            if (reason && !badge) {
                const reasonEl = document.createElement("div");
                reasonEl.className = "qa-answer-reason";
                reasonEl.textContent = reason;
                wrap.appendChild(reasonEl);
            }

            if (!overlayAnswers.length) {
                const hint = document.createElement("div");
                hint.className = "qa-type-hint";
                hint.textContent = "📝 Open question — click answer to fill";
                wrap.appendChild(hint);
            }

            if (visualPending) {
                const pending = document.createElement("div");
                pending.className = "qa-visual-pending";
                pending.textContent = "📷 Checking with screenshot...";
                wrap.appendChild(pending);
            }

            const row = document.createElement("div");
            row.className = "qa-btn-row";

            const retryBtn = document.createElement("button");
            retryBtn.className = "qa-btn qa-btn--outline";
            retryBtn.textContent = "↺ Scan";
            retryBtn.title = "Scan screen with screenshot";
            const snapQ = overlayQuestion;
            const snapA = [...overlayAnswers];
            retryBtn.addEventListener("click", () => scanScreen("retry", snapQ, snapA));
            row.appendChild(retryBtn);

            // Auto-fill and submit once the answer is rendered — only for manual re-scan
            if (autoFill && !visualPending) {
                setTimeout(doFill, 700);
            }

            wrap.appendChild(row);
            el.appendChild(wrap);
        });
    }

    function showError(msg) {
        updateProviderBadge("");
        fadeAiTo(el => {
            const wrap = document.createElement("div");
            wrap.className = "qa-answer-wrap";

            const errEl = document.createElement("div");
            errEl.className = "qa-error";
            errEl.textContent = "⚠ " + msg;
            wrap.appendChild(errEl);

            const row = document.createElement("div");
            row.className = "qa-btn-row";

            const retryBtn = document.createElement("button");
            retryBtn.className = "qa-btn qa-btn--outline";
            retryBtn.textContent = "↺ Retry";
            retryBtn.addEventListener("click", () => scanScreen());
            row.appendChild(retryBtn);

            wrap.appendChild(row);
            el.appendChild(wrap);
        });
    }

    // ── Overlay mount & interactions ───────────────────────────────────────────
    function mountOverlay() {
        if (!document.body) { setTimeout(mountOverlay, 200); return; }
        if (document.body.contains(overlay)) return;

        const head = document.head || document.documentElement;
        if (!head.contains(overlayStyle)) head.appendChild(overlayStyle);
        document.body.appendChild(overlay);
        restoreSession();

        overlay.querySelector("#qa-close")?.addEventListener("click", () => overlay.remove());

        overlay.querySelector("#qa-min")?.addEventListener("click", () => {
            const c = document.getElementById("qa-content");
            if (c) c.style.display = c.style.display === "none" ? "" : "none";
        });

        overlay.querySelector("#qa-toggle")?.addEventListener("click", () => {
            questionVisible = !questionVisible;
            const btn = document.getElementById("qa-toggle");
            const qs  = document.getElementById("qa-question-section");
            const os  = document.getElementById("qa-options-section");
            qs?.classList.toggle("qa-hidden", !questionVisible);
            os?.classList.toggle("qa-hidden", !questionVisible);
            if (btn) { btn.textContent = questionVisible ? "Hide Q" : "Show Q"; btn.classList.toggle("qa-on", questionVisible); }
            sessionStorage.setItem("__sheja_showq", questionVisible ? "1" : "0");
        });

        const header = document.getElementById("qa-header");
        header?.addEventListener("mousedown", e => {
            if (e.target.closest("#qa-controls")) return;
            isDragging = true;
            const rect = overlay.getBoundingClientRect();
            dragX = e.clientX - rect.left;
            dragY = e.clientY - rect.top;
            // Set inline styles BEFORE adding class — CSS !important would otherwise override them
            overlay.style.top       = rect.top  + "px";
            overlay.style.left      = rect.left + "px";
            overlay.style.right     = "auto";
            overlay.style.transform = "none";
            overlay.classList.add("qa-dragging");
            e.preventDefault();
        });

        document.addEventListener("mousemove", e => {
            if (!isDragging) return;
            const x = Math.max(0, Math.min(e.clientX - dragX, window.innerWidth  - overlay.offsetWidth));
            const y = Math.max(0, Math.min(e.clientY - dragY, window.innerHeight - overlay.offsetHeight));
            overlay.style.left = x + "px";
            overlay.style.top  = y + "px";
        });

        document.addEventListener("mouseup", () => {
            if (isDragging) { isDragging = false; savePosition(); }
        });
    }

    function updateOverlay() {
        mountOverlay();

        const qEl  = document.getElementById("qa-question");
        const tsEl = document.getElementById("qa-timestamp");
        const oEl  = document.getElementById("qa-options");

        if (qEl)  qEl.textContent = overlayQuestion || "Waiting for question...";
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
                li.className = "qa-options-none";
                li.textContent = "No options — type your answer";
                oEl.appendChild(li);
            }
        }

        // Pulse the answer section on new question
        const ansEl = overlay.querySelector(".qa-section--answer");
        if (ansEl) {
            ansEl.classList.remove("qa-pulse");
            requestAnimationFrame(() => {
                ansEl.classList.add("qa-pulse");
                ansEl.addEventListener("animationend", () => ansEl.classList.remove("qa-pulse"), { once: true });
            });
        }
    }

    // ── Input detection & fill ─────────────────────────────────────────────────
    function findTextInput() {
        const inputs = [...document.querySelectorAll(
            'input[type="text"], input[type="search"], input:not([type]), textarea'
        )].filter(el => {
            if (el.closest("#qa-overlay") || el.readOnly || el.disabled) return false;
            const r = el.getBoundingClientRect();
            return r.width > 60 && r.height > 16 && r.top < window.innerHeight && r.bottom > 0;
        });
        if (inputs.length) return { el: inputs[0], type: "input" };

        const ce = [...document.querySelectorAll('[contenteditable="true"]')].find(el => {
            if (el.closest("#qa-overlay")) return false;
            const r = el.getBoundingClientRect();
            return r.width > 60 && r.height > 16 && r.top < window.innerHeight && r.bottom > 0;
        });
        return ce ? { el: ce, type: "contenteditable" } : null;
    }

    function fillInput({ el, type }, value) {
        el.focus();
        if (type === "contenteditable") {
            el.textContent = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
            const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
            if (desc?.set) desc.set.call(el, value);
            else el.value = value;
            el.dispatchEvent(new Event("input",  { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
        }
    }

    // Wraps chrome.runtime.sendMessage so that "Extension context invalidated"
    // (thrown when the extension reloads while a tab is open) is caught silently
    // instead of crashing the content script.
    function runtimeSend(msg, cb) {
        try {
            chrome.runtime.sendMessage(msg, response => {
                if (chrome.runtime.lastError) return; // context gone — ignore
                cb(response);
            });
        } catch (e) { /* context invalidated after extension reload — page must be refreshed */ }
    }

    function autoSubmit(retries) {
        if (retries === undefined) retries = 4;
        const btn = [...document.querySelectorAll("button")].find(el => {
            if (el.closest("#qa-overlay") || el.disabled) return false;
            const t = normalize(el.innerText || el.textContent || "").toLowerCase();
            return t.startsWith("try") || t === "submit" || t === "check";
        });
        if (btn) {
            log("submit", { method: "btn", label: normalize(btn.textContent || "") });
            simulateClick(btn); return;
        }
        const inputInfo = findTextInput();
        if (inputInfo?.el) {
            log("submit", { method: "enter" });
            ["keydown", "keypress", "keyup"].forEach(evt => {
                inputInfo.el.dispatchEvent(new KeyboardEvent(evt, {
                    key: "Enter", code: "Enter", keyCode: 13, which: 13,
                    bubbles: true, cancelable: true
                }));
            });
            return;
        }
        if (retries > 0) {
            setTimeout(() => autoSubmit(retries - 1), 350);
        } else {
            log("submit", { method: "none" });
        }
    }

    // ── AI integration ─────────────────────────────────────────────────────────
    function cleanQuestion(raw) {
        const deduped = dedupeQuestion(raw);
        const idx = deduped.indexOf("?");
        return (idx !== -1 ? deduped.substring(0, idx + 1) : deduped).trim();
    }

    // Silent capture: hide overlay, wait for large images to finish loading, then screenshot.
    // Quiz.com swaps answer buttons first, then asynchronously loads the new flag/image.
    // Without this wait, the screenshot captures a blank or half-loaded image.
    function captureScreen(callback) {
        overlay.style.visibility = "hidden";
        const deadline = Date.now() + 800; // max 800ms wait for images to load

        function checkImages() {
            const pending = [...document.querySelectorAll("img")].find(img => {
                if (img.closest("#qa-overlay") || img.complete) return false;
                const r = img.getBoundingClientRect();
                return r.width > 180 && r.height > 130 && r.top < window.innerHeight && r.bottom > 0;
            });
            if (!pending || Date.now() >= deadline) {
                // All large images loaded (or timed out) — now take the screenshot
                requestAnimationFrame(() => setTimeout(() => {
                    runtimeSend({ action: "takeScreenshot" }, response => {
                        overlay.style.visibility = "";
                        callback(response?.dataUrl || null, response?.error || null);
                    });
                }, 40));
            } else {
                setTimeout(checkImages, 80);
            }
        }

        requestAnimationFrame(checkImages);
    }

    // Always fires TWO parallel calls: text-only (fast) + screenshot+vision (thorough).
    // Text answer shows immediately; vision answer overrides it when it arrives.
    // Pass imageDataUrl to skip the dual-call and do a single explicit vision call.
    // forceVisual: true → always fire parallel text+vision
    function askAI(question, answers, loadingLabel, imageDataUrl, forceVisual, autoFill) {
        const myId = ++reqId;
        const q    = cleanQuestion(question);
        const ans  = answers || [];
        const prov = currentProvider;

        if (imageDataUrl) {
            // Single explicit vision call (manual 📷 or retry)
            showLoading(loadingLabel || "Scanning image…");
            const t0 = Date.now();
            log("call", { id: myId, mode: "manual", q, opts: ans, prov });
            dbg("ai_call", `MANUAL-VISION | q="${q}" | opts=${JSON.stringify(ans)}`);
            runtimeSend(
                { action: "askAI", question: q, answers: ans, imageDataUrl },
                response => {
                    if (myId !== reqId) return;
                    const ms = Date.now() - t0;
                    if (chrome.runtime.lastError) { showError("Background worker unavailable — reload extension"); return; }
                    if (response?.answer) {
                        log("resp", { id: myId, mode: "manual", ans: response.answer, prov: response.provider, ms });
                        dbg("ai_response", `MANUAL-VISION: "${response.answer}" (${response.provider}) +${ms}ms`);
                        showAnswer(response.answer, response.provider, true, false, autoFill);
                    } else {
                        log("err", { id: myId, mode: "manual", error: response?.error, ms });
                        dbg("ai_error", `MANUAL-VISION failed: ${response?.error}`);
                        showError(response?.error ?? "No response from AI");
                    }
                }
            );
            return;
        }

        const hasVisual = forceVisual || detectVisualQuestion() || looksLikeVisualQuestion(q);

        if (hasVisual) showLoading("Scanning image…");

        if (!hasVisual) {
            // Text-only question — single call
            showLoading(loadingLabel || null);
            const t0 = Date.now();
            log("call", { id: myId, mode: "text", q, opts: ans, prov });
            dbg("ai_call", `TEXT | q="${q}" | opts=${JSON.stringify(ans)}`);
            runtimeSend({ action: "askAI", question: q, answers: ans }, response => {
                if (myId !== reqId) return;
                const ms = Date.now() - t0;
                if (chrome.runtime.lastError) { showError("Background worker unavailable — reload extension"); return; }
                if (response?.answer) {
                    log("resp", { id: myId, mode: "text", ans: response.answer, prov: response.provider, ms });
                    dbg("ai_response", `TEXT: "${response.answer}" (${response.provider}) +${ms}ms`);
                    showAnswer(response.answer, response.provider, false, false, autoFill);
                } else {
                    log("err", { id: myId, mode: "text", error: response?.error, ms });
                    dbg("ai_error", `TEXT failed: ${response?.error}`);
                    showError(response?.error ?? "No response from AI");
                }
            });
            return;
        }

        // Visual question — keep loading until screenshot + vision completes.
        // Text-only draft is NOT shown for visual questions because it's usually wrong
        // (the AI guesses without seeing the image) and causes a confusing "Done" state
        // when the user clicks Fill on the wrong draft before vision arrives.
        // Text draft still fires in parallel as a silent fallback in case vision fails.
        dbg("visual", `Visual question detected — waiting for vision`);
        let visualDone  = false;
        let textDraftAns  = null;
        let textDraftProv = null;

        // 1. Text call fires silently — only shown if vision fails
        const t0txt = Date.now();
        log("call", { id: myId, mode: "text-draft", q, opts: ans, prov });
        dbg("ai_call", `TEXT-DRAFT (silent) | q="${q}" | opts=${JSON.stringify(ans)}`);
        runtimeSend({ action: "askAI", question: q, answers: ans }, textResp => {
            if (myId !== reqId || visualDone) return;
            if (chrome.runtime.lastError) return;
            const ms = Date.now() - t0txt;
            if (textResp?.answer) {
                textDraftAns  = textResp.answer;
                textDraftProv = textResp.provider;
                log("resp", { id: myId, mode: "text-draft", ans: textResp.answer, prov: textResp.provider, ms });
                dbg("ai_response", `TEXT-DRAFT (silent): "${textResp.answer}" (${textResp.provider}) +${ms}ms`);
                // Do NOT call showAnswer yet — stay on loading state until vision confirms
            } else {
                log("err", { id: myId, mode: "text-draft", error: textResp?.error, ms });
            }
        });

        // 2. Screenshot + vision — the ONE answer shown to the user
        captureScreen((dataUrl) => {
            if (!dataUrl || myId !== reqId) {
                log("shot", { id: myId, ok: false, kb: 0, note: dataUrl ? "stale" : "capture failed" });
                dbg("screenshot", dataUrl ? "stale — discarding" : "capture failed");
                // Vision can't run — fall back to text draft if available
                if (myId === reqId) {
                    visualDone = true;
                    if (textDraftAns) {
                        showAnswer(textDraftAns, textDraftProv, false, false, autoFill);
                    } else {
                        showError("Screenshot failed — check extension permissions");
                    }
                }
                return;
            }
            const kb = Math.round(dataUrl.length / 1024);
            log("shot", { id: myId, ok: true, kb });
            dbg("screenshot", `captured ${kb}KB`);
            const t0vis = Date.now();
            log("call", { id: myId, mode: "vision", q, opts: ans, prov });
            dbg("ai_call", `VISION | q="${q}" | opts=${JSON.stringify(ans)}`);
            runtimeSend(
                { action: "askAI", question: q, answers: ans, imageDataUrl: dataUrl },
                visResp => {
                    if (myId !== reqId) return;
                    const ms = Date.now() - t0vis;
                    if (visResp?.answer) {
                        log("resp", { id: myId, mode: "vision", ans: visResp.answer, prov: visResp.provider, ms });
                        dbg("ai_response", `VISION: "${visResp.answer}" (${visResp.provider}) +${ms}ms`);
                        visualDone = true;
                        showAnswer(visResp.answer, visResp.provider, true, false, autoFill);
                    } else {
                        log("err", { id: myId, mode: "vision", error: visResp?.error, ms });
                        dbg("ai_error", `VISION failed — falling back to text draft`);
                        visualDone = true;
                        if (textDraftAns) showAnswer(textDraftAns, textDraftProv, false, false, autoFill);
                        else showError(visResp?.error ?? "No response from AI");
                    }
                }
            );
        });
    }

    // Scan visible DOM for current question text (used when MutationObserver misses transitions)
    function scanForCurrentQuestion() {
        let best = "";
        document.querySelectorAll("h1,h2,h3,h4,p,span,div,label").forEach(el => {
            if (el.closest("#qa-overlay") || el.closest("button,[role='button']")) return;
            if (el.querySelectorAll("button,[role='button']").length > 0) return;
            const rect = el.getBoundingClientRect();
            if (rect.width < 80 || rect.top < -10 || rect.bottom > window.innerHeight + 10) return;
            const text = normalize(el.textContent || "");
            if (text.length < 8 || text.length > 300 || isJunk(text) || !looksLikeQuestion(text)) return;
            const deduped = dedupeQuestion(text);
            const qIdx = deduped.indexOf("?");
            const clean = qIdx !== -1 ? deduped.slice(0, qIdx + 1) : deduped;
            if (clean.length >= 8 && candidateIsClean(clean) && clean.length > best.length) best = clean;
        });
        return best || null;
    }

    // src: "btn" = 📷 button, "retry" = ↺ retry button
    function scanScreen(src, snapQ, snapA) {
        // For manual 📷 button: always pull fresh DOM state (overlay may be stale if quiz advanced)
        const q   = snapQ !== undefined ? snapQ : overlayQuestion;
        const ans = snapA !== undefined ? snapA
            : src === "btn" ? extractAnswers()
            : overlayAnswers;
        log("scan", { src: src || "btn", q, opts: ans, dom: capturePageState() });
        showLoading("Scanning screen...");
        captureScreen((dataUrl, err) => {
            if (dataUrl) {
                const kb = Math.round(dataUrl.length / 1024);
                log("shot", { src: src || "btn", ok: true, kb, q });
                askAI(q || "What is shown in this image?", ans, null, dataUrl, false, src === "retry");
            } else {
                log("shot", { src: src || "btn", ok: false, kb: 0, err });
                showError(err || "Screenshot failed — check extension permissions");
            }
        });
    }

    // ── Answer extraction ──────────────────────────────────────────────────────
    function extractAnswers() {
        const seen    = new Set();
        const answers = [];
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        document.querySelectorAll("button, [role='button'], [role='option']").forEach(el => {
            if (el.closest("#qa-overlay")) return;

            const text = normalize(el.innerText || el.textContent || "");
            if (text.length < 2 || text.length > 120) return;

            // Case-insensitive ignore check
            const lc = text.toLowerCase();
            if (IGNORED_ANSWERS.some(x => lc.includes(x.toLowerCase()))) {
                dbg("filter", `ignored answer button: "${text}"`);
                return;
            }

            // Must be a reasonably sized button (filters out toolbar icons and tiny nav items)
            const rect = el.getBoundingClientRect();
            if (rect.width < 80 || rect.height < 28) {
                dbg("filter", `too small (${Math.round(rect.width)}×${Math.round(rect.height)}): "${text}"`);
                return;
            }

            // Must be visible in the viewport
            if (rect.top < 0 || rect.bottom > vh || rect.right < 0 || rect.left > vw) return;

            if (!seen.has(text)) {
                seen.add(text);
                answers.push(text);
                dbg("filter", `accepted answer: "${text}" (${Math.round(rect.width)}×${Math.round(rect.height)})`);
            }
        });

        return answers.slice(0, 8); // cap at 8 options
    }

    // ── Question pipeline ──────────────────────────────────────────────────────
    function recordQuestion(questionText) {
        // Deduplicate by question+answers fingerprint — handles same-template quizzes
        // where the question text stays the same but options change each round
        const answers    = extractAnswers();
        const fingerprint = questionText + "\n" + answers.join("|");
        if (fingerprint === lastFingerprint) return;
        lastFingerprint = fingerprint;
        overlayQuestion = questionText;

        // Immediately wipe the old answer so Fill/"✓ Done" buttons don't linger
        const aiEl = document.getElementById("qa-ai");
        if (aiEl) { aiEl.innerHTML = ""; aiEl.style.opacity = ""; aiEl.style.transform = ""; }

        questionCount++;
        const cntEl = document.getElementById("qa-q-count");
        if (cntEl) { cntEl.textContent = "#" + questionCount; cntEl.style.display = ""; }

        overlayAnswers = answers.length >= 2 ? answers : [];

        const dom = capturePageState();
        log("q", {
            text:  questionText,
            n:     questionCount,
            isVis: dom.visQ || looksLikeVisualQuestion(questionText),
            opts:  overlayAnswers,
            imgs:  dom.imgs,
            btns:  dom.btns,
            inp:   dom.inp
        });
        dbg("question", `NEW QUESTION #${questionCount}: "${questionText}" (${questionText.length} chars)`);

        updateOverlay();
        askAI(questionText, overlayAnswers);
    }

    function processText(rawText) {
        if (!rawText) return;
        const len = rawText.length;
        if (len < 8 || len > 600) return; // 600 is already longer than any real question
        const text = normalize(rawText);
        if (isJunk(text) || !looksLikeQuestion(text)) return;

        // Deduplicate repeated substrings before comparing candidates
        const cleaned = dedupeQuestion(text);
        if (cleaned.length < 8) return;

        // Truncate at the first ? — strips button labels that quiz.com appends to container text
        const qIdx = cleaned.indexOf("?");
        const truncated = qIdx !== -1 ? cleaned.slice(0, qIdx + 1) : cleaned;
        if (truncated.length < 8) return;

        if (!candidateQuestion || isBetterCandidate(truncated, candidateQuestion)) {
            dbg("candidate", `"${truncated.slice(0, 80)}${truncated.length > 80 ? "…" : ""}" (${truncated.length} chars)`);
            candidateQuestion = truncated;
        }

        clearTimeout(candidateTimer);
        candidateTimer = setTimeout(() => {
            const q = candidateQuestion;
            candidateQuestion = "";
            if (q.length >= 8) recordQuestion(q);
        }, 800);
    }

    // ── RAF-batched mutation observer ──────────────────────────────────────────
    function flushBatch() {
        rafPending = false;
        const texts = [...mutationBatch];
        mutationBatch.clear();
        texts.forEach(processText);
    }

    const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
            const t = m.target?.textContent;
            if (t) mutationBatch.add(t);
        }
        if (!rafPending) { rafPending = true; requestAnimationFrame(flushBatch); }
    });

    observer.observe(document.documentElement, {
        childList: true, subtree: true, characterData: true
    });

    // ── Startup ────────────────────────────────────────────────────────────────
    log("load", { url: location.href });
    mountOverlay();

    // Poll every 2.5s for answer-option changes — catches new questions on same-template quizzes
    // (e.g. "Guess the country?") where the question text stays the same but options change.
    // 2.5s gives the image time to load before captureScreen fires.
    setInterval(() => {
        if (!overlayQuestion) return;
        const currentAnswers = extractAnswers();
        if (currentAnswers.length < 2) return;
        if (currentAnswers.join("|") === overlayAnswers.join("|")) return;
        // Options changed → new question. Scan DOM for current question text.
        const freshQ = scanForCurrentQuestion() || overlayQuestion;
        if (freshQ) recordQuestion(freshQ);
    }, 2500);
})();
