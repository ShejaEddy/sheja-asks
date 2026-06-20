const PROVIDERS = {
    claude: {
        label: "Anthropic API Key",
        placeholder: "sk-ant-...",
        hint: 'Get free key at <a href="https://console.anthropic.com" target="_blank">console.anthropic.com</a>',
        model: "claude-haiku-4-5"
    },
    openai: {
        label: "OpenAI API Key",
        placeholder: "sk-...",
        hint: 'Get key at <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a>',
        model: "gpt-4o-mini"
    },
    gemini: {
        label: "Google AI API Key",
        placeholder: "AIza...",
        hint: 'Free tier — get key at <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com</a>',
        model: "gemini-2.5-flash"
    },
    mistral: {
        label: "Mistral API Key",
        placeholder: "...",
        hint: 'Get key at <a href="https://console.mistral.ai/api-keys" target="_blank">console.mistral.ai</a>',
        model: "mistral-small-latest"
    }
};

let activeProvider = "claude";
let keys = {};

document.addEventListener("DOMContentLoaded", () => {
    chrome.storage.sync.get(
        ["provider", "apiKey_claude", "apiKey_openai", "apiKey_gemini", "apiKey_mistral"],
        (settings) => {
            keys = {
                claude:  settings.apiKey_claude  || "",
                openai:  settings.apiKey_openai  || "",
                gemini:  settings.apiKey_gemini  || "",
                mistral: settings.apiKey_mistral || ""
            };
            activeProvider = settings.provider || "claude";
            setActiveTab(activeProvider);
            updateDots();
        }
    );

    document.querySelectorAll(".qa-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            // Save current key before switching
            keys[activeProvider] = document.getElementById("key").value.trim();
            setActiveTab(tab.dataset.provider);
        });
    });

    document.getElementById("save").addEventListener("click", () => {
        keys[activeProvider] = document.getElementById("key").value.trim();

        chrome.storage.sync.set({
            provider:       activeProvider,
            apiKey_claude:  keys.claude,
            apiKey_openai:  keys.openai,
            apiKey_gemini:  keys.gemini,
            apiKey_mistral: keys.mistral
        }, () => {
            const btn    = document.getElementById("save");
            const status = document.getElementById("status");

            btn.textContent = "✓ Saved!";
            btn.style.background = "linear-gradient(135deg, #16a34a, #22c55e)";
            btn.disabled = true;
            status.textContent = "Reloading page...";
            updateDots();

            setTimeout(() => {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs[0]) chrome.tabs.reload(tabs[0].id);
                    window.close();
                });
            }, 1000);
        });
    });
});

function updateDots() {
    ["claude", "openai", "gemini", "mistral"].forEach(p => {
        const dot = document.getElementById("dot-" + p);
        if (dot) dot.classList.toggle("visible", !!keys[p]);
    });
}

function setActiveTab(provider) {
    activeProvider = provider;

    document.querySelectorAll(".qa-tab").forEach(t => {
        t.classList.toggle("active", t.dataset.provider === provider);
    });

    const info = PROVIDERS[provider];
    document.getElementById("key-label").textContent = info.label;
    document.getElementById("key").placeholder = info.placeholder;
    document.getElementById("key").value = keys[provider] || "";
    document.getElementById("key-hint").innerHTML = info.hint;
    document.getElementById("model-label").textContent = "Model: " + info.model;
}
