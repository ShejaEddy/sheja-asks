const MODELS = {
    claude:  "claude-haiku-4-5",
    openai:  "gpt-4o-mini",
    gemini:  "gemini-2.5-flash",
    mistral: "mistral-small-latest"
};

const PROVIDER_NAMES = {
    claude: "Claude", openai: "OpenAI", gemini: "Gemini", mistral: "Mistral"
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "takeScreenshot") {
        chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 85 }, dataUrl => {
            if (chrome.runtime.lastError) sendResponse({ error: chrome.runtime.lastError.message });
            else sendResponse({ dataUrl });
        });
        return true;
    }

    if (msg.action === "askAI") {
        chrome.storage.local.get(
            ["provider", "apiKey_claude", "apiKey_openai", "apiKey_gemini", "apiKey_mistral"],
            settings => {
                const provider = settings.provider || "claude";
                const apiKey   = settings[`apiKey_${provider}`];
                if (!apiKey) {
                    sendResponse({ error: `No ${PROVIDER_NAMES[provider] || provider} API key — open settings` });
                    return;
                }
                callWithTimeout(signal =>
                    call(provider, apiKey, msg.question, msg.answers || [], msg.imageDataUrl || null, signal, msg.strict, msg.nudge || "")
                )
                .then(answer => sendResponse({ answer, provider }))
                .catch(err   => sendResponse({ error: err.message }));
            }
        );
        return true;
    }

    return false;
});

async function callWithTimeout(fn) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
        return await fn(ctrl.signal);
    } catch (err) {
        if (err.name === "AbortError") throw new Error("Request timed out — try again");
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function httpError(status) {
    if (status === 401) return "Invalid API key";
    if (status === 403) return "API access denied";
    if (status === 429) return "Rate limit exceeded — try again shortly";
    if (status >= 500) return "API server error — try again";
    return `HTTP ${status}`;
}

// Dissect the question type and return a tailored hint so the model understands what's being asked.
function questionTypeHint(q) {
    const l = q.toLowerCase();
    if (l.includes("unscramble") || l.includes("anagram") || l.includes("rearrange"))
        return "\n- ANAGRAM: rearrange EXACTLY the scrambled letters into one real word — every letter used once, no extras. Count carefully: \"elcyeh\" = e,l,c,y,e,h (6 letters) -> lychee.";
    if (l.startsWith("fill in") || l.startsWith("complete ") || l.includes("_____") || l.includes("____"))
        return "\n- FILL-IN: give ONLY the missing word(s) that complete it, nothing else.";
    if (l.startsWith("calculate") || l.startsWith("solve") || l.includes("how much") || /\bsum\b|\bproduct\b|\bequals\b/.test(l))
        return "\n- MATH: compute step by step internally; reply with the final number only.";
    if (l.startsWith("how many") || l.startsWith("how much"))
        return "\n- NUMERIC: reply with the number only.";
    if (l.startsWith("what is") || l.startsWith("what are") || l.startsWith("define") || l.startsWith("what does"))
        return "\n- DEFINITION: reply with the precise term or short fact only.";
    if (l.startsWith("true or false") || l.includes("true or false"))
        return "\n- TRUE/FALSE: reply with exactly True or False.";
    return "";
}

function buildPrompt(question, answers, hasImage, strict, nudge) {
    const imgNote   = hasImage
        ? "\n\nA screenshot of the quiz page is attached. Look carefully at any images, flags, logos, maps, or visual content shown. Use what you see to answer the question."
        : "";
    const nudgeNote = nudge ? `\n\nAdditional context: ${nudge}` : "";

    const typeHint = questionTypeHint(question)
        + (strict && answers.length ? "\n- IMPORTANT: your previous answer was not one of the options. Line 1 MUST be copied character-for-character from the options list — pick the single best one." : "");

    if (!answers.length) {
        return `You are a quiz answer assistant.${imgNote}${nudgeNote}\n\nQuestion: ${question}\n\nRules:${typeHint}\n- The answer is 1-3 words, the simplest direct form\n- No articles (a / an / the) unless the answer is a proper name that includes one\n- No possessives (your / my) — use a bare noun\n- No square brackets, no quotes\n\nFormat your reply as EXACTLY two lines:\nLine 1: the answer ONLY (nothing else on this line)\nLine 2: a reason, 6 words max\n\nExample:\ncherry\nrearranged e,l,c,y,e,h\n\nExample:\nfuture\nalways ahead of you`;
    }

    return `You are a quiz answer assistant. Pick the correct answer from the options.${imgNote}${nudgeNote}\n\nQuestion: ${question}\nOptions: ${answers.join(", ")}${typeHint}\n\nFormat your reply as EXACTLY two lines:\nLine 1: the correct option, copied WORD FOR WORD from the options above (nothing else on this line)\nLine 2: a reason, 6 words max\n\nDo not add square brackets, quotes, letters, or numbering to line 1.\n\nExample:\nAsia\ncarrots originated near Afghanistan`;
}

function base64(dataUrl) {
    return dataUrl.replace(/^data:image\/\w+;base64,/, "");
}

async function call(provider, apiKey, question, answers, imageDataUrl, signal, strict, nudge) {
    switch (provider) {
        case "claude":  return callClaude (apiKey, question, answers, imageDataUrl, signal, strict, nudge);
        case "openai":  return callOpenAI (apiKey, question, answers, imageDataUrl, signal, strict, nudge);
        case "gemini":  return callGemini (apiKey, question, answers, imageDataUrl, signal, strict, nudge);
        case "mistral": return callMistral(apiKey, question, answers, imageDataUrl, signal, strict, nudge);
        default: throw new Error("Unknown provider: " + provider);
    }
}

async function callClaude(apiKey, question, answers, imageDataUrl, signal, strict, nudge) {
    const prompt  = buildPrompt(question, answers, !!imageDataUrl, strict, nudge);
    const content = imageDataUrl ? [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64(imageDataUrl) } },
        { type: "text", text: prompt }
    ] : prompt;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({ model: MODELS.claude, max_tokens: 120, messages: [{ role: "user", content }] }),
        signal
    });
    if (!r.ok) throw new Error(httpError(r.status));
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.content?.[0]?.text;
    if (!text) throw new Error("Empty response from Claude");
    return text;
}

