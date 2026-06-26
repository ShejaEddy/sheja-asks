const MODELS = {
    claude:  "claude-haiku-4-5",
    openai:  "gpt-4o-mini",
    gemini:  "gemini-2.5-flash",
    mistral: "mistral-small-latest"
};

// Mistral routes vision through a separate multimodal model.
const MISTRAL_VISION_MODEL = "pixtral-12b-2409";

const PROVIDER_NAMES = {
    claude: "Claude", openai: "OpenAI", gemini: "Gemini", mistral: "Mistral"
};

const MAX_TOKENS = 512;   // room for the reasoning field, still cheap on small/fast models

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
                const answers = msg.answers || [];
                const opts = {
                    strict:      !!msg.strict,
                    nudge:       msg.nudge || "",
                    temperature: typeof msg.temperature === "number" ? msg.temperature : 0
                };
                callWithTimeout(signal =>
                    call(provider, apiKey, msg.question, answers, msg.imageDataUrl || null, signal, opts)
                )
                .then(result => sendResponse({ ...result, provider }))
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
        return "\n- MATH: compute step by step in reasoning; the answer is the final number only.";
    if (l.startsWith("how many") || l.startsWith("how much"))
        return "\n- NUMERIC: the answer is the number only.";
    if (l.startsWith("what is") || l.startsWith("what are") || l.startsWith("define") || l.startsWith("what does"))
        return "\n- DEFINITION: the answer is the precise term or short fact only.";
    if (l.startsWith("true or false") || l.includes("true or false"))
        return "\n- TRUE/FALSE: the answer is exactly True or False.";
    return "";
}

// Builds the user prompt. Output FORMAT is enforced by structured-output schemas
// per provider; the explicit "Respond ONLY with JSON" line is a belt-and-suspenders
// fallback so providers that ignore/lack the schema still emit parseable JSON.
function buildPrompt(question, answers, hasImage, strict, nudge) {
    const imgNote   = hasImage
        ? "\n\nA screenshot of the quiz page is attached. Examine any images, flags, logos, maps, or visual content shown and use what you see to answer."
        : "";
    const nudgeNote = nudge ? `\n\nAdditional context from the user: ${nudge}` : "";
    const typeHint  = questionTypeHint(question);

    if (answers.length) {
        const numbered   = answers.map((a, i) => `${i}) ${a}`).join("\n");
        const last       = answers.length - 1;
        const strictNote = strict
            ? "\n- Your previous answer was invalid. Re-read the options and pick the single best one by its number."
            : "";
        return `You are an expert quiz solver. Choose the single correct option from the list.${imgNote}${nudgeNote}

Question: ${question}

Options:
${numbered}

Instructions:${typeHint}${strictNote}
- Think briefly in "reasoning" before deciding.
- Set "answer_index" to the number (0-${last}) of the ONE correct option. Pick exactly one — never two, never an option that is not listed.
- Set "confidence" from 0 to 1 for how sure you are.

Respond ONLY with JSON: {"reasoning": "...", "answer_index": <0-${last}>, "confidence": <0-1>}`;
    }

    return `You are an expert quiz solver. Answer the question.${imgNote}${nudgeNote}

Question: ${question}

Instructions:${typeHint}
- Think briefly in "reasoning" before deciding.
- Put the answer in "answer": 1-3 words, the simplest direct form. No articles (a/an/the) unless part of a proper name. No quotes or brackets.
- Set "confidence" from 0 to 1 for how sure you are.

Respond ONLY with JSON: {"reasoning": "...", "answer": "...", "confidence": <0-1>}`;
}

// JSON-schema shapes. Property order is preserved (reasoning first) so the model
// reasons before committing — the cheap chain-of-thought that lifts small models.
function genericSchema(numOptions) {
    if (numOptions > 0) {
        return {
            type: "object",
            properties: {
                reasoning:    { type: "string",  description: "Brief reasoning before answering." },
                answer_index: { type: "integer", description: `Index 0..${numOptions - 1} of the single correct option.` },
                confidence:   { type: "number",  description: "0..1 confidence the chosen option is correct." }
            },
            required: ["reasoning", "answer_index", "confidence"],
            additionalProperties: false
        };
    }
    return {
        type: "object",
        properties: {
            reasoning:  { type: "string", description: "Brief reasoning before answering." },
            answer:     { type: "string", description: "The answer only, 1-3 words." },
            confidence: { type: "number", description: "0..1 confidence." }
        },
        required: ["reasoning", "answer", "confidence"],
        additionalProperties: false
    };
}

// Gemini's responseSchema uses uppercase type names + propertyOrdering.
function geminiSchema(numOptions) {
    if (numOptions > 0) {
        return {
            type: "OBJECT",
            properties: {
                reasoning:    { type: "STRING" },
                answer_index: { type: "INTEGER" },
                confidence:   { type: "NUMBER" }
            },
            required: ["reasoning", "answer_index", "confidence"],
            propertyOrdering: ["reasoning", "answer_index", "confidence"]
        };
    }
    return {
        type: "OBJECT",
        properties: {
            reasoning:  { type: "STRING" },
            answer:     { type: "STRING" },
            confidence: { type: "NUMBER" }
        },
        required: ["reasoning", "answer", "confidence"],
        propertyOrdering: ["reasoning", "answer", "confidence"]
    };
}

