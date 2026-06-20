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
                    call(provider, apiKey, msg.question, msg.answers || [], msg.imageDataUrl || null, signal)
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

function buildPrompt(question, answers, hasImage) {
    const imgNote = hasImage
        ? "\n\nA screenshot of the quiz page is attached. Look carefully at any images, flags, logos, maps, or visual content shown. Use what you see to answer the question."
        : "";

    if (!answers.length) {
        return `You are a quiz answer assistant.${imgNote}\n\nQuestion: ${question}\n\nReply with ONLY: [answer] — [one brief reason]\nRules:\n- Answer must be 1-3 words, simplest direct form\n- No articles (a / an / the) unless the quiz expects them\n- No possessives (your / my) — use bare noun\n- Riddle example: "future — It is always ahead of you."\n- Riddle example: "comb — It has teeth but no mouth."`;
    }

    return `You are a quiz answer assistant. Pick the correct answer from the options.${imgNote}\n\nQuestion: ${question}\nOptions: ${answers.join(", ")}\n\nReply with ONLY: [exact option text] — [one brief reason]\nIMPORTANT: Your answer must be copied word for word from the options listed above.`;
}

function base64(dataUrl) {
    return dataUrl.replace(/^data:image\/\w+;base64,/, "");
}

async function call(provider, apiKey, question, answers, imageDataUrl, signal) {
    switch (provider) {
        case "claude":  return callClaude (apiKey, question, answers, imageDataUrl, signal);
        case "openai":  return callOpenAI (apiKey, question, answers, imageDataUrl, signal);
        case "gemini":  return callGemini (apiKey, question, answers, imageDataUrl, signal);
        case "mistral": return callMistral(apiKey, question, answers, imageDataUrl, signal);
        default: throw new Error("Unknown provider: " + provider);
    }
}

async function callClaude(apiKey, question, answers, imageDataUrl, signal) {
    const prompt  = buildPrompt(question, answers, !!imageDataUrl);
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
        body: JSON.stringify({ model: MODELS.claude, max_tokens: 256, messages: [{ role: "user", content }] }),
        signal
    });
    if (!r.ok) throw new Error(httpError(r.status));
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.content?.[0]?.text;
    if (!text) throw new Error("Empty response from Claude");
    return text;
}

async function callOpenAI(apiKey, question, answers, imageDataUrl, signal) {
    const prompt  = buildPrompt(question, answers, !!imageDataUrl);
    const content = imageDataUrl ? [
        { type: "image_url", image_url: { url: imageDataUrl, detail: "low" } },
        { type: "text", text: prompt }
    ] : prompt;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model: MODELS.openai, max_tokens: 256, messages: [{ role: "user", content }] }),
        signal
    });
    if (!r.ok) throw new Error(httpError(r.status));
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty response from OpenAI");
    return text;
}

async function callGemini(apiKey, question, answers, imageDataUrl, signal) {
    const prompt = buildPrompt(question, answers, !!imageDataUrl);
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
                maxOutputTokens: 256,
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

async function callMistral(apiKey, question, answers, imageDataUrl, signal) {
    const prompt  = buildPrompt(question, answers, !!imageDataUrl);
    const model   = imageDataUrl ? "pixtral-12b-2409" : MODELS.mistral;
    const content = imageDataUrl ? [
        { type: "image_url", image_url: { url: imageDataUrl } },
        { type: "text", text: prompt }
    ] : prompt;

    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model, max_tokens: 256, messages: [{ role: "user", content }] }),
        signal
    });
    if (!r.ok) throw new Error(httpError(r.status));
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty response from Mistral");
    return text;
}