async function callOpenAI(apiKey, question, answers, imageDataUrl, signal, strict, nudge) {
    const prompt  = buildPrompt(question, answers, !!imageDataUrl, strict, nudge);
    const content = imageDataUrl ? [
        { type: "image_url", image_url: { url: imageDataUrl, detail: "low" } },
        { type: "text", text: prompt }
    ] : prompt;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model: MODELS.openai, max_tokens: 120, messages: [{ role: "user", content }] }),
        signal
    });
    if (!r.ok) throw new Error(httpError(r.status));
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty response from OpenAI");
    return text;
}

async function callGemini(apiKey, question, answers, imageDataUrl, signal, strict, nudge) {
    const prompt = buildPrompt(question, answers, !!imageDataUrl, strict, nudge);
    const parts  = imageDataUrl ? [
        { inline_data: { mime_type: "image/jpeg", data: base64(imageDataUrl) } },
        { text: prompt }
    ] : [{ text: prompt }];

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
                maxOutputTokens: 120,
                thinkingConfig: { thinkingBudget: 0 }  // disable reasoning for speed
            }
        }),
        signal
    });
    if (!r.ok) throw new Error(httpError(r.status));
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Empty response from Gemini");
    return text;
}

async function callMistral(apiKey, question, answers, imageDataUrl, signal, strict, nudge) {
    const prompt  = buildPrompt(question, answers, !!imageDataUrl, strict, nudge);
    const model   = imageDataUrl ? "pixtral-12b-2409" : MODELS.mistral;
    const content = imageDataUrl ? [
        { type: "image_url", image_url: { url: imageDataUrl } },
        { type: "text", text: prompt }
    ] : prompt;

    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model, max_tokens: 120, messages: [{ role: "user", content }] }),
        signal
    });
    if (!r.ok) throw new Error(httpError(r.status));
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty response from Mistral");
    return text;
}