// Parse the model's JSON and normalize to one shape the content script understands:
// { answer, answerIndex, inRange, confidence, reasoning, raw } or { raw, parseError }.
function normalizeResult(rawText, answers) {
    const n = answers.length;
    let obj = null;
    if (rawText) {
        try { obj = JSON.parse(rawText); }
        catch (e) {
            const m = rawText.match(/\{[\s\S]*\}/);   // salvage a JSON object embedded in prose
            if (m) { try { obj = JSON.parse(m[0]); } catch (_) {} }
        }
    }
    if (!obj || typeof obj !== "object") return { raw: rawText, parseError: true };

    const confidence = typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : null;
    const reasoning  = typeof obj.reasoning === "string" ? obj.reasoning.trim() : "";

    if (n > 0) {
        let idx = Number.isInteger(obj.answer_index) ? obj.answer_index
                : (typeof obj.answer_index === "string" ? parseInt(obj.answer_index, 10) : NaN);
        const inRange = Number.isInteger(idx) && idx >= 0 && idx < n;
        return {
            answer:      inRange ? answers[idx] : null,
            answerIndex: inRange ? idx : -1,
            inRange, confidence, reasoning, raw: rawText
        };
    }
    const ans = obj.answer != null ? String(obj.answer).trim() : "";
    return { answer: ans || null, answerIndex: -1, inRange: !!ans, confidence, reasoning, raw: rawText };
}

function base64(dataUrl) {
    return dataUrl.replace(/^data:image\/\w+;base64,/, "");
}

async function call(provider, apiKey, question, answers, imageDataUrl, signal, opts) {
    switch (provider) {
        case "claude":  return callClaude (apiKey, question, answers, imageDataUrl, signal, opts);
        case "openai":  return callOpenAI (apiKey, question, answers, imageDataUrl, signal, opts);
        case "gemini":  return callGemini (apiKey, question, answers, imageDataUrl, signal, opts);
        case "mistral": return callMistral(apiKey, question, answers, imageDataUrl, signal, opts);
        default: throw new Error("Unknown provider: " + provider);
    }
}

async function callClaude(apiKey, question, answers, imageDataUrl, signal, opts) {
    const prompt  = buildPrompt(question, answers, !!imageDataUrl, opts.strict, opts.nudge);
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
        body: JSON.stringify({
            model: MODELS.claude,
            max_tokens: MAX_TOKENS,
            temperature: opts.temperature,
            output_config: { format: { type: "json_schema", schema: genericSchema(answers.length) } },
            messages: [{ role: "user", content }]
        }),
        signal
    });
    if (!r.ok) throw new Error(httpError(r.status));
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    const text = (data.content || []).map(b => b.text).filter(Boolean).join("");
    if (!text) throw new Error("Empty response from Claude");
    return normalizeResult(text, answers);
}

async function callOpenAI(apiKey, question, answers, imageDataUrl, signal, opts) {
    const prompt  = buildPrompt(question, answers, !!imageDataUrl, opts.strict, opts.nudge);
    const content = imageDataUrl ? [
        { type: "image_url", image_url: { url: imageDataUrl, detail: "low" } },
        { type: "text", text: prompt }
    ] : prompt;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: MODELS.openai,
            max_tokens: MAX_TOKENS,
            temperature: opts.temperature,
            response_format: { type: "json_schema", json_schema: { name: "quiz_answer", strict: true, schema: genericSchema(answers.length) } },
            messages: [{ role: "user", content }]
        }),
        signal
    });
    if (!r.ok) throw new Error(httpError(r.status));
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty response from OpenAI");
    return normalizeResult(text, answers);
}

async function callGemini(apiKey, question, answers, imageDataUrl, signal, opts) {
    const prompt = buildPrompt(question, answers, !!imageDataUrl, opts.strict, opts.nudge);
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
                maxOutputTokens: MAX_TOKENS,
                temperature: opts.temperature,
                thinkingConfig: { thinkingBudget: 0 },   // thinking stays off (user choice)
                responseMimeType: "application/json",
                responseSchema: geminiSchema(answers.length)
            }
        }),
        signal
    });
    if (!r.ok) throw new Error(httpError(r.status));
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join("");
    if (!text) throw new Error("Empty response from Gemini");
    return normalizeResult(text, answers);
}

async function callMistral(apiKey, question, answers, imageDataUrl, signal, opts) {
    const prompt  = buildPrompt(question, answers, !!imageDataUrl, opts.strict, opts.nudge);
    const model   = imageDataUrl ? MISTRAL_VISION_MODEL : MODELS.mistral;
    const content = imageDataUrl ? [
        { type: "image_url", image_url: { url: imageDataUrl } },
        { type: "text", text: prompt }
    ] : prompt;

    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
            model,
            max_tokens: MAX_TOKENS,
            temperature: opts.temperature,
            response_format: { type: "json_schema", json_schema: { name: "quiz_answer", schema: genericSchema(answers.length), strict: true } },
            messages: [{ role: "user", content }]
        }),
        signal
    });
    if (!r.ok) throw new Error(httpError(r.status));
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty response from Mistral");
    return normalizeResult(text, answers);
}
