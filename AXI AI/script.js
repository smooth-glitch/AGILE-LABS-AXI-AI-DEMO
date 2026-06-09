/* Production build — diagnostic logging suppressed */
(function () { var noop = function () { }; console.log = console.info = console.warn = console.debug = noop; })();

const LS_KEY = "axpert_chats_v2";
const AI_LOGO_SRC = "../../images/ai-logo.png";
// OpenRouter API key (DEV ONLY — do not ship keys in frontend)
// DEV NOTE: OpenRouter key removed — supply keys at runtime via AXI CONNECT.
const OPENROUTERAPIKEY = "";
const logoUrl = "../../images/ai-logo.png";


// ==============================
// AXI Provider / Auth
// ==============================
const AXI_LS_PROVIDER = "axi_provider";   // kept for manual-connect fallback
const AXI_LS_KEY = "axi_api_key";    // kept for manual-connect fallback
const AXI_LS_MODEL = "axi_model";      // optional stored model override

// ── Runtime-only key store ────────────────────────────────────────────────────
// The key fetched from axi_ai_keys lives ONLY in this variable for the lifetime of
// the tab.  It is never written to localStorage, sessionStorage, cookies, or
// any other persistent store.  When the tab closes the key is gone.
let _AXI_RUNTIME_KEY = null;   // the actual API key string
let _AXI_RUNTIME_PROVIDER = null;   // provider string (always "openai" for org key)
let _AXI_RUNTIME_MODEL = null;   // model string from axi_ai_keys row
let _AXI_PROVIDER_KEY_CACHE = window._AXI_PROVIDER_KEY_CACHE = {}; // { openai: true, … } — populated from DB; exposed on window so dashboard.html can correct stale entries
let _AXI_PROVIDER_KEYS = window._AXI_PROVIDER_KEYS = {}; // provider -> real key string (single source of truth)
let _AXI_PERSONAL_PROVIDERS = window._AXI_PERSONAL_PROVIDERS = new Set(); // providers that have a real (non-empty) key in axi_ai_keys; protected from RBAC-correction clearing

// ── Table struct name for axi_ai_keys (change to match your Axpert table struct) ─
const AXI_KEYS_TSTRUCT = "a__xk";  // adjust if your tstruct name differs

/**
 * Called once on page load.  Fetches the row from the axi_ai_keys datasource,
 * pulls the key + provider + model into memory-only variables.
 *
 * Returns:
 *   { found: true }   — key loaded into memory successfully
 *   { found: false }  — axi_ai_keys is empty / no key stored yet → show setup UI
 *
 * Throws only on hard errors (Axpert API unavailable, malformed response, etc.)
 *
 * Expected axi_ai_keys row shape (all fields optional except api_key):
 *   { api_key: "sk-...", provider: "openai", model: "gpt-4o-mini" }
 */

// ─── NATIVE FETCH BYPASS ──────────────────────────────────────────────────────
// Whatever is intercepting window.fetch (scripts.bundle.js, an Axpert framework
// script, a service worker proxy, etc.) only patches the MAIN window.  A fresh
// iframe gets its own untouched window object, so iframe.contentWindow.fetch is
// the real, unproxied browser fetch.  We borrow it once at startup and use it
// for every external AI API call.
const _axiFetch = (function () {
    try {
        var ifr = document.createElement('iframe');
        ifr.style.cssText = 'display:none!important;width:0;height:0;border:0;position:absolute;left:-99999px;top:-99999px';
        ifr.setAttribute('aria-hidden', 'true');
        (document.body || document.documentElement).appendChild(ifr);
        var nativeFetch = ifr.contentWindow.fetch.bind(ifr.contentWindow);
        // Leave the iframe in the DOM — removing it can invalidate the borrowed fn.
        ifr.style.display = 'none';
        return nativeFetch;
    } catch (e) {
        console.warn('[AXI] iframe fetch borrow failed, falling back to window.fetch', e);
        return window.fetch.bind(window);
    }
})();
// ─────────────────────────────────────────────────────────────────────────────

window.initAxiKeyFromDatasource = async function () {
    if (!window.fetchADSData) {
        throw new Error("fetchADSData is not available yet.");
    }

    const rows = await window.fetchADSData("axi_ai_keys");

    // Clear immediately — axi_ai_keys must never reach the AI context
    window.pendingDatabaseData = null;
    window.CURRENTADSDATA = null;
    window.CURRENTADSNAME = null;

    // Empty table — first-time setup needed
    if (!Array.isArray(rows) || rows.length === 0) {
        return { found: false };
    }

    // Filter rows to only those belonging to the current user,
    // then pick the most recently used one.
    const currentUsername = (typeof parent !== "undefined" && parent.mainUserName)
        ? parent.mainUserName
        : (typeof mainUserName !== "undefined" ? mainUserName : "");

    // Primary: rows that explicitly match the current username
    let userRows = currentUsername
        ? rows.filter(r => (r.username || r.USERNAME || "").trim() === currentUsername.trim())
        : rows;

    // Fallback 1: rows saved before the username column was populated (empty username)
    if (!userRows.length && currentUsername) {
        userRows = rows.filter(r => !(r.username || r.USERNAME || "").trim());
    }

    // Fallback 2: org-wide / legacy — just use all rows
    // Fallback 2 removed — never load other users' keys.
    // If no user-specific or anonymous rows exist, treat as no key found.
    if (!userRows.length) {
        return { found: false };
    }

    if (!userRows.length) return { found: false };

    // Cache every provider that has a REAL (non-empty) key for this user.
    // Rows that have a provider field but no api_key are skipped so they
    // do not appear as "Connected" in the provider dropdown.
    userRows.forEach(r => {
        const prov = (r.provider || r.PROVIDER || '').trim().toLowerCase();
        const k = (r.api_key || r.apikey || r.key || r.API_KEY || '').trim();
        if (prov && k) {
            _AXI_PROVIDER_KEYS[prov] = k;
            _AXI_PROVIDER_KEY_CACHE[prov] = true;
            _AXI_PERSONAL_PROVIDERS.add(prov); // mark as a personal key so RBAC correction never clears it
        }
    });

    const sorted = [...userRows].sort((a, b) => {
        const ta = a.last_used || a.updated_at || a.created_at || 0;
        const tb = b.last_used || b.updated_at || b.created_at || 0;
        return new Date(tb) - new Date(ta);
    });
    const row = sorted[0];

    const key = (row.api_key || row.apikey || row.key || row.API_KEY || "").trim();
    if (!key) return { found: false };

    _AXI_RUNTIME_KEY = key;
    _AXI_RUNTIME_PROVIDER = (row.provider || row.PROVIDER || "openai").trim().toLowerCase();
    _AXI_RUNTIME_MODEL = (row.model || row.MODEL || "").trim();
    // Auto-migrate retired model names (e.g. gemini-1.5-flash, now shut down)
    // to the current default for the provider so existing users self-heal.
    if (_AXI_RUNTIME_MODEL && typeof AXI_RETIRED_MODELS !== 'undefined' && AXI_RETIRED_MODELS.has(_AXI_RUNTIME_MODEL)) {
        console.info('[AXI] Migrating retired model "' + _AXI_RUNTIME_MODEL + '" → "' + (AXI_DEFAULT_MODELS[_AXI_RUNTIME_PROVIDER] || '') + '"');
        _AXI_RUNTIME_MODEL = AXI_DEFAULT_MODELS[_AXI_RUNTIME_PROVIDER] || '';
    }

    return { found: true };
};

/**
 * Saves a new API key to the axi_ai_keys table via AxSetValue + AxSubmitData,
 * then stores it in memory.  Pass recordId = "0" for a new row (insert),
 * or the existing Axpert recordid for an update.
 */
// Default models per provider
const AXI_DEFAULT_MODELS = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-sonnet-20241022',
    gemini: 'gemini-2.5-flash',
    openrouter: 'openai/gpt-4o-mini'
};

// Retired model IDs that the Gemini API now returns 404 for. If we ever read
// one of these (from localStorage or the saved axi_ai_keys row) we silently
// substitute the current default for that provider so existing users self-heal
// without having to reconnect.
const AXI_RETIRED_MODELS = new Set([
    // Gemini 1.x — fully shut down (all return 404 on v1beta and v1 alike)
    'gemini-1.5-flash', 'gemini-1.5-flash-latest', 'gemini-1.5-flash-001', 'gemini-1.5-flash-002',
    'gemini-1.5-pro', 'gemini-1.5-pro-latest', 'gemini-1.5-pro-001', 'gemini-1.5-pro-002',
    'gemini-1.0-pro', 'gemini-1.0-pro-latest', 'gemini-pro', 'gemini-pro-vision'
]);

// Returns the saved model unchanged unless it's in the retired list, in which
// case it returns the current default for the given provider.
function _resolveModelOrDefault(provider, savedModel) {
    const m = (savedModel || '').trim();
    if (m && AXI_RETIRED_MODELS.has(m)) {
        return AXI_DEFAULT_MODELS[provider] || '';
    }
    return m;
}

window.saveAxiKeyToTable = function (apiKey, recordId, provider, model) {
    recordId = recordId || "0";
    provider = (provider || "openai").toLowerCase();
    model = model || AXI_DEFAULT_MODELS[provider] || 'gpt-4o-mini';

    // Prefer parent.* — AxSetValue/AxSubmitData rely on jQuery ($) which only
    // exists in the parent frame; calling the window-scoped copy throws "$ is not defined".
    function _pickAxFn(name) {
        try { if (typeof parent !== 'undefined' && typeof parent[name] === 'function') return parent[name]; } catch (e) { }
        if (typeof window[name] === 'function') return window[name];
        return null;
    }
    const setterFn = _pickAxFn('AxSetValue');
    const submitFn = _pickAxFn('AxSubmitData');

    if (!setterFn || !submitFn) {
        throw new Error("AxSetValue or AxSubmitData not available. This page must run inside Axpert.");
    }

    const currentUsername = (typeof parent !== "undefined" && parent.mainUserName)
        ? parent.mainUserName
        : (typeof mainUserName !== "undefined" ? mainUserName : "");

    setterFn(AXI_KEYS_TSTRUCT, 'api_key', '1', 0, apiKey.trim());
    setterFn(AXI_KEYS_TSTRUCT, 'provider', '1', 0, provider);
    setterFn(AXI_KEYS_TSTRUCT, 'model', '1', 0, model);
    setterFn(AXI_KEYS_TSTRUCT, 'is_active', '1', 0, '1');
    if (currentUsername) setterFn(AXI_KEYS_TSTRUCT, 'username', '1', 0, currentUsername);
    submitFn(AXI_KEYS_TSTRUCT, recordId);

    _AXI_RUNTIME_KEY = apiKey.trim();
    _AXI_RUNTIME_PROVIDER = provider;
    _AXI_RUNTIME_MODEL = model;
    _AXI_PROVIDER_KEY_CACHE[provider] = true; // mark as configured immediately
    _AXI_PROVIDER_KEYS[provider] = (apiKey || '').trim();
    // Mirror to localStorage so getAxiConfig()'s fallback path works if the DB
    // fetch fails on the next page load (e.g. Axpert datasource unavailable).
    try {
        localStorage.setItem(AXI_LS_KEY, apiKey.trim());
        localStorage.setItem(AXI_LS_PROVIDER, provider);
        if (model) localStorage.setItem(AXI_LS_MODEL, model);
    } catch (_) { /* storage quota / private-mode — ignore */ }

    console.info(`[AXI] Key saved for provider: ${provider}`);
};

/**
 * Injects a pre-validated key directly into runtime memory WITHOUT writing to axi_ai_keys.
 * Used by the RBAC flow for non-admin users whose keys are assigned by the admin in
 * axi_ai_rbac_config — they should never create their own row in axi_ai_keys.
 */
window.setAxiRuntimeKey = function (apiKey, provider, model) {
    if (!apiKey) return;
    provider = (provider || 'openai').toLowerCase();
    model = model || AXI_DEFAULT_MODELS[provider] || 'gpt-4o-mini';
    _AXI_RUNTIME_KEY = apiKey.trim();
    _AXI_RUNTIME_PROVIDER = provider;
    _AXI_RUNTIME_MODEL = model;
    _AXI_PROVIDER_KEY_CACHE[provider] = true;
    _AXI_PROVIDER_KEYS[provider] = (apiKey || '').trim();
    console.info('[AXI] Runtime key injected for provider:', provider);
};

/** Returns true if the runtime key has been loaded from axi_ai_keys. */
function hasRuntimeKey() {
    return !!_AXI_RUNTIME_KEY;
}
window.hasRuntimeKey = hasRuntimeKey;

function getAxiConfig() {
    // ── Primary path: org key loaded from axi_ai_keys ─────────────────────────
    if (_AXI_RUNTIME_KEY) {
        let model = _AXI_RUNTIME_MODEL
            || (localStorage.getItem(AXI_LS_MODEL) || "").trim()
            || "gpt-4o-mini";
        return {
            provider: _AXI_RUNTIME_PROVIDER || "openai",
            apiKey: _AXI_RUNTIME_KEY,
            model
        };
    }

    // ── Fallback path: manually-connected user key (connect modal) ─────────
    const provider = (localStorage.getItem(AXI_LS_PROVIDER) || "openai").trim().toLowerCase();
    const apiKey = (localStorage.getItem(AXI_LS_KEY) || "").trim();
    const modelFromLs = (localStorage.getItem(AXI_LS_MODEL) || "").trim();

    if (!apiKey) {
        throw new Error("No API key found. Type 'AXI CONNECT' and connect your provider key.");
    }

    let model = _resolveModelOrDefault(provider, modelFromLs);
    if (!model) {
        if (provider === "openai") model = "gpt-4o-mini";
        else if (provider === "openrouter") model = "openai/gpt-4o-mini";
        else if (provider === "gemini") model = "gemini-2.5-flash";
        else if (provider === "anthropic") model = "claude-sonnet-4-6";
        else model = "gpt-4o-mini";
    }

    return { provider, apiKey, model };
}

function handleAuthFailure(provider, resStatus) {
    if (resStatus === 401 || resStatus === 403) {
        // Clear whichever source the bad key came from
        _AXI_RUNTIME_KEY = null;
        _AXI_RUNTIME_PROVIDER = null;
        _AXI_RUNTIME_MODEL = null;
        localStorage.removeItem(AXI_LS_KEY);
        throw new Error(
            `Authentication failed — the API key may have been rotated. ` +
            `Please refresh the page to fetch the latest key.`
        );
    }
}

function messagesToPlainText(messages) {
    // Useful for providers that don't accept OpenAI chat format directly (e.g., Gemini quick integration)
    return (messages || [])
        .map(m => `${(m.role || "user").toUpperCase()}: ${m.content || ""}`)
        .join("\n\n");
}


function refreshComposerState() {
    if (!el?.prompt) return;
    el.prompt.style.height = "auto";
    el.prompt.style.height = Math.min(el.prompt.scrollHeight, 120) + "px";
    if (typeof syncComposerButtons === "function") syncComposerButtons();
}

// ─── RETRY HELPER ────────────────────────────────────────────────────────────
// Retries a fetch-based async fn on 429 / 503 with exponential backoff.
// Shows a visible "Retrying…" status in the typing indicator.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function showRetryNotice(attempt, waitSec) {
    const typing = document.getElementById('typing');
    if (!typing) return;
    typing.classList.remove('typing--hidden');
    typing.className = 'typing typing--pulse';
    typing.innerHTML = `<div class="pulse-bar"></div>
    <span style="font-size:12px;color:#6B7280;margin-left:8px;">
      Rate limited — retrying in ${waitSec}s (attempt ${attempt}/3)…
    </span>`;
}

function hideRetryNotice() {
    const typing = document.getElementById('typing');
    if (!typing) return;
    typing.classList.add('typing--hidden');
    typing.innerHTML = '';
}

async function withRetry(fn, maxAttempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const status = err?.status ?? err?.statusCode ?? 0;
            const isRetryable = RETRYABLE_STATUSES.has(status)
    || /rate.?limit|too many|overload|service.?unavailable|high.?demand|try again later|529/i.test(err?.message ?? '');

            if (!isRetryable || attempt === maxAttempts) throw err;

            // Honour Retry-After header if the error carries it, else exponential backoff
            const retryAfter = err?.retryAfter ?? 0;
            const backoff = retryAfter > 0 ? retryAfter : Math.min(2 ** attempt, 16); // 2s, 4s, 8s…

            console.warn(`AXI Retry ${attempt}/${maxAttempts} — waiting ${backoff}s`, err.message);
            showRetryNotice(attempt, backoff);
            await new Promise(r => setTimeout(r, backoff * 1000));
            hideRetryNotice();
        }
    }
    throw lastError;
}
// ─────────────────────────────────────────────────────────────────────────────

async function axiChatCompletion(input = {}) {
    let messages, temperature, max_tokens, model;

    if (Array.isArray(input)) {
        messages = input; temperature = 0; max_tokens = 4000; model = undefined;
    } else {
        ({ messages, temperature = 0, max_tokens = 4000, model } = input || {});
    }

    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error("Missing required parameter: 'messages'.");
    }

    const cfg = getAxiConfig();
    const provider = cfg.provider;
    const apiKey = cfg.apiKey;
    const useModel = model || cfg.model;

    if (provider === "anthropic") {
        throw new Error("Anthropic/Claude is not supported in the browser due to CORS. Use OpenAI, OpenRouter, or Gemini.");
    }

    if (provider === "gemini") {
        const sysMsgs = messages.filter(m => m.role === "system");
        const chatMsgs = messages
            .filter(m => m.role !== "system")
            .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content || "" }] }));
        const body = { contents: chatMsgs, generationConfig: { temperature, maxOutputTokens: max_tokens } };
        if (sysMsgs.length > 0) body.system_instruction = { parts: [{ text: sysMsgs.map(m => m.content).join("\n\n") }] };
        const res = await _axiFetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent?key=${encodeURIComponent(apiKey)}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        );
        handleAuthFailure(provider, res.status);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message || "Gemini API error");
        return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    }

    // OpenAI or OpenRouter — send ONLY model/messages/temperature/max_tokens in the
    // body; provider and apiKey must NOT be in the body (they go in the header).
    const baseUrl = provider === "openrouter"
        ? "https://openrouter.ai/api/v1"
        : "https://api.openai.com/v1";
    const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };
    if (provider === "openrouter") {
        headers["HTTP-Referer"] = window.location.origin;
        headers["X-Title"] = "Axpert AXI";
    }
    const res = await _axiFetch(`${baseUrl}/chat/completions`, {
        method: "POST", headers,
        body: JSON.stringify({ model: useModel, messages, temperature, max_tokens })
    });
    handleAuthFailure(provider, res.status);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `${provider} API error`);
    return data.choices?.[0]?.message?.content || "";
}






async function axiChatCompletionStream({
    messages,
    temperature = 0,
    maxtokens = 4000,
    model,
    onChunk,
    onThinking
}) {
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error("Missing required parameter: messages.");
    }

    const cfg = getAxiConfig();
    const provider = cfg.provider;
    const apiKey = cfg.apiKey;
    const useModel = model || cfg.model;

    if (provider === "anthropic") {
        throw new Error(
            "Anthropic/Claude is not supported in the browser due to CORS. Use OpenAI, OpenRouter, or Gemini."
        );
    }

    let fullText = "";

    const emitChunk = (chunk) => {
        if (!chunk) return;
        fullText += chunk;
        onChunk?.(chunk, fullText);
    };

    const readSSE = async (res, onParsed) => {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const processEvent = (rawEvent) => {
            const dataLines = [];

            for (const line of rawEvent.split(/\r?\n/)) {
                if (line.startsWith("data:")) {
                    dataLines.push(line.slice(5).trimStart());
                }
            }

            const payload = dataLines.join("\n").trim();
            if (!payload) return false;
            if (payload === "[DONE]") return true;

            try {
                onParsed(JSON.parse(payload));
            } catch (err) {
                console.warn("SSE parse skipped:", payload, err);
            }

            return false;
        };

        while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

            let match;
            while ((match = buffer.match(/\r?\n\r?\n/))) {
                const boundary = match.index;
                const sepLen = match[0].length;
                const rawEvent = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + sepLen);

                const shouldStop = processEvent(rawEvent);
                if (shouldStop) return;
            }

            if (done) break;
        }

        if (buffer.trim()) {
            processEvent(buffer);
        }
    };

    if (provider === "gemini") {
        const sysMsgs = messages.filter((m) => m.role === "system");
        const chatMsgs = messages
            .filter((m) => m.role !== "system")
            .map((m) => ({
                role: m.role === "assistant" ? "model" : "user",
                parts: [{ text: m.content }]
            }));

        const body = {
            contents: chatMsgs,
            generationConfig: {
                temperature,
                maxOutputTokens: maxtokens
            }
        };

        if (sysMsgs.length > 0) {
            body.systemInstruction = {
                parts: [{ text: sysMsgs.map(m => m.content).join("\n\n") }]
            };
        }

        const res = await _axiFetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:streamGenerateContent?key=${encodeURIComponent(apiKey)}&alt=sse`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            }
        );

        handleAuthFailure(provider, res.status);

        if (!res.ok) {
            const d = await res.json();
            throw new Error(d?.error?.message || "Gemini API error");
        }

        await readSSE(res, (parsed) => {
            const parts = parsed?.candidates?.[0]?.content?.parts || [];
            const chunk = parts.map((p) => p?.text || "").join("");
            emitChunk(chunk);
        });

        return fullText;
    }

        const baseUrl =
            provider === "openrouter"
                ? "https://openrouter.ai/api/v1"
                : "https://api.openai.com/v1";

        const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
        };

        if (provider === "openrouter") {
            headers["HTTP-Referer"] = window.location.origin;
            headers["X-Title"] = "Axpert AXI";
        }

        // OpenAI or OpenRouter — only model/messages/temperature/max_tokens in body.
        const res = await _axiFetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: useModel,
                messages,
                temperature,
                max_tokens: maxtokens,
                stream: true
            })
        });

        handleAuthFailure(provider, res.status);

        if (!res.ok) {
            const d = await res.json();
            throw new Error(d?.error?.message || `${provider} API error`);
        }

        await readSSE(res, (parsed) => {
            const delta = parsed?.choices?.[0]?.delta || {};

            const thinkChunk =
                delta.thinking ||
                delta.reasoning ||
                delta.reasoning_content ||
                "";

            if (thinkChunk) {
                onThinking?.(thinkChunk);
            }

            const chunk =
                typeof delta.content === "string"
                    ? delta.content
                    : Array.isArray(delta.content)
                        ? delta.content.map((p) => p?.text || "").join("")
                        : "";

            emitChunk(chunk);
        });

        return fullText;
    }
    // ─────────────────────────────────────────────────────────────────────────────

    const state = {
        busy: false,
        chats: [],
        activeChatId: null,
        pendingAttachments: []
    };

    const el = {
        // rail + popover
        historyBtn: document.getElementById("historyBtn"),
        historyPopover: document.getElementById("historyPopover"),
        closeHistory: document.getElementById("closeHistory"),
        chatList: document.getElementById("chatList"),
        newChat: document.getElementById("newChat"),
        reset: document.getElementById("reset"),

        // main
        messages: document.getElementById("messages"),
        typing: document.getElementById("typing"),

        // composer
        composer: document.getElementById("composer"),
        fileInput: document.getElementById("fileInput"),
        attachmentTray: document.getElementById("attachmentTray"),
        prompt: document.getElementById("prompt"),
        send: document.getElementById("send")

    };

    // Fix: Use stopPropagation to prevent UI glitches
    document.getElementById("newChatFromHistory")?.addEventListener("click", (e) => {
        e.stopPropagation(); // Stop click from bubbling
        newChat();
        closeHistory(); // Close the popover gracefully
    });

    function renderAttachmentTray() {
        if (!state.pendingAttachments.length) {
            el.attachmentTray.classList.add("attachmentTray--hidden");
            el.attachmentTray.innerHTML = "";
            return;
        }

        el.attachmentTray.classList.remove("attachmentTray--hidden");
        el.attachmentTray.innerHTML = "";

        state.pendingAttachments.forEach((a, idx) => {
            const chip = document.createElement("div");
            chip.className = "attachmentChip";

            const thumb = document.createElement("div");
            thumb.className = "attachmentChip__thumb";
            if (a.kind === "image" && a.previewUrl) {
                thumb.innerHTML = `<img src="${a.previewUrl}" alt="">`;
            } else {
                thumb.innerHTML = `<div style="width:100%;height:100%;display:grid;place-items:center;color:#999;font-size:10px;">${a.kind}</div>`;
            }

            const name = document.createElement("div");
            name.className = "attachmentChip__name";
            name.textContent = a.name;
            // 📌 Add Pin Button for files
            const pinBtn = document.createElement("button");
            pinBtn.type = "button";
            pinBtn.title = "Add to Data Pin";
            pinBtn.style.cssText = "flex:0 0 auto; height:24px; width:24px; border-radius:8px; border:1px solid #E2E8F0; background:#fff; color:#3B82F6; cursor:pointer; display:grid; place-items:center; margin-left:2px;";
            pinBtn.innerHTML = `<span class="material-icons" style="font-size:14px">push_pin</span>`;
            pinBtn.addEventListener("click", function (e) {
                e.stopPropagation();
                if (a.file) {
                    if (window.addFileToPin) window.addFileToPin(a.file);
                } else if (a.blob) {
                    const f = new File([a.blob], a.name, { type: a.type || "application/octet-stream" });
                    if (window.addFileToPin) window.addFileToPin(f);
                }
            });
            const rm = document.createElement("button");
            rm.className = "attachmentChip__remove";
            rm.type = "button";
            rm.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" style="width:14px;height:14px;">
        <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
            rm.addEventListener("click", () => {
                state.pendingAttachments.splice(idx, 1);
                renderAttachmentTray();
                syncComposerButtons();
            });

            chip.appendChild(thumb);
            chip.appendChild(name);
            chip.appendChild(pinBtn);
            chip.appendChild(rm);
            el.attachmentTray.appendChild(chip);
        });
    }

    /* OpenAI Helper */
    let OPENAI_API_KEY = localStorage.getItem("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") || "";

    async function getApiKey() {
        if (!OPENAI_API_KEY) {
            const key = "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"
            if (key) {
                OPENAI_API_KEY = key;
                localStorage.setItem("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", key);
            } else {
                throw new Error("API Key required.");
            }
        }
        return OPENAI_API_KEY;
    }

    function enhanceCodeBlocks(rootEl) {
        const pres = rootEl.querySelectorAll("pre");

        pres.forEach((pre) => {
            if (pre.closest(".codeCard")) return;

            const codeEl = pre.querySelector("code");
            if (!codeEl) return;

            const rawCode = codeEl.textContent || "";
            const langMatch = (codeEl.className || "").match(/language-([\w-]+)/);
            const language = (langMatch && langMatch[1]) ? langMatch[1] : "code";

            // ✅ FIX: Apply syntax highlighting BEFORE touching the DOM
            if (window.hljs && !codeEl.dataset.highlighted) {
                try { hljs.highlightElement(codeEl); } catch (e) { }
            }

            const wrapper = document.createElement("div");
            wrapper.className = "codeCard";

            const header = document.createElement("div");
            header.className = "codeCard__header";

            const langLabel = document.createElement("span");
            langLabel.className = "codeCard__lang";
            langLabel.textContent = language.toUpperCase();

            const copyBtn = document.createElement("button");
            copyBtn.type = "button";
            copyBtn.className = "codeCard__copy";
            copyBtn.innerHTML = `
          <svg viewBox="0 0 24 24" class="codeCard__copyIcon" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" ry="2"></rect>
            <path d="M5 15V5a2 2 0 0 1 2-2h10"></path>
          </svg>
          <span>Copy</span>
        `;

            async function copyToClipboard(text) {
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(text);
                    return;
                }
                const ta = document.createElement("textarea");
                ta.value = text;
                ta.setAttribute("readonly", "");
                ta.style.position = "fixed";
                ta.style.left = "-9999px";
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
            }

            copyBtn.addEventListener("click", async () => {
                try {
                    // ✅ FIX: Always read rawCode (plain text), not codeEl.textContent
                    // which now contains hljs span tags after highlighting
                    await copyToClipboard(rawCode);

                    copyBtn.classList.add("codeCard__copy--done");
                    copyBtn.querySelector("span").textContent = "Copied";
                    setTimeout(() => {
                        copyBtn.classList.remove("codeCard__copy--done");
                        copyBtn.querySelector("span").textContent = "Copy";
                    }, 1400);
                } catch (e) {
                    console.error("Copy failed:", e);
                }
            });

            const body = document.createElement("div");
            body.className = "codeCard__body";

            header.appendChild(langLabel);
            header.appendChild(copyBtn);
            wrapper.appendChild(header);
            wrapper.appendChild(body);

            pre.classList.add("codeCard__pre");
            pre.replaceWith(wrapper);
            body.appendChild(pre);
        });
    }

    function buildDatasetPayload(fileName, rows, profile, aggregates) {
        // Keep payload small + useful
        const sampleRows = rows.slice(0, 50);

        return {
            fileName,
            schema: {
                rowCount: profile.rowCount,
                columns: profile.columns,
                missingRatio: profile.missingRatio
            },
            aggregates,      // your precomputed counts are perfect for charts
            sampleRows       // gives model a feel of the raw data
        };
    }

    function renderDatasetOverviewCard(contentWrap, profile, aggregates) {
        if (!profile) return;
        const card = document.createElement("article");
        card.className = "insightsCard";

        const headline = document.createElement("div");
        headline.className = "insightsCard__headline";
        headline.textContent = "Dataset overview";

        const summary = document.createElement("div");
        summary.className = "insightsCard__summary";
        summary.textContent = `This file has ${profile.rowCount.toLocaleString()} rows across ` +
            `${profile.columns.length} columns, with ` +
            `${(profile.missingRatio * 100).toFixed(1)}% missing cells.`;

        const metrics = document.createElement("div");
        metrics.className = "insightsCard__metrics";

        // Example metric 1: Row count
        const m1 = document.createElement("div");
        m1.className = "insightsCard__metric";
        m1.innerHTML = `<strong>${profile.rowCount.toLocaleString()}</strong><span>Rows</span>`;

        // Example metric 2: Column count
        const m2 = document.createElement("div");
        m2.className = "insightsCard__metric";
        m2.innerHTML = `<strong>${profile.columns.length}</strong><span>Columns</span>`;

        metrics.appendChild(m1);
        metrics.appendChild(m2);

        card.appendChild(headline);
        card.appendChild(summary);
        card.appendChild(metrics);
        contentWrap.appendChild(card);
    }

    function renderHighchartInMessage(container, chartSpec) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = `
    position:relative; margin-top:20px; border-radius:12px;
    overflow:hidden; box-shadow:0 4px 12px rgba(0,0,0,0.05);
  `;

        const chartDiv = document.createElement('div');
        chartDiv.style.cssText = `width:100%; height:320px;`;
        wrapper.appendChild(chartDiv);

        container.appendChild(wrapper);

        const chart = Highcharts.chart(chartDiv, {
            chart: {
                type: chartSpec.type || 'line',
                style: { fontFamily: 'Inter, sans-serif' },
                backgroundColor: '#ffffff',
                // Enable the built-in context menu but we'll also add our own button
                events: {
                    render() {
                        // nothing needed here
                    }
                }
            },
            title: { text: chartSpec.title || 'Chart' },
            xAxis: chartSpec.xAxis,
            yAxis: { title: { text: 'Values' } },
            series: chartSpec.series,
            credits: { enabled: false },
            plotOptions: { series: { borderRadius: 4, animation: { duration: 1000 } } },
            colors: ['#2563EB', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6'],
            exporting: {
                enabled: true,
                fallbackToExportServer: false,  // ← never phone home
                buttons: {
                    contextButton: { enabled: false }
                }
            },
        });

        // ── Custom Download Button ─────────────────────────────────────────────
        const dlBtn = document.createElement('button');
        dlBtn.title = 'Download chart as PNG';
        dlBtn.style.cssText = `
    position:absolute; top:10px; right:10px; z-index:10;
    display:flex; align-items:center; gap:5px;
    padding:5px 11px; border-radius:8px;
    border:1.5px solid #E2E8F0; background:rgba(255,255,255,0.92);
    backdrop-filter:blur(4px); color:#374151;
    font-size:12px; font-weight:500; cursor:pointer;
    box-shadow:0 1px 4px rgba(0,0,0,0.08);
    transition:background 0.15s, border-color 0.15s;
  `;
        dlBtn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
    PNG
  `;

        dlBtn.onmouseover = () => {
            dlBtn.style.background = '#EFF6FF';
            dlBtn.style.borderColor = '#93C5FD';
        };
        dlBtn.onmouseout = () => {
            dlBtn.style.background = 'rgba(255,255,255,0.92)';
            dlBtn.style.borderColor = '#E2E8F0';
        };

        dlBtn.addEventListener('click', () => {
            const title = chartSpec.title || 'chart';
            const safeName = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            // USE this instead — works on all modern Highcharts versions
            try {
                chart.exportChart(
                    { type: 'image/png', filename: safeName },
                    { chart: { backgroundColor: '#ffffff' } }
                );
            } catch (e) {
                // Ultimate fallback — grab the SVG and convert via canvas
                const svg = chart.getSVG({ chart: { backgroundColor: '#ffffff' } });
                const blob = new Blob([svg], { type: 'image/svg+xml' });
                const url = URL.createObjectURL(blob);
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width || 800;
                    canvas.height = img.height || 400;
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0);
                    URL.revokeObjectURL(url);
                    const a = document.createElement('a');
                    a.download = `${safeName}.png`;
                    a.href = canvas.toDataURL('image/png');
                    a.click();
                };
                img.src = url;
            }

            // Brief success flash
            dlBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
        stroke="#22C55E" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      Saved!
    `;
            dlBtn.style.borderColor = '#86EFAC';
            dlBtn.style.color = '#16A34A';
            setTimeout(() => {
                dlBtn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        PNG
      `;
                dlBtn.style.borderColor = '#E2E8F0';
                dlBtn.style.color = '#374151';
            }, 1800);
        });

        wrapper.appendChild(dlBtn);

        if (chartSpec._summary) {
            const s = document.createElement('div');
            s.style.cssText = 'padding:10px 16px 14px;font-size:13px;color:#4B5563;line-height:1.6;border-top:1px solid #E5E7EB;background:#F8FAFC;border-radius:0 0 12px 12px';
            s.textContent = chartSpec._summary;
            wrapper.appendChild(s);
        }
    }


    // --- OpenRouter key (for now you can hardcode) ---


    async function callOpenRouterForTableAndInsights(
        datasetPayload,
        userGoal = "Generate a smart table view and insights"
    ) {
        const system = `
Return ONLY valid JSON (no markdown) in this shape:
{
  "table": {
    "title": "string",
    "columns": [{ "key": "exact_column_name", "label": "string", "type": "text|number|date" }],
    "rowCount": 20,
    "sort": { "key": "exact_column_name", "dir": "asc|desc" }
  },
  "insights": {
    "headline": "string",
    "summary": "string",
    "keymetrics": [{ "label": "string", "value": "string" }],
    "highlights": ["string", "string", "string"],
    "qualityFlags": ["string", "string"],
    "columnNotes": [{ "key": "exact_column_name", "note": "string" }]
  },
  "report": {
    "title": "string",
    "sections": [
      { "heading": "string", "body": "2-4 sentence narrative tailored to the detected dataset" }
    ]
  }
}

Rules:
- Ground every statement in datasetPayload.schema, datasetPayload.aggregates, datasetPayload.safety, and datasetPayload.sampleRows.
- Never invent columns or values.
- Use exact column names in table.columns and columnNotes.
- If a requested field is not explicit in the data, say "Not available in provided data".
- Never infer gender, pronouns, role, title, seniority, department, or relationship from a person's name.
- If datasetPayload.safety.isPeopleDataset is true:
  - treat rows as person/employee records;
  - use neutral wording like "employee", "person", or "record", or use the exact name value from the row;
  - mention gender only if an explicit gender column exists and the exact row value is present;
  - mention role/title only if an explicit role/title column exists and use the exact cell text exactly as stored;
  - do not rewrite, normalize, or reinterpret a designation/title;
  - if values conflict, report that as a data quality flag instead of correcting it.
- Keep the response concise, practical, analytical, and strictly grounded.
  `.trim();

        const userMsg = `
Goal: ${userGoal}
Dataset JSON: ${JSON.stringify(datasetPayload)}
  `.trim();

        const raw = await axiChatCompletion({
            messages: [
                { role: "system", content: system },
                { role: "user", content: userMsg }
            ],
            temperature: 0,
            max_tokens: 4000
        });

        const text = typeof raw === "string" ? raw : (raw?.text || "");
        const parsed = tryParseJsonStrict(text);
        return parsed ? parsed : { fallbackText: text };
    }




    function sanitizeJsonString(str) {
        // Fix unquoted number+unit values: "key": 2.03 units  →  "key": "2.03 units"
        str = str.replace(/:\s*(\d+(?:\.\d+)?)\s+([a-zA-Z][a-zA-Z]*)\b(?=\s*[,}\]])/g, ': "$1 $2"');
        // Fix trailing commas before } or ]
        str = str.replace(/,(\s*[}\]])/g, '$1');
        return str;
    }

    function convertNamedSectionReport(reportObj) {
        const report = reportObj.report || reportObj;
        let md = '';
        const charts = [];

        for (const [key, value] of Object.entries(report)) {
            if (key.toLowerCase().includes('chart')) {
                const arr = Array.isArray(value) ? value : (value && value.charts ? value.charts : null);
                if (arr) {
                    arr.forEach(item => {
                        if (item && item.chart) charts.push(item.chart);
                        else if (item && item.type) charts.push(item);
                    });
                }
                if (charts.length) md += `## ${key}\n\n*${charts.length} chart(s) rendered below.*\n\n`;
                continue;
            }
            md += `## ${key}\n\n`;
            md += _inlineObjToMd(value);
            md += '\n';
        }

        return md.trim() ? { markdown: md.trim(), charts } : null;
    }

    function convertReportJsonToMarkdown(reportObj) {
        if (!reportObj || typeof reportObj !== 'object') return null;

        // Handle both { report: {...} } and direct report structure
        const report = reportObj.report || reportObj;

        if (!report.summary && !report.insights && !report.charts) return null;

        let md = '';

        // Executive Summary
        if (report.summary) {
            md += '## Executive Summary\n\n';
            if (report.summary.totalRecords !== undefined) {
                md += `**Total Records Analyzed:** ${report.summary.totalRecords}\n\n`;
            }

            if (report.summary.sources && typeof report.summary.sources === 'object') {
                md += '**Data Sources:**\n';
                Object.entries(report.summary.sources).forEach(([key, val]) => {
                    md += `- ${key}: ${val}\n`;
                });
                md += '\n';
            }

            if (report.summary.missingData && typeof report.summary.missingData === 'object') {
                md += '**Missing Data:**\n';
                Object.entries(report.summary.missingData).forEach(([key, val]) => {
                    md += `- ${key}: ${val}\n`;
                });
                md += '\n';
            }
        }

        // Insights Section
        if (report.insights && typeof report.insights === 'object') {
            md += '## Key Insights\n\n';

            Object.entries(report.insights).forEach(([category, value]) => {
                if (category === 'charts') return; // Skip charts section

                md += `### ${capitalizeFirst(category)}\n`;

                if (typeof value === 'object' && value !== null) {
                    if (Array.isArray(value)) {
                        value.forEach(item => {
                            if (typeof item === 'object' && item !== null) {
                                const parts = Object.entries(item).map(([k, v]) => `**${capitalizeFirst(k)}**: ${v}`);
                                md += `- ${parts.join(', ')}\n`;
                            } else {
                                md += `- ${item}\n`;
                            }
                        });
                    } else {
                        Object.entries(value).forEach(([k, v]) => {
                            if (typeof v === 'object' && v !== null && v.item !== undefined) {
                                // Handle nested objects like { item: "...", amount: ... }
                                md += `- **${v.item}**: ${v.amount || v.value || v.count || ''}\n`;
                            } else {
                                md += `- **${capitalizeFirst(k)}:** ${v}\n`;
                            }
                        });
                    }
                } else {
                    md += `${value}\n`;
                }
                md += '\n';
            });
        }

        // Recommendations
        if (Array.isArray(report.recommendations) && report.recommendations.length) {
            md += '## Recommendations\n\n';
            report.recommendations.forEach(rec => {
                md += `- ${rec}\n`;
            });
            md += '\n';
        }

        return md.trim();
    }

    function parseInlineJsonSections(answer) {
        // Handles AI responses like: "Executive Overview: text\nKey Findings: [{json}]\n..."
        // Also handles plain-text sections (not just JSON sections).
        const sections = {};       // JSON-parsed sections
        const sectionText = {};    // Plain-text sections
        const sectionOrder = [];

        // Known report section names — used to detect plain-text sections safely
        const KNOWN_SECTIONS = /^(executive overview|key findings?|supporting charts?|anomalies?(\s*[&\/]\s*risks?)?|recommendations?|summary|insights?|data quality|highlights?|findings?|risks?|overview|conclusion)$/i;

        // Normalize smart/curly quotes that break JSON.parse
        const normalized = answer
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/[\u2018\u2019]/g, "'");

        const lines = normalized.split(/\r?\n/);
        // Matches "SectionName: {" or "SectionName: ["
        const jsonSectionStart = /^([A-Za-z][A-Za-z &]+):\s*(\{|\[)/;
        // Matches "SectionName: some plain text" — used only for known section names
        const textSectionStart = /^([A-Za-z][A-Za-z &]{2,}):\s*(.+)/;

        let i = 0;
        while (i < lines.length) {
            // Strip leading bullet/list markers (e.g. "* ", "- ") so AI responses
            // that wrap sections in a markdown list are still parsed correctly.
            const line = lines[i].trimEnd().replace(/^[\*\-]\s+/, '');

            // --- Try JSON section (name and JSON start on same line) ---
            const jsonM = line.match(jsonSectionStart);
            if (jsonM) {
                const name = jsonM[1].trim();
                const colonPos = line.indexOf(':');
                let rest = line.substring(colonPos + 1).trim();

                // Try single-line JSON first; fall back to accumulating lines until brackets balance
                let parsed = null;
                try {
                    parsed = JSON.parse(rest);
                } catch (e) {
                    let depth = 0;
                    for (const ch of rest) {
                        if (ch === '{' || ch === '[') depth++;
                        else if (ch === '}' || ch === ']') depth--;
                    }
                    let j = i + 1;
                    while (j < lines.length && depth > 0) {
                        rest += '\n' + lines[j];
                        for (const ch of lines[j]) {
                            if (ch === '{' || ch === '[') depth++;
                            else if (ch === '}' || ch === ']') depth--;
                        }
                        j++;
                    }
                    try { parsed = JSON.parse(rest); i = j - 1; } catch (e2) { }
                }

                if (parsed !== null) {
                    sections[name] = parsed;
                    if (!sectionOrder.includes(name)) sectionOrder.push(name);
                    i++;
                    continue;
                }
            }

            // --- Try JSON section where JSON is on the NEXT line ---
            // e.g. "Key Findings:\n[{...}]"
            const nameOnlyM = line.match(/^([A-Za-z][A-Za-z &]+):\s*$/);
            if (nameOnlyM && i + 1 < lines.length) {
                const nextLine = lines[i + 1].trimEnd();
                if (/^\s*[\[{]/.test(nextLine)) {
                    const name = nameOnlyM[1].trim();
                    let rest = nextLine.trim();
                    let parsed = null;
                    try {
                        parsed = JSON.parse(rest);
                    } catch (e) {
                        let depth = 0;
                        for (const ch of rest) {
                            if (ch === '{' || ch === '[') depth++;
                            else if (ch === '}' || ch === ']') depth--;
                        }
                        let j = i + 2;
                        while (j < lines.length && depth > 0) {
                            rest += '\n' + lines[j];
                            for (const ch of lines[j]) {
                                if (ch === '{' || ch === '[') depth++;
                                else if (ch === '}' || ch === ']') depth--;
                            }
                            j++;
                        }
                        try { parsed = JSON.parse(rest); i = j - 1; } catch (e2) { }
                    }
                    if (parsed !== null) {
                        sections[name] = parsed;
                        if (!sectionOrder.includes(name)) sectionOrder.push(name);
                        i += 2;
                        continue;
                    }
                }
            }

            // --- Try plain-text section (known section names only to avoid false positives) ---
            const textM = line.match(textSectionStart);
            if (textM && KNOWN_SECTIONS.test(textM[1].trim())) {
                const name = textM[1].trim();
                const colonPos = line.indexOf(':');
                const text = line.substring(colonPos + 1).trim();
                if (text && !sectionOrder.includes(name)) {
                    sectionText[name] = text;
                    sectionOrder.push(name);
                }
            }

            i++;
        }

        if (sectionOrder.length < 2) return null;

        let md = '';
        const charts = [];

        for (const sectionName of sectionOrder) {
            const nameLower = sectionName.toLowerCase();

            // Plain-text section
            if (sectionText[sectionName] !== undefined) {
                md += `## ${sectionName}\n\n${sectionText[sectionName]}\n\n`;
                continue;
            }

            const data = sections[sectionName];
            if (data === undefined) continue;

            if (nameLower.includes('chart')) {
                const chartsArr = data.charts || (Array.isArray(data) ? data : null);
                if (chartsArr) {
                    chartsArr.forEach(item => {
                        if (item && item.chart) charts.push(item.chart);
                        else if (item && item.type) charts.push(item);
                    });
                }
                if (charts.length) md += `## ${sectionName}\n\n*${charts.length} chart(s) rendered below.*\n\n`;
                continue;
            }

            md += `## ${sectionName}\n\n`;
            md += _inlineObjToMd(data);
            md += '\n';
        }

        return md.trim() ? { markdown: md.trim(), charts } : null;
    }

    function _inlineObjToMd(data) {
        if (!data || typeof data !== 'object') return String(data) + '\n';
        let md = '';
        const toLabel = k => k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();

        if (Array.isArray(data)) {
            data.forEach(item => {
                if (typeof item === 'object' && item !== null) {
                    const entries = Object.entries(item);
                    md += `- ${entries.map(([k, v]) => `**${toLabel(k)}**: ${v}`).join(', ')}\n`;
                } else {
                    md += `- ${item}\n`;
                }
            });
            return md;
        }

        Object.entries(data).forEach(([key, value]) => {
            const label = toLabel(key);
            if (Array.isArray(value)) {
                md += `- **${label}:**\n`;
                value.forEach(item => {
                    if (typeof item === 'object' && item !== null) {
                        const parts = Object.entries(item).map(([k, v]) => `${toLabel(k)}: ${v}`);
                        md += `  - ${parts.join(', ')}\n`;
                    } else {
                        md += `  - ${item}\n`;
                    }
                });
            } else if (typeof value === 'object' && value !== null) {
                md += `- **${label}:**\n`;
                Object.entries(value).forEach(([k, v]) => {
                    if (typeof v === 'object' && v !== null) {
                        const parts = Object.entries(v).map(([k2, v2]) => `${toLabel(k2)}: ${v2}`);
                        md += `  - **${toLabel(k)}:** ${parts.join(', ')}\n`;
                    } else {
                        md += `  - ${toLabel(k)}: ${v}\n`;
                    }
                });
            } else {
                md += `- **${label}:** ${value}\n`;
            }
        });

        return md;
    }

    function convertUnknownJsonToMarkdown(obj) {
        if (!obj || typeof obj !== 'object') return null;

        const json = obj;
        let md = '';

        // Check if it looks like a report-like structure
        const keys = Object.keys(json);
        if (keys.length === 0) return null;

        // If it's just a simple object with primitives, return as-is
        const isSimple = keys.every(k => typeof json[k] !== 'object');
        if (isSimple) {
            md += '## Data\n\n';
            Object.entries(json).forEach(([k, v]) => {
                md += `- **${capitalizeFirst(k)}:** ${v}\n`;
            });
            return md;
        }

        // Try to structure it as a report
        md += '## Report\n\n';

        Object.entries(json).forEach(([key, value]) => {
            if (key === 'chart' || key === 'charts' || key === '__proto__' || key === 'prototype') return;

            md += `### ${capitalizeFirst(key)}\n`;

            if (typeof value === 'object' && value !== null) {
                if (Array.isArray(value)) {
                    value.forEach(item => {
                        if (typeof item === 'object' && item !== null) {
                            const parts = Object.entries(item).map(([k, v]) => `${capitalizeFirst(k)}: ${v}`);
                            md += `- ${parts.join(', ')}\n`;
                        } else {
                            md += `- ${item}\n`;
                        }
                    });
                } else {
                    Object.entries(value).forEach(([k, v]) => {
                        if (typeof v === 'object' && v !== null) {
                            const nestedParts = Object.entries(v).map(([nk, nv]) => `${capitalizeFirst(nk)}: ${nv}`);
                            md += `- **${capitalizeFirst(k)}:** ${nestedParts.join('; ')}\n`;
                        } else {
                            md += `- **${capitalizeFirst(k)}:** ${v}\n`;
                        }
                    });
                }
            } else {
                md += `${value}\n`;
            }
            md += '\n';
        });

        return md.trim() || null;
    }

    function capitalizeFirst(str) {
        return str.charAt(0).toUpperCase() + str.slice(1).replace(/([A-Z])/g, ' $1').trim();
    }

    function renderNarrativeReport(contentWrap, report) {
        if (!report || !Array.isArray(report.sections) || !report.sections.length) return;

        const card = document.createElement("article");
        card.className = "answerCard";

        const header = document.createElement("div");
        header.className = "answerCardheader";

        const label = document.createElement("span");
        label.className = "answerCardlabel";
        label.textContent = report.title || "Project report";

        header.appendChild(label);
        card.appendChild(header);

        const body = document.createElement("div");
        body.className = "answerCardbody";

        report.sections.slice(0, 4).forEach(sec => {
            const h = document.createElement("h3");
            h.textContent = sec.heading || "Overview";
            const p = document.createElement("p");
            p.textContent = sec.body || "";
            body.appendChild(h);
            body.appendChild(p);
        });

        card.appendChild(body);
        contentWrap.appendChild(card);
    }



    function renderTableInMessage(contentWrap, rows, tableSpec, profile) {
        const spec = tableSpec || {};
        const rowCount = Math.max(5, Math.min(25, Number(spec.rowCount || 20) || 20));

        // Columns from AI or fallback
        const fallbackCols = (profile?.columns || [])
            .slice(0, 6)
            .map(k => ({ key: k, label: k, type: "text" }));

        const cols = Array.isArray(spec.columns) && spec.columns.length
            ? spec.columns.slice(0, 8)
            : fallbackCols;

        // ✅ NORMALISE COLUMNS ONCE (OUTSIDE ROW LOOP)
        const actualCols = new Set((profile?.columns || []).map(String));

        let safeCols = cols.filter(c => actualCols.has(String(c.key)));

        if (!safeCols.length) {
            safeCols = (profile?.columns || [])
                .slice(0, 6)
                .map(k => ({ key: k, label: k, type: "text" }));
        }

        const finalCols = safeCols;

        // Debug once
        console.log("Table columns from AI/final:", finalCols.map(c => c.key));
        console.log("Sample row keys:", rows[0] && Object.keys(rows[0]));

        const card = document.createElement("article");
        card.className = "tableCard";

        const header = document.createElement("div");
        header.className = "tableCardheader";
        header.textContent = spec.title || "Data preview";

        const tableWrap = document.createElement("div");
        tableWrap.className = "tableCardwrap";

        const table = document.createElement("table");
        table.className = "tableCardtable";

        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        finalCols.forEach(c => {
            const th = document.createElement("th");
            th.textContent = c.label || c.key;
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);

        // Optional sort
        let viewRows = rows.slice(0);
        if (spec.sort?.key && finalCols.some(c => c.key === spec.sort.key)) {
            const dir = (spec.sort.dir || "asc").toLowerCase() === "desc" ? -1 : 1;
            const key = spec.sort.key;
            viewRows.sort((a, b) => {
                const av = a?.[key];
                const bv = b?.[key];
                const an = Number(av);
                const bn = Number(bv);
                const bothNum = Number.isFinite(an) && Number.isFinite(bn);
                if (bothNum) return (an - bn) * dir;
                return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
            });
        }

        const tbody = document.createElement("tbody");
        viewRows.slice(0, rowCount).forEach(r => {
            const tr = document.createElement("tr");
            finalCols.forEach(c => {
                const td = document.createElement("td");
                const v = r && typeof c.key === "string" ? r[c.key] : undefined;
                const text =
                    v === null || v === undefined || String(v).trim() === ""
                        ? "—"
                        : String(v);
                td.textContent = text;
                td.title = text;
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });

        table.appendChild(thead);
        table.appendChild(tbody);
        tableWrap.appendChild(table);
        card.appendChild(header);
        card.appendChild(tableWrap);
        contentWrap.appendChild(card);
    }


    function renderTableNotes(contentWrap, payload) {
        const flags = payload?.insights?.qualityFlags || [];
        const notes = payload?.insights?.columnNotes || [];
        if (!flags.length && !notes.length) return;

        const card = document.createElement("article");
        card.className = "tableNotesCard";

        if (flags.length) {
            const h = document.createElement("div");
            h.className = "tableNotesCardtitle";
            h.textContent = "Data quality flags";
            card.appendChild(h);

            const ul = document.createElement("ul");
            ul.className = "tableNotesCardlist";
            flags.slice(0, 6).forEach(t => {
                const li = document.createElement("li");
                li.textContent = String(t);
                ul.appendChild(li);
            });
            card.appendChild(ul);
        }

        if (notes.length) {
            const h2 = document.createElement("div");
            h2.className = "tableNotesCardtitle";
            h2.textContent = "Column notes";
            card.appendChild(h2);

            const ul2 = document.createElement("ul");
            ul2.className = "tableNotesCardlist";
            notes.slice(0, 8).forEach(n => {
                const li = document.createElement("li");
                li.textContent = `${n.key}: ${n.note}`;
                ul2.appendChild(li);
            });
            card.appendChild(ul2);
        }

        contentWrap.appendChild(card);
    }


    function tryParseJsonStrict(text) {
        // Handle raw JSON or JSON inside ```json ... ```
        const trimmed = (text || "").trim();
        const fenced = trimmed.match(/```json([\s\S]*?)```/i);
        const candidate = fenced ? fenced[1].trim() : trimmed;

        try { return JSON.parse(candidate); }
        catch { return null; }
    }

    // Helper: Read file as text
    function readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(e);
            reader.readAsText(file);
        });
    }

    function clipFileText(fullData, maxChars = 60000) {
        const text = String(fullData || "").trim();
        if (!text) return "No readable text could be extracted from this file.";
        return text.length > maxChars
            ? text.slice(0, maxChars) + `\n...[TRUNCATED ${text.length - maxChars} chars omitted]`
            : text;
    }

    function buildFileContextFromText(fileName, fullData) {
        const clipped = clipFileText(fullData, 60000);
        return `--- SYSTEM FILE CONTENT ATTACHED ---
Name: ${fileName}
Content:
${clipped}
--- END FILE CONTENT ---`;
    }

    async function extractTextFromDocx(file) {
        if (!window.mammoth) {
            throw new Error("DOCX parser not loaded. Add mammoth.browser.min.js to index.html.");
        }

        const arrayBuffer = await file.arrayBuffer();
        const result = await window.mammoth.extractRawText({ arrayBuffer });
        const text = String(result?.value || "").trim();

        console.log("DOCX extraction:", {
            name: file.name,
            chars: text.length,
            warnings: result?.messages || []
        });

        if (!text) {
            throw new Error("DOCX text extraction returned empty content.");
        }

        return text;
    }


    async function extractTextFromPdf(file) {
        if (!window.pdfjsLib) {
            throw new Error("PDF parser not loaded. Add pdf.js loader to index.html.");
        }

        // DataBin stores files as metadata-only objects {name, type, size} without binary content.
        // Calling .arrayBuffer() on such an object throws TypeError. Detect this early and return
        // a structured notice so the AI can inform the user clearly instead of crashing silently.
        if (typeof file.arrayBuffer !== "function") {
            return (
                `[FILE_CONTENT_UNAVAILABLE]\n` +
                `File: ${file.name}\n` +
                `Status: This file is referenced in the Data Bin but its content is not available ` +
                `in this session. The Data Bin stores file metadata only (name, type, size) — ` +
                `not the actual file bytes.\n` +
                `Instruction: Tell the user they need to upload "${file.name}" directly into the ` +
                `chat (drag-and-drop or the attachment button) for the AI to read and analyze it. ` +
                `Simply having it in the Data Bin is not enough for file-content analysis.`
            );
        }

        const data = new Uint8Array(await file.arrayBuffer());
        const pdf = await window.pdfjsLib.getDocument({
            data,
            disableWorker: true
        }).promise;

        let out = [];
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const content = await page.getTextContent();
            const pageText = content.items
                .map(item => item?.str || "")
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();

            if (pageText) out.push(`--- Page ${pageNum} ---\n${pageText}`);
        }

        const result = out.join("\n\n").trim();

        console.log("[AXI] PDF extraction:", { name: file.name, pages: pdf.numPages, chars: result.length });

        if (!result) {
            // Return a structured notice so the AI can report the issue clearly to the user
            // instead of silently passing empty content which causes contradictory AI responses.
            return (
                `[PDF_EXTRACTION_NOTICE]\n` +
                `File: ${file.name}\n` +
                `Pages: ${pdf.numPages}\n` +
                `Status: No selectable text could be extracted from this PDF. ` +
                `The document appears to be scanned or entirely image-based.\n` +
                `Instruction: Inform the user that this PDF contains no extractable text ` +
                `and suggest they upload a text-based or OCR-processed version of the document.`
            );
        }

        return result;
    }


    function tryParseDatasetJson(text) {
        try {
            let obj = JSON.parse(text);

            // Handle stringified inner JSON (like the Qubix "d" wrapper)
            if (obj && typeof obj.d === "string") {
                try {
                    obj = JSON.parse(obj.d);
                } catch (e) {
                    // Keep original obj if inner parse fails
                }
            }

            let rawRows = null;

            // Pattern 1: Nested data object (e.g., result.data[0].data)
            if (Array.isArray(obj?.result?.data?.[0]?.data)) {
                rawRows = obj.result.data[0].data;
            }
            // Pattern 2: Standard API wrapper
            else if (Array.isArray(obj?.result?.data)) {
                rawRows = obj.result.data;
            }
            // Pattern 3: Simple data wrapper
            else if (Array.isArray(obj?.data)) {
                rawRows = obj.data;
            }
            // Pattern 4: Direct array
            else if (Array.isArray(obj)) {
                rawRows = obj;
            }

            if (rawRows && rawRows.length > 0) {
                const rows = rawRows
                    .map(normalizeRow)
                    .filter(r => Object.values(r).some(v => String(v ?? "").trim() !== ""));

                if (rows.length && Object.keys(rows[0] || {}).length) {
                    return rows;
                }
            }
        } catch (_) {
            // Not valid JSON or failed to parse, fail silently and let CSV/TXT parsers try
        }
        return [];
    }

    function clearDatasetState(chat = getActiveChat(), options = {}) {
        const { clearFileContext = false } = options;

        if (chat) {
            chat.dataset = null;
            chat.datasetFileName = null;
            chat.datasetRows = null;
            chat.datasetProfile = null;
            chat.datasetAggregates = null;

            if (clearFileContext) {
                chat.fileContext = null;
                chat.fileName = null;
            }

            chat.updatedAt = Date.now();
            saveChats();
        }

        window.pendingDatabaseData = null;
    }

    function syncPendingDatabaseToActiveChat(chat = getActiveChat()) {
        if (chat && Array.isArray(chat.datasetRows) && chat.datasetRows.length) {
            window.pendingDatabaseData = {
                name: chat.datasetFileName || chat.fileName || "dataset",
                data: chat.datasetRows,
                chatId: chat.id
            };
            return;
        }

        window.pendingDatabaseData = null;
    }

    function isLikelyTabularText(text, parsed, rows) {
        if (!Array.isArray(rows) || !rows.length) return false;

        const fields = Array.isArray(parsed?.meta?.fields)
            ? parsed.meta.fields.filter(f => String(f).trim() !== "")
            : Object.keys(rows[0] || {}).filter(f => String(f).trim() !== "");

        if (fields.length < 2) return false;
        if (rows.length < 2) return false;

        const filledRows = rows.filter(row => {
            let filled = 0;
            for (const field of fields) {
                if (String(row?.[field] ?? "").trim() !== "") filled++;
            }
            return filled >= 2;
        }).length;

        if (filledRows < 2) return false;

        const raw = String(text || "").trim();
        if ((raw.startsWith("{") || raw.startsWith("[")) && rows.length <= 2) return false;

        return true;
    }

    function parseDelimitedTextToRows(text, options = {}) {
        if (typeof Papa === "undefined") return [];

        const { strict = false } = options;

        const parsed = Papa.parse(text, {
            header: true,
            skipEmptyLines: "greedy",
            delimiter: "",
            delimitersToGuess: [",", "\t", "|", ";"]
        });

        const rows = (parsed.data || [])
            .map(normalizeRow)
            .filter(r => Object.values(r).some(v => String(v ?? "").trim() !== ""));

        if (!rows.length) return [];
        if (!Object.keys(rows[0] || {}).length) return [];

        if (strict && !isLikelyTabularText(text, parsed, rows)) {
            return [];
        }

        return rows;
    }


    async function handleDatasetRowsFromFile(file, rows) {
        const profile = buildProfile(rows);
        const aggregates = buildAggregates(rows);

        const currentChat = getActiveChat();
        if (currentChat) {
            currentChat.dataset = { fileName: file.name, profile, aggregates };
            currentChat.datasetFileName = file.name;
            currentChat.datasetRows = rows;
            currentChat.datasetProfile = profile;
            currentChat.datasetAggregates = aggregates;
            currentChat.fileName = file.name;
            currentChat.fileContext = "";
            currentChat.updatedAt = Date.now();
            saveChats();
        }

        syncPendingDatabaseToActiveChat(currentChat);

        if (!el.prompt.value.trim()) {
            el.prompt.value = `Analyze this file: ${file.name}`;
            el.prompt.dispatchEvent(new Event("input", { bubbles: true }));
            refreshComposerState();
        }
    }


    async function extractTextForAnalysis(file) {
        const ext = extOf(file.name);

        if (ext === "txt") {
            return await file.text();
        }

        if (ext === "docx") {
            return await extractTextFromDocx(file);
        }

        if (ext === "pdf") {
            return await extractTextFromPdf(file);
        }

        return await readFileAsText(file);
    }


    function pickExistingColumns(columns, candidates) {
        const byLower = new Map((columns || []).map(col => [String(col).toLowerCase(), String(col)]));
        return (candidates || [])
            .map(c => byLower.get(String(c).toLowerCase()))
            .filter(Boolean);
    }

    function buildDatasetSafetyContext(rows, profile) {
        const safeRows = Array.isArray(rows) ? rows : [];
        const columns = Array.isArray(profile?.columns) ? profile.columns.map(String) : [];

        const idColumns = pickExistingColumns(columns, [
            "empid", "employeeid", "employee_id", "staffid", "staff_id", "userid", "user_id", "code"
        ]);

        const nameColumns = pickExistingColumns(columns, [
            "firstname", "lastname", "fullname", "full_name", "name", "employee_name", "staff_name"
        ]);

        const genderColumns = pickExistingColumns(columns, [
            "gender",
            "sex",
            "employee_gender",
            "gendername",
            "gender_name",
            "empgender",
            "emp_gender",
            "m/f"
        ]);


        const roleColumns = pickExistingColumns(columns, [
            "designation", "role", "title", "jobtitle", "job_title", "position", "employee_role"
        ]);

        const departmentColumns = pickExistingColumns(columns, [
            "department", "dept", "division", "team", "costcenter", "cost_center"
        ]);

        const locationColumns = pickExistingColumns(columns, [
            "locationname", "location", "branchname", "branch", "city", "state", "region"
        ]);

        const isPeopleDataset =
            idColumns.length > 0 ||
            nameColumns.length > 0 ||
            genderColumns.length > 0 ||
            roleColumns.length > 0;

        const identityColumns = [
            ...new Set([
                ...idColumns,
                ...nameColumns,
                ...genderColumns,
                ...roleColumns,
                ...departmentColumns,
                ...locationColumns
            ])
        ];

        const sampleIdentityRows = safeRows
            .slice(0, 25)
            .map(row => {
                const out = {};
                identityColumns.forEach(col => {
                    const val = row?.[col];
                    if (val !== null && val !== undefined && String(val).trim() !== "") {
                        out[col] = String(val).trim();
                    }
                });
                return out;
            })
            .filter(obj => Object.keys(obj).length > 0);

        return {
            datasetType: isPeopleDataset ? "people_or_payroll" : "generic",
            isPeopleDataset,
            identityColumns: {
                idColumns,
                nameColumns,
                genderColumns,
                roleColumns,
                departmentColumns,
                locationColumns
            },
            rules: isPeopleDataset
                ? [
                    "Never infer gender, pronouns, title, role, seniority, department, or relationship from a person's name.",
                    "Use only explicit column values present in the dataset.",
                    "For single-person statements, use the exact name value or neutral terms like employee/person/record.",
                    "Only mention gender when an explicit gender column exists and the exact row value is present.",
                    "Only mention role or title when an explicit role/title column exists and use the exact stored cell value.",
                    "If a value is missing, conflicting, or not explicit, say Not available in provided data or flag it as a data quality issue."
                ]
                : [
                    "Use only explicit values from the dataset.",
                    "Do not infer missing facts."
                ],
            sampleIdentityRows
        };
    }
    function buildChartPayload(fileName, rows, profile, aggregates) {
        const safeRows = Array.isArray(rows) ? rows : [];
        const safeProfile = profile || buildProfile(safeRows);
        const rawAggregates = aggregates || buildAggregates(safeRows);
        const safety = buildDatasetSafetyContext(safeRows, safeProfile);

        const chartAggregates = {};

        Object.entries(rawAggregates).forEach(([col, agg]) => {
            const item = { type: agg.type };

            if (agg.type === "numeric") {
                item.min = agg.min;
                item.max = agg.max;
                item.avg = agg.avg;
                if (typeof agg.sum !== "undefined") item.sum = agg.sum;
            }

            if (agg.counts) {
                const top = Object.entries(agg.counts)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 10);

                if (top.length) {
                    item.counts = Object.fromEntries(top);
                    item.uniqueCount = Object.keys(agg.counts).length;
                }
            }

            if (item.type === "numeric" || item.counts) {
                chartAggregates[col] = item;
            }
        });

        return {
            fileName,
            schema: {
                rowCount: safeProfile.rowCount,
                columns: safeProfile.columns
            },
            safety: {
                isPeopleDataset: !!safety.isPeopleDataset,
                genderColumns: safety.genderColumns || [],
                roleColumns: safety.roleColumns || [],
                departmentColumns: safety.departmentColumns || [],
                locationColumns: safety.locationColumns || []
            },
            aggregates: chartAggregates
        };
    }

    function buildLLMPayload(fileName, rows, profile, aggregates) {
        const safeRows = Array.isArray(rows) ? rows : [];
        const safeProfile = profile || buildProfile(safeRows);
        const rawAggregates = aggregates || buildAggregates(safeRows);

        // Build complete aggregates — send ALL counts for low-cardinality columns
        // so the AI can accurately report breakdowns without guessing
        const safeAggregates = {};
        Object.keys(rawAggregates).forEach(col => {
            const aggData = rawAggregates[col];
            if (!aggData || typeof aggData !== 'object') return;

            const colSummary = { type: aggData.type };

            if (aggData.type === 'numeric') {
                colSummary.sum = aggData.sum;
                colSummary.avg = aggData.avg;
                colSummary.min = aggData.min;
                colSummary.max = aggData.max;
                colSummary.count = aggData.count;
            }

            if (aggData.counts) {
                const uniqueCount = Object.keys(aggData.counts).length;
                colSummary.uniqueCount = uniqueCount;

                if (uniqueCount <= 100) {
                    // Send ALL counts — the AI needs the full picture for accurate breakdowns
                    colSummary.counts = aggData.counts;
                } else {
                    // Too many unique values: send top 20 and note the total
                    const top20 = Object.entries(aggData.counts)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 20);
                    if (top20.length) {
                        colSummary.counts = Object.fromEntries(top20);
                        colSummary.note = `Top 20 of ${uniqueCount} unique values shown`;
                    }
                }
            }

            safeAggregates[col] = colSummary;
        });

        // Send 50 sample rows (up from 10) so the AI can verify data format and spot anomalies
        const sample = safeRows.slice(0, 50);
        const safety = buildDatasetSafetyContext(safeRows, safeProfile);

        return {
            fileName,
            schema: {
                rowCount: safeProfile.rowCount,
                columns: safeProfile.columns,
                missingRatio: safeProfile.missingRatio
            },
            aggregates: safeAggregates,
            safety,
            sampleRows: sample
        };
    }

    // Global Copy Helper
    window.copyCode = function (btn) {
        const code = btn.closest('.codeCard').querySelector('code').innerText;
        navigator.clipboard.writeText(code);
        const original = btn.innerHTML;
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#98c379" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!`;
        setTimeout(() => btn.innerHTML = original, 2000);
    };

    const SYSTEM_PROMPT_CHARTS = `
You are a helpful AI assistant.

CHART PROTOCOL — HOW TO EMBED CHARTS IN ANY RESPONSE:
Always embed charts as a JSON code block (using triple backticks with "json" tag), like this:

\`\`\`json
{
  "chart": {
    "type": "column",
    "title": "Clear chart title",
    "xAxis": { "categories": ["Jan", "Feb", "Mar"] },
    "series": [
      { "name": "Meaningful metric label", "data": [10, 20, 30] }
    ]
  }
}
\`\`\`

For multiple charts:
\`\`\`json
{ "charts": [ { "chart": { ... } }, { "chart": { ... } } ] }
\`\`\`

CRITICAL RULES:
- NEVER output a bare JSON object or array as the main response body.
- NEVER wrap prose, bullet points, or report sections inside JSON objects.
- Charts go INSIDE json code blocks only. All other content uses plain Markdown.
- When writing a report or analysis that includes charts, use ## Markdown headers and bullet points for all text sections. Only the chart data goes in the json code block.

Legend naming rules:
- series.name must be specific and business-meaningful.
- Never use "Series 1", "Series", "Metric", "Values", or "Data".
- Use labels like "Revenue", "Invoice Count", "Units Sold", "Cancelled Orders", "Tax Amount", or another exact metric supported by the data.
- If there is only one series, it still needs a proper name.
- Chart title and legend must not say the same vague thing.
`;



    function isContextLimitError(err) {
        const msg = String(err?.message || err || "");
        return msg.includes("maximum context length") || msg.includes("context length");
    }

    function topN(obj, n = 8) {
        return Object.entries(obj || {})
            .sort((a, b) => (b[1] || 0) - (a[1] || 0))
            .slice(0, n);
    }

    function generateLocalReportMarkdown(datasetName, rows) {
        const profile = buildProfile(rows);
        const aggregates = buildAggregates(rows);

        const sections = [];

        sections.push(`## Executive Summary
Rows: ${profile.rowCount.toLocaleString()}
Columns: ${profile.columns.length}
Missing cells: ${(profile.missingRatio * 100).toFixed(1)}%`);

        const numericLines = Object.entries(aggregates)
            .filter(([, v]) => v && v.type === "numeric")
            .slice(0, 6)
            .map(([k, v]) => `- ${k}: total ${Number(v.sum).toLocaleString()}, average ${Number(v.avg).toLocaleString()}`);

        if (numericLines.length) {
            sections.push(`## Numeric Metrics
${numericLines.join("\n")}`);
        }

        const categoricalLines = Object.entries(aggregates)
            .filter(([, v]) => v && v.type === "categorical")
            .slice(0, 5)
            .map(([k, v]) => {
                const top = Object.entries(v.counts || {})
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5)
                    .map(([label, count]) => `${label}: ${count}`)
                    .join(", ");
                return `- ${k}: ${top || "No dominant values"}`;
            });

        if (categoricalLines.length) {
            sections.push(`## Category Highlights
${categoricalLines.join("\n")}`);
        }

        const trend = aggregates.__monthlyTrend?.values || null;
        if (trend && Object.keys(trend).length) {
            const trendLines = Object.entries(trend)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([month, value]) => `- ${month}: ${Number(value).toLocaleString()}`);
            sections.push(`## Time Trend
${trendLines.join("\n")}`);
        }

        sections.push(`## Notes
This report was generated locally because the AI request exceeded the model context window.`);

        return `# ${datasetName || "Dataset"} – Report

${sections.join("\n\n")}`;
    }



    function buildDbAnalysisPrompt(dbName, rows) {
        const safeRows = Array.isArray(rows) ? rows : [];
        const rowCount = safeRows.length;

        // Prevent massive payloads: send a sample, plus schema info
        const MAX_ROWS_TO_SEND = 200; // tune as needed
        const sample = safeRows.slice(0, MAX_ROWS_TO_SEND);

        const columns = rowCount ? Object.keys(sample[0] || {}) : [];

        return (
            `Analyze this database: ${dbName}
  
  Rules:
  - Only use the provided JSON data below.
  - If a value/column is not present, say "Not available in provided data".
  - Start by stating: rowCount, columns.
  
  rowCount: ${rowCount}
  columns: ${JSON.stringify(columns)}
  
  JSON DATA (first ${sample.length} rows):
  ${JSON.stringify(sample)}`
        );
    }

    function jsonToToon(rows) {
        if (!Array.isArray(rows) || !rows.length) return "";

        // Get all unique keys from the first row (the header)
        const keys = Object.keys(rows[0]);

        // Create the header row: col1 | col2 | col3
        let result = keys.join(" | ") + "\n";

        // Stream the data rows without repeating keys or using braces
        for (const row of rows) {
            result += keys.map(k => {
                const val = row[k];
                // Remove newlines from values so they don't break the row structure
                let strVal = String(val !== null && val !== undefined ? val : "");
                return strVal.replace(/\n/g, " ");
            }).join(" | ") + "\n";
        }

        return result;
    }

    function findBestMatchingRow(rows, query) {
        if (!Array.isArray(rows) || !rows.length) return null;

        const q = String(query || "").toLowerCase().trim();
        if (!q) return null;

        for (const row of rows) {
            const empid = String(row?.empid || "").toLowerCase().trim();
            if (empid && q.includes(empid)) return row;
        }

        const matches = rows.filter(row => {
            const name = String(row?.firstname || "").toLowerCase().trim();
            return name && q.includes(name);
        });

        if (matches.length === 1) return matches[0];
        return null;
    }


    async function callOpenAI(messages, datasetContext, _streamCallbacks) {
        const streamCallbacks = _streamCallbacks;
        let enhancedDatasetContext = datasetContext;
        let actualDataRows = null;
        let isRagFiltered = false;

        const incomingMessages = Array.isArray(messages)
            ? messages
                .filter(Boolean)
                .map(m => ({
                    role: m?.role,
                    content: typeof m?.content === "string" ? m.content : String(m?.content ?? "")
                }))
            : [];

        const nonSystemMessages = incomingMessages.filter(m => m.role !== "system");

        const lastUserMessage =
            [...nonSystemMessages]
                .reverse()
                .find(m => m.role === "user" && typeof m.content === "string")?.content
            || incomingMessages[incomingMessages.length - 1]?.content
            || "Analyze";

        const cleanUserMsg = String(lastUserMessage).trim();

        const isDbIntent =
            /^analy[zs]e/i.test(cleanUserMsg) ||
            !!window.pendingDatabaseData ||
            (enhancedDatasetContext && enhancedDatasetContext.source === "database");

        const isInitialAnalysis =
            !!window.pendingDatabaseData ||
            /^analy[zs]e\b/i.test(cleanUserMsg) ||
            /^(give me|provide|generate|create|i want|can you give|can you provide).*?\b(overview|analy[zs]is|summary|report)\b/i.test(cleanUserMsg) ||
            /^summarize\b/i.test(cleanUserMsg) ||
            /^(overview|analysis|summary)$/i.test(cleanUserMsg);

        const isConversationalFollowUp =
            /explain|what does|why is|why are|how come|tell me more|elaborate|can you explain|help me understand|clarify|summarize the chart|what do (these|the|those) charts?|break(ing)? (it|this|that|them) down|interpret|what('s| is) (this|that|the)|describe/i.test(cleanUserMsg) ||
            /these charts?|this chart|the previous|above data|from (the )?(chart|graph|data|report|above)/i.test(cleanUserMsg) ||
            /give me charts? for this/i.test(cleanUserMsg) ||
            (cleanUserMsg.split(/\s+/).length <= 8 && /chart|graph|that|this|it|mean|show|say/i.test(cleanUserMsg));

        if (window.pendingDatabaseData) {
            const dbInfo = window.pendingDatabaseData || {};
            const rows = Array.isArray(dbInfo.data) ? dbInfo.data : [];
            enhancedDatasetContext = {
                source: "database",
                name: dbInfo.name,
                recordCount: rows.length,
                dataSummary: "Full data provided"
            };
            actualDataRows = rows;
        }

        if (isDbIntent && (!Array.isArray(actualDataRows) || actualDataRows.length === 0)) {
            const fallbackRows =
                (Array.isArray(window.CURRENTADSDATA) && window.CURRENTADSDATA.length ? window.CURRENTADSDATA : null) ||
                (Array.isArray(window.CURRENT_ADS_DATA) && window.CURRENT_ADS_DATA.length ? window.CURRENT_ADS_DATA : null);

            if (fallbackRows) actualDataRows = fallbackRows;
        }

        const isAggregateQuery =
            /\b(how many|count|total|sum|average|avg|max|min|minimum|maximum|breakdown|distribution|percentage|ratio|all\s+row|entire|every\s+row)\b/i.test(cleanUserMsg);

        if (!isInitialAnalysis && !isConversationalFollowUp && !isAggregateQuery && window.VectorStore && window.VectorStore.length > 0 && lastUserMessage) {
            try {
                console.log("Performing Vector Search for targeted query:", lastUserMessage);
                const relevantRows = await searchVectorDB(lastUserMessage, 40);

                if (relevantRows && relevantRows.length > 0) {
                    const fullTokens = Math.round(JSON.stringify(actualDataRows || []).length / 4);
                    const filteredTokens = Math.round(JSON.stringify(relevantRows).length / 4);
                    const savedThisQuery = Math.max(0, fullTokens - filteredTokens);

                    const stats = JSON.parse(
                        localStorage.getItem("axi_vector_token_stats") ||
                        '{"queriesFiltered":0,"totalSaved":0,"totalFull":0,"totalFiltered":0}'
                    );

                    stats.queriesFiltered++;
                    stats.totalSaved += savedThisQuery;
                    stats.totalFull += fullTokens;
                    stats.totalFiltered += filteredTokens;
                    stats.lastQuery = {
                        fullRows: (actualDataRows || []).length,
                        filteredRows: relevantRows.length,
                        fullTokens,
                        filteredTokens,
                        savedThisQuery
                    };

                    localStorage.setItem("axi_vector_token_stats", JSON.stringify(stats));

                    console.log(
                        `[VectorDB] Filtered ${(actualDataRows || []).length} → ${relevantRows.length} rows | ` +
                        `~${savedThisQuery.toLocaleString()} tokens saved this query | ` +
                        `~${stats.totalSaved.toLocaleString()} saved total`
                    );

                    actualDataRows = relevantRows;
                    isRagFiltered = true;
                }
            } catch (err) {
                console.error("Vector search failed, falling back:", err);
            }
        } else if (isInitialAnalysis) {
            console.log("Overview intent detected. Skipping Vector DB.");
        } else if (isConversationalFollowUp) {
            console.log("Conversational follow-up detected. Skipping Vector DB to use chat history.");
        }

        async function callLLM(finalMessagesArray) {
            console.log(
                "[AXI-DBG] callLLM called. streamCallbacks:",
                !!streamCallbacks,
                "| onChunk:",
                typeof streamCallbacks?.onChunk,
                "| messages:",
                finalMessagesArray?.length
            );

            if (typeof streamCallbacks?.onChunk === "function") {
                console.log("[AXI-DBG] Taking STREAMING path via axiChatCompletionStream");

                return await axiChatCompletionStream({
                    messages: finalMessagesArray,
                    temperature: 0.3,
                    maxtokens: 4000,
                    model: undefined,
                    onChunk: (chunk, fullText) => streamCallbacks.onChunk(chunk, fullText),
                    onThinking:
                        typeof streamCallbacks?.onThinking === "function"
                            ? streamCallbacks.onThinking
                            : undefined
                });
            }

            console.warn("[AXI-DBG] Taking NON-STREAMING path");

            return await axiChatCompletion({
                messages: finalMessagesArray,
                temperature: 0.3,
                maxtokens: 4000,
                model: undefined
            });
        }

        const BASE_SYSTEM_PROMPT = `
You are AXI, an expert Data Analyst.
Answer the user's questions intelligently based on the provided data and conversation history.

### CHART PROTOCOL — MANDATORY
When any chart, graph, or visualization is needed or requested, you MUST output it as a JSON code block ONLY.
NEVER use ASCII art, text bars (████), unicode characters, or plain-text tables to represent charts.
NEVER draw charts in text. ONLY use the JSON format below — the UI will render it as a real interactive chart.

Single chart:
\`\`\`json
{
  "chart": {
    "type": "column",
    "title": "Title Here",
    "xAxis": { "categories": ["A", "B", "C"] },
    "series": [{ "name": "Series Name", "data": [10, 20, 30] }]
  }
}
\`\`\`

Multiple charts:
\`\`\`json
{
  "charts": [
    {
      "chart": {
        "type": "bar",
        "title": "Chart One",
        "xAxis": { "categories": ["X", "Y"] },
        "series": [{ "name": "Val", "data": [5, 15] }]
      }
    },
    {
      "chart": {
        "type": "pie",
        "title": "Chart Two",
        "series": [{ "name": "Share", "data": [{ "name": "A", "y": 60 }, { "name": "B", "y": 40 }] }]
      }
    }
  ]
}
\`\`\`

Supported chart types: column, bar, line, pie, area, scatter.
For pie charts always use: "data": [{ "name": "Label", "y": value }, ...]

### OUTPUT FORMAT — MANDATORY
NEVER output raw HTML tags (<div>, <table>, <span>, <p>, <html>, etc.) in your responses.
Use Markdown for text formatting and the JSON code block format above for all charts.
If you are tempted to write an HTML chart or HTML table, use the JSON chart format instead.
`.trim();

        const STRICT_DATA_RULES = `
IMPORTANT RULES FOR RAW DATA:
- Never make up data.
- If a specific data point or value is missing from the rows provided below, you MUST say "Not available in the provided data."
`.trim();

        const REPORT_PROTOCOL = `
### OUTPUT FORMAT RULES (MANDATORY)

Use the EXACT section headings and structure the user requests.

Rule 1 — MARKDOWN ONLY for all text:
  BAD:  Executive Overview: {"summary":"The dataset shows..."}
  GOOD: ## Executive Overview\nThe dataset shows...
Never wrap prose or bullet points inside JSON objects.

Rule 2 — CHARTS use JSON code blocks only:
\`\`\`json
{"chart":{"type":"column","title":"Title","xAxis":{"categories":["A","B"]},"series":[{"name":"Label","data":[10,20]}]}}
\`\`\`

Rule 3 — NEVER output a bare "Charts: [...]" list, "Report\\nDASHBOARD", or any JSON object as the main response body.
Rule 4 — Do NOT repeat section names or add a "Report" title before your sections.
`.trim();

        if (actualDataRows && actualDataRows.length > 0) {
            const matchedRow = findBestMatchingRow(actualDataRows, lastUserMessage);
            if (matchedRow) {
                const matchMessages = [
                    { role: "system", content: `${BASE_SYSTEM_PROMPT}\n\n${STRICT_DATA_RULES}` },
                    {
                        role: "user",
                        content: `MATCHED RECORD:\n${JSON.stringify(matchedRow)}\n\nQuestion:\n${lastUserMessage}`
                    }
                ];

                const response = await callLLM(matchMessages);
                return typeof response === "object" ? (response.text ?? response) : response;
            }

            if (isRagFiltered) {
                const ragMessages = [
                    { role: "system", content: `${BASE_SYSTEM_PROMPT}\n\n${STRICT_DATA_RULES}` },
                    ...nonSystemMessages.slice(0, -1),
                    {
                        role: "system",
                        content: `Context Update: A Vector Database has retrieved the ${actualDataRows.length} most relevant rows to answer the user's new question.`
                    },
                    {
                        role: "user",
                        content: `FILTERED DATA ROWS:\n${JSON.stringify(actualDataRows)}\n\nQuestion:\n${lastUserMessage}\n\nPlease answer directly based ONLY on the filtered rows above.`
                    }
                ];

                try {
                    const response = await callLLM(ragMessages);
                    return typeof response === "object" ? (response.text ?? response) : response;
                } catch (err) {
                    if (!isContextLimitError(err)) throw err;
                }
            } else if (isInitialAnalysis) {

                const ROW_COUNT = actualDataRows.length;
                const dsName = enhancedDatasetContext?.name || 'dataset';
                const columns = Object.keys(actualDataRows[0] || {}).filter(k => !k.startsWith('__'));

                // Pre-compute aggregates from ALL rows in JS — accurate regardless of what we send to AI
                const profile = buildProfile(actualDataRows);
                const aggregates = buildAggregates(actualDataRows);
                const payload = buildLLMPayload(dsName, actualDataRows, profile, aggregates);

                // DATA GROUND TRUTH — always injected first so the AI is anchored to exact facts
                const groundTruthMsg = {
                    role: "system",
                    content:
                        `DATA GROUND TRUTH — FOLLOW THESE FACTS EXACTLY:\n` +
                        `• This dataset contains EXACTLY ${ROW_COUNT} rows.\n` +
                        `• Columns (${columns.length}): ${columns.join(', ')}\n` +
                        `• Report the row count as ${ROW_COUNT} — never round, estimate, or say "approximately".\n` +
                        `• Every aggregation (sum, count, percentage, average) must cover ALL ${ROW_COUNT} rows.\n` +
                        `• Pre-computed statistics below are derived from all ${ROW_COUNT} rows — treat them as authoritative.\n` +
                        `• If the data does not support a specific claim, say "Not available in the provided data".`
                };

                // COMPREHENSIVE STATS — computed from all rows, sent first so AI always has full picture
                const statsMsg = {
                    role: "system",
                    content:
                        `COMPREHENSIVE STATISTICS FOR "${dsName}" (computed from all ${ROW_COUNT} rows):\n` +
                        JSON.stringify(payload)
                };

                // FULL RAW DATA — chunk all rows as pipe-delimited TOON so AI sees every record
                // Same chunking strategy as Data Bin (12k chars per chunk) — no row is ever left out
                const toonStr = jsonToToon(actualDataRows);
                const toonChunks = splitToonForAi(toonStr, 12000);
                const totalChunks = toonChunks.length;

                const toonMessages = toonChunks.map((chunk, idx) => ({
                    role: "system",
                    content:
                        `RAW DATA "${dsName}" — chunk ${idx + 1}/${totalChunks} ` +
                        `(dataset has ${ROW_COUNT} total rows):\n` +
                        chunk
                }));

                try {
                    const fullMessages = [
                        groundTruthMsg,
                        statsMsg,
                        ...toonMessages,
                        { role: "system", content: `${BASE_SYSTEM_PROMPT}\n\n${STRICT_DATA_RULES}\n\n${REPORT_PROTOCOL}` },
                        {
                            role: "user",
                            content:
                                `Dataset: ${dsName} — ${ROW_COUNT} rows across ${columns.length} columns.\n\n` +
                                `Question:\n${lastUserMessage}\n\n` +
                                `All ${ROW_COUNT} rows have been provided above in chunks. ` +
                                `Follow the output format rules above. Write your response in clean Markdown — do NOT wrap any text section in a JSON object.`
                        }
                    ];

                    const response = await callLLM(fullMessages);
                    return typeof response === "object" ? (response.text ?? response) : response;
                } catch (err) {
                    if (!isContextLimitError(err)) throw err;
                }

                // Context-limit fallback: stats + 50 sample rows (row count still exact)
                try {
                    const attempt2Messages = [
                        groundTruthMsg,
                        { role: "system", content: `${BASE_SYSTEM_PROMPT}\n\n${STRICT_DATA_RULES}\n\n${REPORT_PROTOCOL}` },
                        {
                            role: "user",
                            content:
                                `Dataset: ${dsName} — ${ROW_COUNT} rows\n\n` +
                                `COMPREHENSIVE STATISTICS (computed from all ${ROW_COUNT} rows):\n` +
                                `${JSON.stringify(payload)}\n\n` +
                                `Question:\n${lastUserMessage}\n\n` +
                                `Write your response in clean Markdown — do NOT wrap any text section in a JSON object.`
                        }
                    ];

                    const response = await callLLM(attempt2Messages);
                    return typeof response === "object" ? (response.text ?? response) : response;
                } catch (err) {
                    if (!isContextLimitError(err)) throw err;
                }
            } else {
                try {
                    const profile = buildProfile(actualDataRows);
                    const rawAggregates = buildAggregates(actualDataRows);

                    const smartAggregates = {};
                    Object.keys(rawAggregates).forEach(col => {
                        const aggData = rawAggregates[col];
                        if (!aggData || typeof aggData !== 'object') return;

                        const colSummary = { type: aggData.type };

                        if (aggData.type === "numeric") {
                            colSummary.sum = aggData.sum;
                            colSummary.avg = aggData.avg;
                            colSummary.min = aggData.min;
                            colSummary.max = aggData.max;
                            colSummary.count = aggData.count;
                        }

                        if (aggData.counts) {
                            const uniqueCount = Object.keys(aggData.counts).length;
                            colSummary.uniqueCount = uniqueCount;
                            if (uniqueCount <= 100) {
                                colSummary.counts = aggData.counts;
                            } else {
                                colSummary.highlyUnique = true;
                                colSummary.note = `Too many unique values (${uniqueCount}) to chart individually.`;
                            }
                        }

                        smartAggregates[col] = colSummary;
                    });

                    const microPayload = {
                        totalRecords: actualDataRows.length,
                        schema: profile,
                        aggregates: smartAggregates
                    };

                    // Ground truth anchor for follow-up queries too
                    const followUpGroundTruth = {
                        role: "system",
                        content:
                            `DATA GROUND TRUTH: This dataset has EXACTLY ${actualDataRows.length} rows. ` +
                            `All aggregates in the payload below were computed from all ${actualDataRows.length} rows. ` +
                            `Always cite ${actualDataRows.length} as the row count — never estimate or approximate.`
                    };

                    const isExplainMode =
                        /explain|what does|why (is|are)|interpret|describe|what do (these|the)|what('s| is) (this|that)|break.{0,10}down|mean|tell me more|elaborate/i.test(cleanUserMsg);

                    const FOLLOW_UP_PROMPT = `
You are a helpful Data Analyst having a conversation.
The user is asking a conversational follow-up question.

CRITICAL INSTRUCTIONS:
1. You MUST read the full conversation history carefully.
2. If the user asks you to explain charts — look at the JSON blocks in previous responses and translate those numbers into plain English: highest, lowest, trends, key takeaways.
3. Be specific — use the actual values from those chart JSON blocks.
4. DO NOT say "Not available in the data". You are free to reference anything from chat history.

${isExplainMode ? `
⚠ EXPLAIN MODE — ACTIVE:
- The user wants an EXPLANATION of existing charts/data — NOT new charts.
- DO NOT generate any JSON chart blocks.
- DO NOT output any \`\`\`json ... \`\`\` blocks under any circumstances.
- Respond ONLY in plain markdown (paragraphs, bullet points, bold highlights).
- Reference the actual numbers and labels already shown in the conversation above.
` : `
CHART MODE — Only if a new chart is explicitly requested:
Output it as a JSON code block using this format:
\`\`\`json
{ "chart": { "type": "column", "title": "Title", "xAxis": { "categories": ["A","B"] }, "series": [{ "name": "Label", "data": [10, 20] }] } }
\`\`\`
Supported types: column, bar, line, pie, area, scatter.
`}`.trim();

                    const followUpMessages = [
                        { role: "system", content: FOLLOW_UP_PROMPT },
                        followUpGroundTruth,
                        ...nonSystemMessages.slice(0, -1),
                        {
                            role: "user",
                            content: `DATASET AGGREGATES (For reference if needed):\n${JSON.stringify(microPayload)}\n\nUser Question:\n${lastUserMessage}\n\nPlease respond naturally and explain any past charts using the conversation history.`
                        }
                    ];

                    const response = await callLLM(followUpMessages);
                    return typeof response === "object" ? (response.text ?? response) : response;
                } catch (err) {
                    if (!isContextLimitError(err)) throw err;
                }
            }

            return generateLocalReportMarkdown(enhancedDatasetContext?.name, actualDataRows);
        }

        const uniqueSystemMessages = [];
        const seenSystemTexts = new Set();

        incomingMessages.forEach(m => {
            if (m && m.role === "system") {
                const content = String(m.content).trim();
                if (!content) return;
                if (content.startsWith("DATA CONTEXT:")) return;
                if (content.startsWith("Context Update:")) return;

                if (!seenSystemTexts.has(content)) {
                    seenSystemTexts.add(content);
                    uniqueSystemMessages.push({ role: "system", content });
                }
            }
        });

        const generalMessages = [
            { role: "system", content: "You are AXI, a helpful AI assistant." },
            ...uniqueSystemMessages,
            { role: "system", content: REPORT_PROTOCOL },
            ...nonSystemMessages
        ];

        const response = await callLLM(generalMessages);
        return typeof response === "object" ? (response.text ?? response) : response;
    }
    // ================================================================
    //  FOLLOW-UP QUESTION SUGGESTIONS
    //  Generates 3 contextual follow-up chips after each AI response.
    // ================================================================

    /**
     * Calls the LLM with a lightweight prompt to generate 3 follow-up
     * question suggestions based on the conversation exchange.
     * Returns an array of up to 3 strings, or [] on failure.
     */
    async function generateFollowUpSuggestions(userMsg, aiResponse) {
        try {
            const snippet = (aiResponse || "").slice(0, 1500);

            // Build context hint so the LLM knows what data is actually available
            let contextHint = "No data is currently loaded — the AI is answering from general knowledge only.";
            const binCtx = window.ACTIVEDATABINCONTEXT || window.ACTIVE_DATABIN_CONTEXT;
            const dbRows = window.pendingDatabaseData?.data;

            if (binCtx?.name) {
                const srcNames = (binCtx.datasources || []).map(s => s.name || s.caption).filter(Boolean).join(', ');
                contextHint = `Active Data Bin: "${binCtx.name}".${srcNames ? ` Sources: ${srcNames}.` : ''} The AI has full access to this data and can answer follow-up questions about it.`;
            } else if (dbRows?.length > 0) {
                const cols = Object.keys(dbRows[0] || {}).slice(0, 8).join(', ');
                contextHint = `A dataset with ${dbRows.length} rows is loaded. Columns include: ${cols}. The AI can answer further questions about this data.`;
            }

            const messages = [
                {
                    role: "system",
                    content:
                        "You generate short follow-up question suggestions for a data analysis AI assistant.\n\n" +
                        "STRICT RULES — violations make suggestions useless:\n" +
                        "1. ONLY suggest questions the AI can answer using data already loaded in the conversation. " +
                        "Never suggest uploading files, connecting data sources, or any action that requires external input the AI cannot perform.\n" +
                        "2. Each question must be directly answerable from the AI response or the loaded data context provided below.\n" +
                        "3. Suggest SPECIFIC questions, not vague ones. Prefer questions that ask for a chart, a number, a comparison, or a breakdown.\n" +
                        "4. If the context is payroll/salary data, make suggestions payroll-specific (e.g. deductions, net pay, PF, ESI, monthly trends).\n" +
                        "5. If the context is construction/project data, make suggestions project-specific.\n" +
                        "6. Return ONLY a valid JSON array of exactly 3 strings. No explanation, no markdown fences.\n\n" +
                        `Data context: ${contextHint}`
                },
                {
                    role: "user",
                    content:
                        "User asked: " + (userMsg || "").slice(0, 400) +
                        "\n\nAI responded: " + snippet +
                        "\n\nSuggest 3 follow-up questions that are directly answerable from this data."
                }
            ];

            const raw = await axiChatCompletion({ messages, temperature: 0.4, max_tokens: 200 });
            const text = (typeof raw === "string" ? raw : raw?.text || "").trim();
            const cleaned = text.replace(/^```[\w]*\n?/, "").replace(/```$/, "").trim();
            const parsed = JSON.parse(cleaned);

            if (Array.isArray(parsed)) {
                return parsed.slice(0, 3).map(s => String(s).trim()).filter(Boolean);
            }
        } catch (e) {
            console.warn("[AXI] Follow-up suggestions failed:", e.message);
        }
        return [];
    }

    /**
     * Renders clickable follow-up suggestion chips below a message node.
     * Clicking a chip fills the prompt and sends it automatically.
     *
     * @param {HTMLElement} messageNode  - The .message--assistant root element
     * @param {string[]}    suggestions  - Array of suggestion strings
     */
    function renderFollowUpSuggestions(messageNode, suggestions) {
        if (!messageNode || !suggestions || suggestions.length === 0) return;

        // Remove any previous suggestions on this message (re-render safety)
        const existing = messageNode.querySelector(".axi-suggestions");
        if (existing) existing.remove();

        const wrap = document.createElement("div");
        wrap.className = "axi-suggestions";
        wrap.style.cssText = `
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        padding: 14px 0 6px 0;
        opacity: 0;
        animation: axiFadeUp 0.35s ease forwards;
        animation-delay: 0.15s;
    `;

        suggestions.forEach(text => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "axi-suggestion-chip";
            chip.textContent = text;
            chip.style.cssText = `
            display: inline-flex;
            align-items: center;
            padding: 9px 18px;
            border-radius: 999px;
            border: 1.5px solid #CBD5E1;
            background: #F8FAFC;
            color: #374151;
            font-size: 14px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.15s, border-color 0.15s, color 0.15s, transform 0.12s;
            white-space: normal;
            word-break: break-word;
            max-width: 100%;
            line-height: 1.45;
            text-align: left;
        `;

            chip.addEventListener("click", () => {
                const promptEl = document.getElementById("prompt");
                if (!promptEl) return;

                // Flash the chip to give feedback
                chip.style.background = "#DBEAFE";
                chip.style.borderColor = "#3B82F6";
                setTimeout(() => {
                    promptEl.value = text;
                    promptEl.dispatchEvent(new Event("input", { bubbles: true }));
                    promptEl.focus();
                    if (typeof syncComposerButtons === "function") syncComposerButtons();

                    // Auto-send after a brief moment so the user sees what was typed
                    setTimeout(() => {
                        if (typeof handleSend === "function") handleSend();
                    }, 180);
                }, 120);
            });

            wrap.appendChild(chip);
        });

        // Label above chips
        const label = document.createElement("div");
        label.style.cssText = `
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        color: #94A3B8;
        margin-top: 14px;
        margin-bottom: 2px;
        padding: 0 2px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    `;
        label.textContent = "Suggested follow-ups";

        // Inject the CSS keyframe once
        if (!document.getElementById("axi-suggestions-style")) {
            const style = document.createElement("style");
            style.id = "axi-suggestions-style";
            style.textContent = `
            @keyframes axiFadeUp {
                from { opacity: 0; transform: translateY(6px); }
                to   { opacity: 1; transform: translateY(0); }
            }
            .axi-suggestion-chip:hover {
                background: #EFF6FF !important;
                border-color: #93C5FD !important;
                color: #1D4ED8 !important;
                transform: translateY(-1px);
            }
            .axi-suggestion-chip:active {
                transform: scale(0.97) !important;
            }
        `;
            document.head.appendChild(style);
        }

        const contentEl = messageNode.querySelector('.message__content') || messageNode;
        contentEl.appendChild(label);
        contentEl.appendChild(wrap);
    }

    function uid() { return Math.random().toString(16).slice(2) + Date.now().toString(16); }
    function fmtTime(ts) {
        const d = new Date(ts);
        return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }
    function fmtDate(ts) {
        const d = new Date(ts);
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }

    function setBusy(v) {
        state.busy = v;

        if (v) {
            // Show new animation
            el.typing.classList.remove('typing--hidden');

            // OPTION 1: Gradient Pulse Wave
            el.typing.className = 'typing typing--pulse';
            el.typing.innerHTML = `
            <div class="pulse-bar"></div>
            <div class="pulse-bar"></div>
            <div class="pulse-bar"></div>
            <div class="pulse-bar"></div>
        `;

            /* OPTION 2: Rotating Sparkle Icon (Comment out Option 1 and use this instead)
            el.typing.className = 'typing typing--icon';
            el.typing.innerHTML = `
                <svg class="sparkle-icon" viewBox="0 0 24 24" fill="none">
                    <path d="M12 2L14.09 8.26L20 10L14.09 11.74L12 18L9.91 11.74L4 10L9.91 8.26L12 2Z" 
                          fill="url(#sparkle-gradient)" stroke="none"/>
                    <defs>
                        <linearGradient id="sparkle-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" style="stop-color:#3B82F6;stop-opacity:1" />
                            <stop offset="50%" style="stop-color:#8B5CF6;stop-opacity:1" />
                            <stop offset="100%" style="stop-color:#EC4899;stop-opacity:1" />
                        </linearGradient>
                    </defs>
                </svg>
            `;
            */

        } else {
            // Hide animation
            el.typing.classList.add('typing--hidden');
            el.typing.innerHTML = '';
        }

        syncComposerButtons();
    }

    function syncComposerButtons() {
        const hasText = !!el.prompt.value.trim();
        const hasAny = hasText || state.pendingAttachments.length > 0;
        el.send.disabled = state.busy || !hasAny;
    }

    function isNearBottom(element, threshold = 150) {
        if (!element) return false;
        return (element.scrollHeight - element.scrollTop - element.clientHeight) < threshold;
    }

    // ── Scroll-to-bottom button visibility ───────────────────
    (function initScrollDownBtn() {
        const messages = document.getElementById("messages");
        const btn = document.getElementById("scrollDownBtn");
        if (!messages || !btn) return;

        // Show button when user scrolls up far enough
        messages.addEventListener("scroll", () => {
            const nearBottom = isNearBottom(messages, 200);
            btn.classList.toggle("visible", !nearBottom);
        }, { passive: true });

        // Click scrolls smoothly to bottom and hides button
        btn.addEventListener("click", () => {
            scrollToBottom(true);
            btn.classList.remove("visible");
        });
    })();

    function scrollToBottom(smooth = false) {
        const messages = document.getElementById("messages");
        if (!messages) return;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                // Scroll the #messages container itself (works in and out of iframe)
                messages.scrollTo({ top: messages.scrollHeight, behavior: "instant" });
                // If running inside an iframe, also try to notify the parent frame.
                // Axpert iframes allow postMessage; this is safe and silently ignored
                // by unrelated parents.
                try {
                    if (window.self !== window.top) {
                        window.parent.postMessage({ type: 'axi-scroll-bottom' }, '*');
                    }
                } catch (_) { }
            });
        });
    }

    // AFTER (fixed)
    function enableAutoScroll() {
        const messages = document.getElementById("messages");
        if (!messages) return;
        let _raf = null;
        const observer = new MutationObserver(() => {
            if (!isNearBottom(messages, 200)) return;
            if (_raf) cancelAnimationFrame(_raf);
            _raf = requestAnimationFrame(() => {
                messages.scrollTop = messages.scrollHeight;
            });
        });
        observer.observe(messages, { childList: true, subtree: true, characterData: true });
    }
    // Run immediately (iframe DOMContentLoaded fires after parent load)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', enableAutoScroll);
    } else {
        enableAutoScroll();
    }

    window.addEventListener("load", enableAutoScroll);

    // ── Link-click interceptor ─────────────────────────────────────────────────
    // AI responses can contain mailto: or https: links rendered as <a> tags.
    // Inside an Axpert iframe, any link that triggers a frame navigation causes
    // the parent to show "This content is blocked" and leaves the whole chat
    // unresponsive until the page is refreshed.
    // Fix: capture every click on an <a> tag inside the messages container,
    // prevent the default navigation, and open the URL safely in a new tab
    // (or the system mail client for mailto:).
    (function _installLinkGuard() {
        function handleLinkClick(e) {
            var anchor = e.target.closest('a[href]');
            if (!anchor) return;

            var href = (anchor.getAttribute('href') || '').trim();
            if (!href || href === '#') return;

            // Always prevent frame navigation
            e.preventDefault();
            e.stopPropagation();

            if (href.startsWith('mailto:')) {
                // Open mail client without navigating the frame
                try { window.open(href, '_blank'); } catch (_) { }
            } else if (/^https?:\/\//i.test(href)) {
                window.open(href, '_blank', 'noopener,noreferrer');
            }
            // All other protocols (javascript:, ftp:, etc.) are silently swallowed
        }

        function attachGuard() {
            // Attach to the messages container if available, otherwise fall back
            // to the document so it works regardless of chat structure.
            var container = document.getElementById('messages') || document;
            container.addEventListener('click', handleLinkClick, true); // capture phase
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', attachGuard);
        } else {
            attachGuard();
        }
    })();

    /* ================================================================
       AXPERT — marked.js Configuration + AI Response Enhancers
       Polished syntax highlighting, callout boxes, smart rendering
    ================================================================ */

    /* ── Configure marked.js with highlight.js integration ─────────── */
    (function axiConfigureMarked() {
        if (typeof marked === 'undefined') { return; }

        var renderer = new marked.Renderer();

        /* Code blocks — syntax highlighted */
        renderer.code = function (token) {
            var text = token.text || token;
            var lang = token.lang || '';
            if (typeof text !== 'string') text = String(text || '');
            var highlighted = text;
            var usedLang = '';
            if (typeof hljs !== 'undefined') {
                try {
                    if (lang && hljs.getLanguage(lang)) {
                        highlighted = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
                        usedLang = lang;
                    } else {
                        var auto = hljs.highlightAuto(text);
                        highlighted = auto.value;
                        usedLang = auto.language || lang || 'code';
                    }
                } catch (e) { highlighted = axiEscHtml(text); }
            } else {
                highlighted = axiEscHtml(text);
                usedLang = lang || 'code';
            }
            return '<div class="codeCard">' +
                '<div class="codeCard__header">' +
                '<span class="codeCard__lang">' + axiEscHtml((usedLang || 'code').toUpperCase()) + '</span>' +
                '<button class="codeCard__copy" onclick="axiCopyCode(this)" type="button" title="Copy">' +
                '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
                '<span>Copy</span>' +
                '</button>' +
                '</div>' +
                '<pre class="codeCard__pre"><code class="hljs' + (usedLang ? ' language-' + usedLang : '') + '">' + highlighted + '</code></pre>' +
                '</div>';
        };

        /* Blockquotes — detect callout prefixes */
        renderer.blockquote = function (token) {
            var rawText = '';
            if (token && token.text) { rawText = token.text; }
            else if (token && token.tokens) {
                rawText = token.tokens.map(function (t) { return t.raw || t.text || ''; }).join('');
            } else if (typeof token === 'string') { rawText = token; }
            var lower = rawText.trim().toLowerCase();
            var callouts = [
                { key: 'note:', cls: 'callout-note', icon: 'ℹ️', label: 'Note' },
                { key: 'tip:', cls: 'callout-tip', icon: '💡', label: 'Tip' },
                { key: 'warning:', cls: 'callout-warning', icon: '⚠️', label: 'Warning' },
                { key: 'caution:', cls: 'callout-warning', icon: '⚠️', label: 'Caution' },
                { key: 'important:', cls: 'callout-important', icon: '🔴', label: 'Important' },
                { key: 'insight:', cls: 'callout-insight', icon: '✨', label: 'Key Insight' },
            ];
            for (var i = 0; i < callouts.length; i++) {
                var c = callouts[i];
                if (lower.startsWith(c.key)) {
                    var body = axiEscHtml(rawText.trim().slice(c.key.length).trim());
                    return '<div class="axi-callout ' + c.cls + '">' +
                        '<span class="axi-callout-icon">' + c.icon + '</span>' +
                        '<div class="axi-callout-body">' +
                        '<div class="axi-callout-title">' + c.label + '</div>' +
                        '<div class="axi-callout-text">' + body + '</div>' +
                        '</div></div>';
                }
            }
            /* Default blockquote */
            var inner = marked.parseInline ? marked.parseInline(rawText) : axiEscHtml(rawText);
            return '<blockquote><p>' + inner + '</p></blockquote>';
        };

        marked.use({
            renderer: renderer,
            gfm: true,
            breaks: true
        });

        console.log('[AXI] marked.js v2 config: hljs + callouts + gfm active');
    })();

    /* ── Helper: HTML escape ────────────────────────────────────────── */
    function axiEscHtml(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /* ── Global copy-code handler ────────────────────────────────────── */
    window.axiCopyCode = function (btn) {
        var codeEl = btn && btn.closest && btn.closest('.codeCard') && btn.closest('.codeCard').querySelector('code');
        var text = codeEl ? (codeEl.innerText || codeEl.textContent || '') : '';
        if (!text) return;
        var orig = btn.innerHTML;
        var done = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#22C55E" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg><span>Copied!</span>';
        function onDone() { btn.innerHTML = done; btn.style.color = '#22C55E'; setTimeout(function () { btn.innerHTML = orig; btn.style.color = ''; }, 1800); }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(onDone).catch(function () { axiCopyFallback(text); onDone(); });
        } else { axiCopyFallback(text); onDone(); }
    };
    function axiCopyFallback(text) {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    }

    /* ── Post-process callout patterns inside rendered bubbles ─────── */
    window.axiEnhanceCallouts = function (el) {
        if (!el) return;
        var map = [
            { prefix: /^note:\s*/i, cls: 'callout-note', icon: 'ℹ️', label: 'Note' },
            { prefix: /^tip:\s*/i, cls: 'callout-tip', icon: '💡', label: 'Tip' },
            { prefix: /^warning:\s*/i, cls: 'callout-warning', icon: '⚠️', label: 'Warning' },
            { prefix: /^caution:\s*/i, cls: 'callout-warning', icon: '⚠️', label: 'Caution' },
            { prefix: /^important:\s*/i, cls: 'callout-important', icon: '🔴', label: 'Important' },
            { prefix: /^key insight:\s*/i, cls: 'callout-insight', icon: '✨', label: 'Key Insight' },
            { prefix: /^insight:\s*/i, cls: 'callout-insight', icon: '✨', label: 'Key Insight' },
        ];
        el.querySelectorAll('p').forEach(function (p) {
            var text = (p.textContent || '').trim();
            for (var i = 0; i < map.length; i++) {
                var m = map[i];
                if (m.prefix.test(text)) {
                    var body = text.replace(m.prefix, '').trim();
                    var box = document.createElement('div');
                    box.className = 'axi-callout ' + m.cls;
                    box.innerHTML = '<span class="axi-callout-icon">' + m.icon + '</span><div class="axi-callout-body"><div class="axi-callout-title">' + m.label + '</div><div class="axi-callout-text">' + axiEscHtml(body) + '</div></div>';
                    p.replaceWith(box);
                    break;
                }
            }
        });
    };

    function renderMarkdown(md) { return DOMPurify.sanitize(marked.parse(md || "")); }

    function loadChats() {
        try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
        catch { return []; }
    }
    function saveChats() {
        // Strip large transient fields before persisting — they are re-hydrated from
        // the active Data Bin on each send and must not fill localStorage (5-10 MB cap).
        const _MAX_MSG_CHARS = 20000;
        const slim = state.chats.map(function (c) {
            const s = Object.assign({}, c);
            delete s.fileContext;       // extracted file/bin text — can be MBs
            delete s.datasetRows;       // raw rows array — can be 100k+ entries
            delete s.datasetProfile;    // column stats
            delete s.datasetAggregates; // aggregates
            delete s.dataset;           // wrapper that may embed all of the above
            if (Array.isArray(s.messages)) {
                s.messages = s.messages.map(function (m) {
                    if (m && m.content && m.content.length > _MAX_MSG_CHARS) {
                        return Object.assign({}, m, {
                            content: m.content.slice(0, _MAX_MSG_CHARS) + '\n[…truncated]'
                        });
                    }
                    return m;
                });
            }
            return s;
        });
        try {
            localStorage.setItem(LS_KEY, JSON.stringify(slim));
        } catch (e) {
            if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
                console.warn('[AXI] localStorage quota exceeded — pruning oldest chats');
                const keep = Math.max(1, Math.ceil(slim.length / 2));
                try { localStorage.setItem(LS_KEY, JSON.stringify(slim.slice(slim.length - keep))); }
                catch (_) { /* give up */ }
            }
        }
    }
    function getActiveChat() { return state.chats.find(c => c.id === state.activeChatId) || null; }

    function ensureAtLeastOneChat() {
        if (state.chats.length) return;
        const c = { id: uid(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), messages: [], dataset: null };
        state.chats.unshift(c);
        state.activeChatId = c.id;
        saveChats();
    }

    const HAS_HISTORY_UI = !!(el.historyBtn && el.historyPopover && el.closeHistory && el.chatList);
    /* Popover open/close */
    function openHistory() {
        if (!HAS_HISTORY_UI) return;
        el.historyPopover.classList.add("historyPopover--open");
        el.historyPopover.setAttribute("aria-hidden", "false");
        renderChatList();
    }
    function closeHistory() {
        if (!HAS_HISTORY_UI) return;
        el.historyPopover.classList.remove("historyPopover--open");
        el.historyPopover.setAttribute("aria-hidden", "true");
    }

    /* Hover behavior (desktop) + click toggle */
    let hoverTimer = null;
    el.historyBtn?.addEventListener("mouseenter", () => {

        clearTimeout(hoverTimer);
        openHistory();
    });
    el.historyPopover?.addEventListener("mouseenter", () => {
        clearTimeout(hoverTimer);
    });
    el.historyBtn?.addEventListener("mouseleave", () => {
        hoverTimer = setTimeout(closeHistory, 220);
    });
    el.historyPopover?.addEventListener("mouseleave", () => {
        hoverTimer = setTimeout(closeHistory, 220);
    });
    el.historyBtn?.addEventListener("click", () => {
        const open = el.historyPopover.classList.contains("historyPopover--open");
        open ? closeHistory() : openHistory();
    });
    el.closeHistory?.addEventListener("click", closeHistory);

    /* Sidebar list */
    function renderChatList() {
        el.chatList.innerHTML = "";

        state.chats
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .forEach(chat => {
                const item = document.createElement("div");
                item.className = `chatItem ${chat.id === state.activeChatId ? "chatItem--active" : ""}`;

                const main = document.createElement("div");
                main.className = "chatItem__main";

                const title = document.createElement("div");
                title.className = "chatItem__title";
                title.textContent = chat.title || "New chat";

                const meta = document.createElement("div");
                meta.className = "chatItem__meta";
                meta.textContent = `${fmtDate(chat.updatedAt)} • ${chat.messages.length} msg`;

                main.appendChild(title);
                main.appendChild(meta);

                const del = document.createElement("button");
                del.className = "chatItem__btn";
                del.title = "Delete";
                del.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" class="i">
                <path d="M3 6h18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                <path d="M8 6V4h8v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                <path d="M6 6l1 16h10l1-16" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
            </svg>
            `;

                item.addEventListener("click", () => {
                    setActiveChat(chat.id);
                    closeHistory();
                });
                del.addEventListener("click", (e) => {
                    e.stopPropagation();
                    deleteChat(chat.id);
                });

                item.appendChild(main);
                item.appendChild(del);
                el.chatList.appendChild(item);
            });
    }

    function setActiveChat(chatId) {
        state.activeChatId = chatId;
        saveChats();
        renderChatList();
        renderThread();
    }

    function newChat() {
        const c = { id: uid(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), messages: [], dataset: null };
        state.chats.unshift(c);
        saveChats();
        setActiveChat(c.id);
    }

    function deleteChat(chatId) {
        const idx = state.chats.findIndex(c => c.id === chatId);
        if (idx === -1) return;
        const wasActive = chatId === state.activeChatId;
        state.chats.splice(idx, 1);

        if (!state.chats.length) {
            state.activeChatId = null;
            ensureAtLeastOneChat();
        } else if (wasActive) {
            state.activeChatId = state.chats[0].id;
        }
        saveChats();
        setActiveChat(state.activeChatId);
    }

    /* Thread rendering */
    function ensureThread() {
        el.messages.innerHTML = "";
        const t = document.createElement("div");
        t.className = "thread";
        el.messages.appendChild(t);
        return t;
    }

    /**
     * Detects whether a string is a full HTML document (has <!DOCTYPE or <html>).
     * Used to render dashboards/charts inline instead of dumping raw HTML as text.
     */
    function isFullHtmlDocument(str) {
        const trimmed = (str || "").trimStart();
        return /^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);
    }

    /**
     * Creates an iframe preview card for a full HTML response, with a Download button.
     * Returns an HTML string ready to be injected as a message bubble body.
     */
    function buildHtmlPreviewHTML(htmlContent) {
        const blob = new Blob([htmlContent], { type: "text/html" });
        const blobUrl = URL.createObjectURL(blob);
        const uid = "html_" + Math.random().toString(36).slice(2);

        return `
<div class="htmlPreviewCard" style="
    border: 1px solid #2a2a4a;
    border-radius: 12px;
    overflow: hidden;
    background: #0f0f1a;
">
    <div style="
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: #1a1a2e;
        border-bottom: 1px solid #2a2a4a;
    ">
        <span style="font-size:0.8rem;color:#00d4ff;font-weight:600;letter-spacing:1px;">
            📊 HTML DASHBOARD
        </span>
        <a
            href="${blobUrl}"
            download="dashboard.html"
            style="
                font-size:0.75rem;
                color:#8888aa;
                background:#12122a;
                border:1px solid #2a2a4a;
                border-radius:6px;
                padding:4px 10px;
                text-decoration:none;
                cursor:pointer;
            "
            onmouseover="this.style.color='#00d4ff'"
            onmouseout="this.style.color='#8888aa'"
        >⬇ Download</a>
    </div>
    <iframe
        id="${uid}"
        src="${blobUrl}"
        style="width:100%;height:520px;border:none;display:block;background:#fff;"
        sandbox="allow-scripts allow-same-origin"
    ></iframe>
</div>`.trim();
    }

    function createMessageNode(role, content, isMarkdown, ts) {
        // 1. Determine the modifier class
        var roleClass = (role === 'user') ? 'message--user' : 'message--assistant';

        // 2. Format Timestamp
        var date = new Date(ts || Date.now());
        var timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        // 3. Avatar Logic
        var avatarHTML = '';
        if (role === 'user') {
            // User Avatar — dynamic initials from logged-in username
            var _uRaw = '';
            try {
                var _p = typeof parent !== 'undefined' ? parent : {};
                _uRaw = (_p.mainUserName || (typeof mainUserName !== 'undefined' ? mainUserName : '') || '').trim();
            } catch (_e) { }
            var _parts = _uRaw ? _uRaw.split(/\s+/) : [];
            var _initials = _parts.length >= 2
                ? (_parts[0][0] + _parts[_parts.length - 1][0]).toUpperCase()
                : _parts.length === 1
                    ? _parts[0][0].toUpperCase()
                    : 'U';
            avatarHTML = '<div class="message__avatar axi-user-avatar">' +
                '<span class="axi-user-initials">' + _initials + '</span>' +
                '</div>';
        } else {
            // Assistant Avatar
            avatarHTML = '<div class="message__avatar">' +
                '<img src="../../images/ai-logo.png">' +
                '</div>';
        }

        // 4. Content Processing
        var bodyHTML = content;

        if (String(content).trim() === 'Thinking...') {
            bodyHTML = `<div class="thinking-anim">Thinking<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></div>`;
        } else if (isFullHtmlDocument(content)) {
            bodyHTML = buildHtmlPreviewHTML(content);
        } else if (isMarkdown && typeof marked !== 'undefined') {
            bodyHTML = marked.parse(content);
            if (typeof DOMPurify !== 'undefined') {
                bodyHTML = DOMPurify.sanitize(bodyHTML);
            }
        } else {
            bodyHTML = String(content)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        }


        // 5. Construct the HTML String (Using concatenation, NO backticks)
        var html = '<div class="message ' + roleClass + '">' +
            avatarHTML +
            '<div class="message__content">' +
            '<div class="message__bubble">' +
            bodyHTML +
            '</div>' +
            '<div class="message__meta">' + timeStr + '</div>' +
            '</div>' +
            '</div>';

        return html;
    }

    window.AXI = window.AXI || {};

    window.AXI.attachFileToChat = function (fileObj) {
        if (!fileObj) return;

        state.pendingAttachments = [{
            kind: "file",
            name: fileObj.name,
            fileObj
        }];

        renderAttachmentTray();
        syncComposerButtons();
    };

    /* ==========================================================================
       UPDATED renderThread Function
       (Replace your existing renderThread with this complete block)
       ========================================================================== */

    function renderThread(animateLast = false) {
        const chat = getActiveChat();
        const thread = document.getElementById("messages");
        if (!thread) return;

        thread.innerHTML = "";

        if (!chat || !chat.messages.length) {
            return;
        }

        chat.messages.forEach((m, idx) => {
            // Skip placeholder messages that are still being streamed into the DOM directly
            if (m._streaming) return;

            const isLast = idx === chat.messages.length - 1;
            const shouldAnimate = animateLast && isLast && m.role === 'assistant';
            const initialContent = shouldAnimate ? "" : m.content;

            const result = createMessageNode(m.role, initialContent, !!m.markdown, m.ts);

            let node;
            if (result instanceof Node) {
                node = result;
            } else if (typeof result === 'string') {
                const wrapper = document.createElement('div');
                wrapper.innerHTML = result.trim();
                node = wrapper.firstChild;
            } else {
                return;
            }

            // --- FIX IS HERE: Added .messagebubble ---
            const target = node.querySelector('.messagebubble') ||
                node.querySelector('.message__bubble') ||
                node.querySelector('.bubble') ||
                node;

            target.style.position = 'relative';

            if (m.role === 'user') {
                makeMessageEditable(target, m.content);
            }

            thread.appendChild(node);

            if (shouldAnimate || isLast) {
                animateMessageIn(node);
            }
            if (shouldAnimate) {
                streamTextToElement(target, m.content, 3).then(() => {
                    enhanceCodeBlocks(node); if (typeof axiEnhanceCallouts === "function") axiEnhanceCallouts(node);;
                    if (m.chartSpecs) m.chartSpecs.forEach(spec => renderHighchartInMessage(target, spec));
                    if (m.content.length > 100 && typeof renderReportActions === 'function') {
                        renderReportActions(target, m.content);
                    }
                });
            } else {
                enhanceCodeBlocks(node); if (typeof axiEnhanceCallouts === "function") axiEnhanceCallouts(node);;
                if (m.chartSpecs) m.chartSpecs.forEach(spec => renderHighchartInMessage(target, spec));
                if (m.role === 'assistant' && m.content.length > 100 && typeof renderReportActions === 'function') {
                    renderReportActions(target, m.content);
                }
            }
        });

        scrollToBottom(true);
    }

    // --- FAST TYPEWRITER EFFECT ---
    async function streamTextToElement(element, fullText, speed = 8) {
        if (isFullHtmlDocument(fullText)) {
            element.innerHTML = buildHtmlPreviewHTML(fullText);
            scrollToBottom(false);
            return;
        }

        let finalHTML = fullText;
        if (typeof marked !== "undefined") {
            finalHTML = DOMPurify.sanitize(marked.parse(fullText));
        }

        if (fullText.length > 2000) {
            element.innerHTML = finalHTML;
            enhanceCodeBlocks(element); if (typeof axiEnhanceCallouts === "function") axiEnhanceCallouts(element);;
            scrollToBottom(false);
            return;
        }

        element.innerHTML = "";

        // Cursor effect
        const cursor = document.createElement("span");
        cursor.className = "typing-cursor";
        cursor.textContent = "●";
        cursor.style.color = "#3B82F6";
        cursor.style.animation = "blink 1s infinite";
        element.appendChild(cursor);

        // Track if we should keep scrolling
        let stickToBottom = isNearBottom(el.messages);
        const onScroll = () => { stickToBottom = isNearBottom(el.messages); };
        el.messages?.addEventListener("scroll", onScroll, { passive: true });

        try {
            const chunks = finalHTML.split(/(<[^>]*>)/g); // Split by HTML tags

            for (const chunk of chunks) {
                if (chunk.startsWith("<")) {
                    cursor.insertAdjacentHTML("beforebegin", chunk);
                } else {
                    const words = chunk.split("");
                    for (const char of words) {
                        cursor.insertAdjacentText("beforebegin", char);

                        // CRITICAL FIX: Only scroll if user hasn't scrolled away
                        if (stickToBottom) scrollToBottom(false);

                        await new Promise(r => setTimeout(r, speed));
                    }
                }
            }
        } finally {
            cursor.remove();
            el.messages?.removeEventListener("scroll", onScroll);
        }

        enhanceCodeBlocks(element); if (typeof axiEnhanceCallouts === "function") axiEnhanceCallouts(element);;
    }

    function renderReportActions(container, markdownText) {
        if (!container || !markdownText) return;

        // Store on the element — injectMessageActions reads this when the bar is built
        container._axiMarkdown = markdownText;

        // If the axiext-actions bar already exists in the message content wrapper,
        // inject directly. Otherwise injectMessageActions will pick it up.
        const bar = container.parentElement?.querySelector('.axiext-actions');
        if (bar) _injectReportBtns(bar, container, markdownText);
    }

    function _injectReportBtns(bar, container, markdownText) {
        if (!bar || !markdownText) return;
        // Avoid duplicates
        bar.querySelector('.axi-rpt-sep')?.remove();
        bar.querySelector('.axi-pdf-btn')?.remove();
        bar.querySelector('.axi-rpt-copy-btn')?.remove();

        // Separator
        const sep = document.createElement('div');
        sep.className = 'axi-rpt-sep';
        sep.style.cssText = 'width:1px;height:14px;background:#e5e7eb;margin:0 2px;flex-shrink:0;align-self:center;';
        bar.appendChild(sep);

        // Export PDF button
        const pdfBtn = document.createElement('button');
        pdfBtn.className = 'axiext-action-btn axi-pdf-btn';
        pdfBtn.type = 'button';
        pdfBtn.title = 'Export PDF';
        pdfBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`;
        pdfBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const orig = pdfBtn.innerHTML;
            pdfBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>`;
            try {
                await generatePDFReport(container, markdownText);
                pdfBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="#16A34A" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
                pdfBtn.classList.add('axiext-btn--done');
                setTimeout(() => { pdfBtn.innerHTML = orig; pdfBtn.classList.remove('axiext-btn--done'); }, 2500);
            } catch (err) {
                console.error('[AXI] PDF export failed:', err);
                pdfBtn.innerHTML = orig;
                toast('PDF export failed — please try again.', 'error', 5000);
            }
        });
        bar.appendChild(pdfBtn);

        // Copy markdown button
        const copyMdBtn = document.createElement('button');
        copyMdBtn.className = 'axiext-action-btn axi-rpt-copy-btn';
        copyMdBtn.type = 'button';
        copyMdBtn.title = 'Copy as Markdown';
        copyMdBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>`;
        copyMdBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(markdownText);
            const orig = copyMdBtn.innerHTML;
            copyMdBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="#16A34A" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
            copyMdBtn.classList.add('axiext-btn--done');
            setTimeout(() => { copyMdBtn.innerHTML = orig; copyMdBtn.classList.remove('axiext-btn--done'); }, 2000);
        });
        bar.appendChild(copyMdBtn);

        // Smart List button — also injected here so report responses (which fill in
        // after the bar is first built) don't miss it. Duplicate guard prevents double-add.
        if (!bar.querySelector('.axi-smartlist-btn') &&
            typeof axiHasTabularContent === 'function' && typeof axiShowInSmartList === 'function') {
            var _slSep = document.createElement('div');
            _slSep.className = 'axi-rpt-sep';
            _slSep.style.cssText = 'width:1px;height:14px;background:#e5e7eb;margin:0 2px;flex-shrink:0;align-self:center;';
            bar.appendChild(_slSep);
            var _slBtn = document.createElement('button');
            _slBtn.className = 'axiext-action-btn axi-smartlist-btn';
            _slBtn.type = 'button';
            _slBtn.title = 'Show in Smart List';
            _slBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="9" x2="9" y2="21"/></svg>';
            _slBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                var text = markdownText || container.innerText || '';
                if (text) axiShowInSmartList(text, _slBtn);
            });
            bar.appendChild(_slBtn);
        }
        if (!document.getElementById('spin-anim')) {
            const s = document.createElement('style');
            s.id = 'spin-anim';
            s.textContent = '@keyframes spin{100%{transform:rotate(360deg)}}';
            document.head.appendChild(s);
        }
    }

    // ── AXI SMART LIST INTEGRATION ───────────────────────────────────────────────
    // Converts an AI response containing a table or list into the JSON format that
    // the Axpert SmartViewTableController accepts, then mounts the Smart List UI
    // in a full-screen panel. Mirrors the MRP-Wizard embed approach exactly.
    // ─────────────────────────────────────────────────────────────────────────────

    // 1. Detect whether a rendered bubble element has tabular content
    function axiHasTabularContent(bubbleEl) {
        if (!bubbleEl) return false;
        if (bubbleEl.querySelector('table')) return true;
        var liCount = bubbleEl.querySelectorAll('li').length;
        return liCount >= 3;
    }

    // 2. Dynamically load smartview.js — tries relative paths then the Axi CDN
    function axiLoadSmartviewScript() {
        // smartview.js is loaded inside the sandbox iframe, not the parent window.
        // Kept for compatibility — always resolves immediately.
        return Promise.resolve(true);
    }

    // 3. Call the Anthropic API to convert raw text → a JSON array of flat row objects
    // AFTER
    async function axiConvertResponseToSmartListData(text) {
        var MAX_CHARS = 12000;
        var safeText = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
        if (text.length > MAX_CHARS && typeof toast === 'function') {
            toast('Large response — converting first portion to Smart List.', 'info', 3000);
        }

        var prompt = 'Convert the following text into a JSON array of flat objects — one object per data row, with consistent keys derived from the column headers or context. Respond ONLY with the raw JSON array, no markdown fences, no explanation, no extra text.\n\nText:\n' + safeText;

        // Use the same axiChatCompletion that the rest of AXI uses —
        // it already handles OpenAI / Gemini / OpenRouter routing correctly.
        var raw = await axiChatCompletion({
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            max_tokens: 4000
        });

        raw = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
        return JSON.parse(raw);
    }
    // 4. Infer SmartView column metadata from the keys found in the rows
    function axiInferSmartListMeta(rows) {
        if (!rows || !rows.length) return [];
        return Object.keys(rows[0]).map(function (key) {
            var lower = key.toLowerCase();
            var isNum = ['qty', 'rate', 'amount', 'price', 'total', 'gross', 'net', 'tax',
                'discount', 'count', 'value', 'cost', 'salary', 'budget', 'units',
                'percent', 'percentage'].some(function (w) { return lower.indexOf(w) >= 0; });
            var isDate = lower.indexOf('date') >= 0 || lower.indexOf('time') >= 0 ||
                lower.endsWith('_on') || lower.endsWith('_at');
            var label = key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
                .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
            return {
                fldname: key,
                fldcap: label,
                fldcaption: label,
                fdatatype: isDate ? 'd' : isNum ? 'n' : 'c',
                cdatatype: isDate ? 'Date' : isNum ? 'Numeric' : 'Text',
                filters: 'T',
                listingfld: 'T'
            };
        });
    }

    // 5. Hijack GetDataFromAxList with our in-memory bridge, then boot SmartViewTableController
    function axiMountSmartList(adsName, rows, meta) {
        var embeddedData = { adsName: adsName, rows: rows, meta: meta };
        window._axiSmartListData = embeddedData;

        window._axiSmartListOriginalGDAL =
            (typeof window.GetDataFromAxList === 'function') ? window.GetDataFromAxList : null;
        window._axiSmartListOriginalParentGDAL = null;
        try {
            if (typeof parent !== 'undefined' && parent !== window &&
                typeof parent.GetDataFromAxList === 'function') {
                window._axiSmartListOriginalParentGDAL = parent.GetDataFromAxList;
            }
        } catch (e) { }

        function bridge(params, successCb, errorCb) {
            try {
                var ads = ((params && Array.isArray(params.adsNames) && params.adsNames[0])
                    ? String(params.adsNames[0]) : '').trim().toLowerCase();
                var embeddedAdsLower = String(embeddedData.adsName || '').toLowerCase();
                var props = (params && params.props && typeof params.props === 'object') ? params.props : {};
                if (ads === 'ds_smartlist_ads_metadata') {
                    if (typeof successCb === 'function') successCb({
                        result: {
                            message: 'success', ADSNames: 'ds_smartlist_ads_metadata',
                            data: [{ adsname: embeddedData.adsName, data: embeddedData.meta }]
                        }
                    });
                    return;
                }
                if (ads === 'ds_smartlist_filters') {
                    if (typeof successCb === 'function') successCb({
                        result: {
                            message: 'success', ADSNames: 'ds_smartlist_filters',
                            data: [{ adsname: 'ds_smartlist_filters', data: [], totalrecords: 0, recordcount: 0 }]
                        }
                    });
                    return;
                }
                if (ads === embeddedAdsLower) {
                    var allRows = Array.isArray(embeddedData.rows) ? embeddedData.rows : [];
                    var pageNo = Math.max(1, Number((props && props.pageno) || 1) || 1);
                    var pageSize = Math.max(0, Number((props && props.pagesize) || 0) || 0);
                    var pageRows = pageSize > 0
                        ? allRows.slice((pageNo - 1) * pageSize, (pageNo - 1) * pageSize + pageSize)
                        : allRows;
                    if (typeof successCb === 'function') successCb({
                        result: {
                            message: 'success', ADSNames: embeddedData.adsName,
                            data: [{
                                adsname: embeddedData.adsName,
                                data: pageRows.map(function (r) { return Object.assign({}, r); }),
                                totalrecords: allRows.length, recordcount: allRows.length
                            }]
                        }
                    });
                    return;
                }
                if (typeof successCb === 'function') successCb({
                    result: {
                        message: 'success', ADSNames: ads, data: [{ adsname: ads, data: [] }]
                    }
                });
            } catch (e) {
                if (typeof errorCb === 'function') errorCb(e);
            }
        }

        window.GetDataFromAxList = bridge;
        try { if (typeof parent !== 'undefined' && parent !== window) parent.GetDataFromAxList = bridge; } catch (e) { }

        window._smartviewSkipAutoBoot = true;
        window._smartviewDisableKpiCharts = true;
        window._smartviewEmbeddedMode = true;
        window._entity = window._entity || {};
        window._entity.metaData = meta.slice();
        window._entity.listJson = [];
        window._entity.adsName = adsName;
        window._entity.entityTransId = adsName;

        // SmartViewTableController is booted inside the sandbox iframe — not here.
    }

    // 6. Restore originals and tear everything down
    function axiDestroySmartList() {
        if (window._axiSmartListOriginalGDAL !== undefined) {
            window.GetDataFromAxList = window._axiSmartListOriginalGDAL;
        } else {
            try { delete window.GetDataFromAxList; } catch (e) { }
        }
        try {
            if (typeof parent !== 'undefined' && parent !== window) {
                if (window._axiSmartListOriginalParentGDAL != null) {
                    parent.GetDataFromAxList = window._axiSmartListOriginalParentGDAL;
                } else {
                    try { delete parent.GetDataFromAxList; } catch (e) { }
                }
            }
        } catch (e) { }
        // Tear down the iframe cleanly
        var frame = document.getElementById('axiSmartListFrame');
        if (frame) {
            try { frame.contentWindow.smartTableController = null; } catch (e) { }
            frame.src = 'about:blank';
            frame.remove();
        }
        window._axiSmartListOriginalGDAL = undefined;
        window._axiSmartListOriginalParentGDAL = undefined;
        window._axiSmartListData = null;
        window._smartviewEmbeddedData = null;
    }

    // 7. Orchestrator — called when the user clicks "Show in Smart List"
    async function axiShowInSmartList(sourceText, btnEl) {
        var origHTML = btnEl.innerHTML;
        btnEl.disabled = true;
        btnEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>';
        try {
            var rows = await axiConvertResponseToSmartListData(sourceText);
            if (!rows || !rows.length) throw new Error('No rows could be parsed from this response.');
            var meta = axiInferSmartListMeta(rows);
            var adsName = 'axi_smart_list';

            var panel = document.getElementById('axiSmartListPanel');
            var panelContainer = document.getElementById('axiSmartListContainer');
            if (!panel || !panelContainer) throw new Error('Smart List panel missing from DOM.');

            // Set up parent-side data + GetDataFromAxList bridge
            axiDestroySmartList();
            axiMountSmartList(adsName, rows, meta);

            // Build the iframe srcdoc. The <base href> makes relative script src
            // resolve against the Axpert server, so smartview.js loads correctly.
            // jQuery is proxied from parent so it operates on the IFRAME's document.
            var baseHref = window.location.href.split('?')[0];
            var svSrc = '../../AxpertPlugins/Axi/HTMLPages/js/smartview.js?v=1';

            var srcdoc = [
                '<!DOCTYPE html><html><head>',
                '<meta charset="utf-8">',
                '<base href="', baseHref, '">',
                '<style>',
                'html,body{margin:0;padding:0;width:100%;height:100%;overflow:auto;}',
                '#axi_smart_list{width:100%;}',
                '</style>',
                '</head><body>',
                '<div id="axi_smart_list"></div>',
                '<script>',
                // Proxy parent jQuery to operate on THIS iframe document
                '(function(){',
                '  var pJQ = parent.jQuery || parent.$;',
                '  if (!pJQ) { console.error("[AXI SmartList iframe] parent jQuery not found"); return; }',
                '  var doc = document;',
                '  window.$ = window.jQuery = function(s, c) {',
                '    return new pJQ.fn.init(s, c !== undefined ? c : doc);',
                '  };',
                '  window.$.fn = window.$.prototype = pJQ.fn;',
                '  pJQ.extend(window.$, pJQ);',
                '})();',
                // Bridge: delegate GetDataFromAxList to parent window bridge
                'window.GetDataFromAxList = function(p, s, e) {',
                '  try { parent.window.GetDataFromAxList(p, s, e); }',
                '  catch (ex) { if (typeof e === "function") e(ex); }',
                '};',
                // Entity globals that smartview.js reads
                '(function(){',
                '  var _d = parent._axiSmartListData || {};',
                '  window._entity = {',
                '    metaData:      (_d.meta  || []).slice(),',
                '    listJson:      [],',
                '    adsName:       _d.adsName,',
                '    entityTransId: _d.adsName',
                '  };',
                '  window._smartviewSkipAutoBoot     = true;',
                '  window._smartviewDisableKpiCharts = true;',
                '  window._smartviewEmbeddedMode     = true;',
                '})();',
                '<\/script>',
                // Load smartview.js — resolves relative to <base href> (Axpert server)
                '<script src="', svSrc, '"><\/script>',
                '<script>',
                // Boot SmartViewTableController after all scripts have loaded
                'window.addEventListener("load", function () {',
                '  var _d2 = parent._axiSmartListData || {};',
                '  if (typeof SmartViewTableController !== "function") {',
                '    console.error("[AXI SmartList iframe] SmartViewTableController not found");',
                '    return;',
                '  }',
                '  window.smartTableController = new SmartViewTableController({',
                '    adsName: _d2.adsName, pageSize: 100, currentPage: 1, sorting: []',
                '  });',
                '});',
                '<\/script>',
                '</body></html>'
            ].join('');

            panelContainer.innerHTML = '';
            var iframe = document.createElement('iframe');
            iframe.id = 'axiSmartListFrame';
            iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;display:block;';
            iframe.setAttribute('srcdoc', srcdoc);
            panelContainer.appendChild(iframe);

            // Make sure panelContainer can anchor the absolutely-positioned iframe
            if (panelContainer.style.position !== 'relative' &&
                getComputedStyle(panelContainer).position === 'static') {
                panelContainer.style.position = 'relative';
            }
            panel.style.display = 'flex';

            btnEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#16A34A" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
            btnEl.classList.add('axiext-btn--done');
            setTimeout(function () {
                btnEl.innerHTML = origHTML; btnEl.classList.remove('axiext-btn--done'); btnEl.disabled = false;
            }, 3000);

        } catch (err) {
            console.error('[AXI Smart List]', err);
            if (typeof toast === 'function') toast('Could not build Smart List: ' + (err.message || 'unknown error'), 'error', 5000);
            btnEl.innerHTML = origHTML; btnEl.disabled = false;
        }
    }

    // Expose on window so inline onclick attributes in the panel HTML can reach them
    window.axiShowInSmartList = axiShowInSmartList;
    window.axiDestroySmartList = axiDestroySmartList;
    window.axiMountSmartList = axiMountSmartList;
    // ── END AXI SMART LIST INTEGRATION ───────────────────────────────────────────



    // Add CSS animation for spinner
    const style = document.createElement('style');
    style.textContent = `
@keyframes spin { 
    from { transform: rotate(0deg); } 
    to { transform: rotate(360deg); } 
}
`;
    document.head.appendChild(style);

    async function generatePDFReport(container, markdownText) {
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF('p', 'pt', 'a4');

        const PW = pdf.internal.pageSize.getWidth();    // 595.28 pt
        const PH = pdf.internal.pageSize.getHeight();   // 841.89 pt
        const ML = 48, MR = 48;
        const CW = PW - ML - MR;                        // ~499 pt content width
        const FOOTER_H = 28;                             // footer bar height
        const SAFE_BOTTOM = PH - FOOTER_H - 10;         // last Y before footer

        // ── Colour palette ────────────────────────────────────────
        const ORANGE = [249, 115, 22];
        const ORANGE_D = [180, 55, 6];
        const BLACK = [15, 15, 15];
        const BODY = [50, 50, 50];
        const SUB = [120, 120, 120];
        const DIVIDER = [220, 220, 220];
        const WHITE = [255, 255, 255];
        const TBL_HDR = [25, 25, 25];
        const TBL_ALT = [253, 246, 237];

        // ── Text sanitiser ────────────────────────────────────────
        // Strips emoji, non-Latin chars jsPDF can't render, backtick
        // spans, and converts ₹ → Rs. since Helvetica lacks that glyph.
        function sanitise(t) {
            return (t || '')
                .replace(/`([^`]*)`/g, '$1')               // `code` → plain
                .replace(/\*\*/g, '')                       // strip bold markers
                .replace(/[₹\u20B9]/g, 'Rs.')              // rupee sign → Rs.
                .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')    // emoji block 1
                .replace(/[\u{2600}-\u{27BF}]/gu, '')      // emoji block 2
                .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u024F]/g, '') // non-Latin
                .replace(/\s+/g, ' ')
                .trim();
        }

        // ── Logo loader ───────────────────────────────────────────
        let logoB64 = null;
        try {
            const resp = await _axiFetch(AI_LOGO_SRC);
            const blob = await resp.blob();
            logoB64 = await new Promise(res => {
                const fr = new FileReader();
                fr.onloadend = () => res(fr.result);
                fr.readAsDataURL(blob);
            });
            // Only keep a real image data URL — an empty one makes jsPDF attempt
            // a data: network load that CSP blocks.
            if (!/^data:image\//.test(logoB64 || '')) logoB64 = null;
        } catch (e) { logoB64 = null; console.warn('[PDF] Logo not loaded:', e.message); }

        // ── yPos (mutable, shared via closure) ───────────────────
        let yPos = 0;

        // ── Watermark: centred ghost logo ────────────────────────
        function drawWatermark() {
            if (!logoB64) return;
            // saveGraphicsState / restoreGraphicsState (PDF q/Q operators) guarantee
            // the pre-watermark opacity is restored. The old setGState({opacity:1})
            // reset silently failed in jsPDF 2.5.x, leaving all body text at 3.2%.
            try {
                pdf.saveGraphicsState();
                pdf.setGState(new pdf.GState({ opacity: 0.032 }));
                const s = 260;
                pdf.addImage(logoB64, 'PNG', (PW - s) / 2, (PH - s) / 2, s, s);
                pdf.restoreGraphicsState();
            } catch (e) {
                try { pdf.restoreGraphicsState(); } catch (_) { /* ignore */ }
            }
        }

        // ── Page header ───────────────────────────────────────────
        function drawHeader(isFirst) {
            const H = isFirst ? 82 : 42;

            // Black background bar
            pdf.setFillColor(...BLACK);
            pdf.rect(0, 0, PW, H, 'F');

            // Orange left accent stripe
            pdf.setFillColor(...ORANGE);
            pdf.rect(0, 0, 5, H, 'F');

            // Orange rule below header
            pdf.setFillColor(...ORANGE);
            pdf.rect(0, H, PW, 2.5, 'F');

            if (isFirst) {
                pdf.setTextColor(...WHITE);
                pdf.setFontSize(20);
                pdf.setFont(undefined, 'bold');
                pdf.text('AXI Analysis Report', ML, 32);

                pdf.setFontSize(8.5);
                pdf.setFont(undefined, 'normal');
                pdf.setTextColor(190, 190, 190);
                const dt = new Date().toLocaleDateString('en-IN',
                    { year: 'numeric', month: 'long', day: 'numeric' });
                pdf.text(`Generated: ${dt}`, ML, 50);
                pdf.text('Powered by AXI  |  Axpert Insights', ML, 65);
            } else {
                pdf.setTextColor(...WHITE);
                pdf.setFontSize(8);
                pdf.setFont(undefined, 'bold');
                pdf.text('AXI ANALYSIS REPORT', ML, 18);
                pdf.setFont(undefined, 'normal');
                pdf.setTextColor(165, 165, 165);
                pdf.text('Axpert Insights', ML, 31);
            }

            // Logo — top-right of every header
            if (logoB64) {
                try {
                    const ls = isFirst ? 50 : 26;
                    const ly = isFirst ? 14 : 8;
                    pdf.addImage(logoB64, 'PNG', PW - MR - ls, ly, ls, ls);
                } catch (e) { }
            }

            yPos = isFirst ? 98 : 56;
        }

        // ── Page footer ───────────────────────────────────────────
        function drawFooter(n, total) {
            const fy = PH - FOOTER_H;
            pdf.setFillColor(...BLACK);
            pdf.rect(0, fy, PW, FOOTER_H, 'F');
            pdf.setFillColor(...ORANGE);
            pdf.rect(0, fy, PW, 2, 'F');

            pdf.setFontSize(7.5);
            pdf.setFont(undefined, 'normal');
            pdf.setTextColor(...WHITE);
            pdf.text(`Page ${n} of ${total}`, ML, fy + 17);

            // Centre orange dot brand mark
            pdf.setFillColor(...ORANGE);
            pdf.circle(PW / 2, fy + 14, 2.5, 'F');

            pdf.setTextColor(175, 175, 175);
            pdf.text('Generated by AXI  |  Axpert Insights', PW - MR, fy + 17, { align: 'right' });
        }

        // ── Space guard — add a fresh page if needed ─────────────
        function ensureSpace(needed) {
            if (yPos + needed > SAFE_BOTTOM) {
                pdf.addPage();
                drawHeader(false);
                drawWatermark();
            }
        }

        // ── Section heading (##) ──────────────────────────────────
        function renderH2(raw) {
            const text = sanitise(raw.replace(/^#+\s*/, ''));
            pdf.setFontSize(12); pdf.setFont(undefined, 'bold');
            const lines = pdf.splitTextToSize(text, CW - 26);
            const blockH = lines.length * 15 + 9;
            ensureSpace(blockH + 12);
            yPos += 10;
            pdf.setFillColor(...ORANGE);
            pdf.rect(ML, yPos - 13, 4, blockH, 'F');
            pdf.setFillColor(255, 240, 224);
            pdf.roundedRect(ML + 8, yPos - 14, CW - 8, blockH + 2, 3, 3, 'F');
            pdf.setFontSize(12); pdf.setFont(undefined, 'bold'); pdf.setTextColor(...ORANGE_D);
            lines.forEach((ln, i) => pdf.text(ln, ML + 17, yPos + 4 + i * 15));
            yPos += blockH;
        }

        // ── Sub-heading (###) ─────────────────────────────────────
        function renderH3(raw) {
            const text = sanitise(raw.replace(/^#+\s*/, ''));
            pdf.setFontSize(10); pdf.setFont(undefined, 'bold');
            const lines = pdf.splitTextToSize(text, CW);
            ensureSpace(lines.length * 13 + 14);
            yPos += 8;
            pdf.setFillColor(...ORANGE);
            pdf.rect(ML, yPos + 3, 22, 1.5, 'F');
            pdf.setFontSize(10); pdf.setFont(undefined, 'bold'); pdf.setTextColor(...BLACK);
            lines.forEach((ln, i) => pdf.text(ln, ML, yPos + i * 13));
            yPos += (lines.length - 1) * 13 + 16;
        }

        // ── Body paragraph ────────────────────────────────────────
        function renderParagraph(raw) {
            const text = sanitise(raw);
            if (!text) return;
            // Set the font BEFORE splitTextToSize so the text wraps at the same
            // 9.5pt metrics it is rendered with. (Otherwise it inherits the
            // previous element's font — e.g. 12pt bold from a heading — and wraps
            // too narrow, leaving the paragraph clumped on the left.)
            pdf.setFontSize(9.5);
            pdf.setFont(undefined, 'normal');
            const wrapped = pdf.splitTextToSize(text, CW);
            ensureSpace(wrapped.length * 14 + 4);
            // Re-assert font + colour AFTER ensureSpace: if it added a page,
            // drawHeader() left the text colour light grey.
            pdf.setFontSize(9.5);
            pdf.setFont(undefined, 'normal');
            pdf.setTextColor(...BODY);
            wrapped.forEach((line, i) => {
                const isLast = i === wrapped.length - 1;
                // All lines except the last are justified; last line stays left-aligned
                // (standard typographic convention — prevents a single word stretching across the page)
                pdf.text(line, ML, yPos + i * 14, isLast ? {} : { maxWidth: CW, align: 'justify' });
            });
            yPos += wrapped.length * 14 + 4;
        }

        // ── Bullet point (level 0 = main, 1 = sub, 2 = sub-sub) ─────
        function renderBullet(raw, level) {
            level = level || 0;
            const text = sanitise(raw.replace(/^[\s\-•*>]+/, ''));
            if (!text) return;
            const indentX = ML + (level * 14);
            const textWidth = CW - 13 - (level * 14);
            const wrapped = pdf.splitTextToSize(text, textWidth);
            ensureSpace(wrapped.length * 14 + 3);
            if (level === 0) {
                pdf.setFillColor(...ORANGE);
                pdf.circle(indentX + 4, yPos - 3.5, 2.8, 'F');
            } else {
                pdf.setFillColor(...SUB);
                pdf.circle(indentX + 4, yPos - 3.5, 1.8, 'F');
            }
            pdf.setFontSize(9.5);
            pdf.setFont(undefined, 'normal');
            pdf.setTextColor(...BODY);
            wrapped.forEach((line, i) => pdf.text(line, indentX + 13, yPos + i * 14));
            yPos += wrapped.length * 14 + 3;
        }

        // ── Horizontal rule ───────────────────────────────────────
        function renderHRule() {
            ensureSpace(16);
            yPos += 4;
            pdf.setDrawColor(...DIVIDER);
            pdf.setLineWidth(0.5);
            pdf.line(ML, yPos, PW - MR, yPos);
            yPos += 12;
        }

        // ── Markdown table ────────────────────────────────────────
        function renderTable(tableLines) {
            // Parse rows, skipping separator lines like |---|---|
            const rows = tableLines
                .filter(l => !/^\|[\s:\-|]+\|$/.test(l.trim()))
                .map(l =>
                    l.trim()
                        .split('|')
                        .filter((_, i, a) => i > 0 && i < a.length - 1)
                        .map(c => sanitise(c))
                )
                .filter(r => r.length > 0);

            if (rows.length === 0) return;

            const header = rows[0];
            const data = rows.slice(1);
            const cols = header.length;
            if (cols === 0) return;

            const colW = CW / cols;
            const rowH = 20;
            const hdrH = 24;
            const totalH = hdrH + data.length * rowH + 12;

            ensureSpace(totalH);
            yPos += 6;

            // ── Header row ────────────────────────────────────────
            pdf.setFillColor(...TBL_HDR);
            pdf.roundedRect(ML, yPos, CW, hdrH, 3, 3, 'F');
            pdf.setFontSize(8.5);
            pdf.setFont(undefined, 'bold');
            pdf.setTextColor(...WHITE);
            header.forEach((h, i) => {
                pdf.text(h, ML + i * colW + 7, yPos + 15, { maxWidth: colW - 12 });
            });

            // Orange accent line below header
            pdf.setFillColor(...ORANGE);
            pdf.rect(ML, yPos + hdrH, CW, 1.5, 'F');
            yPos += hdrH + 1.5;

            // ── Data rows ─────────────────────────────────────────
            data.forEach((row, ri) => {
                pdf.setFillColor(...(ri % 2 === 0 ? WHITE : TBL_ALT));
                pdf.rect(ML, yPos, CW, rowH, 'F');

                pdf.setFontSize(8.5);
                pdf.setFont(undefined, ri === 0 ? 'normal' : 'normal');
                pdf.setTextColor(...BODY);
                row.forEach((cell, ci) => {
                    pdf.text(cell, ML + ci * colW + 7, yPos + 13, { maxWidth: colW - 12 });
                });

                // Row divider
                pdf.setDrawColor(...DIVIDER);
                pdf.setLineWidth(0.3);
                pdf.line(ML, yPos + rowH, ML + CW, yPos + rowH);

                yPos += rowH;
            });

            // Outer border
            pdf.setDrawColor(...DIVIDER);
            pdf.setLineWidth(0.6);
            pdf.roundedRect(ML, yPos - hdrH - 1.5 - data.length * rowH, CW,
                hdrH + 1.5 + data.length * rowH, 3, 3, 'S');

            yPos += 12;
        }

        // ─────────────────────────────────────────────────────────
        // PRE-PROCESS: group table lines into blocks
        // ─────────────────────────────────────────────────────────
        const rawLines = markdownText.split('\n');
        const blocks = [];
        let li = 0;
        while (li < rawLines.length) {
            const l = rawLines[li];
            // ✅ FIX: group fenced code blocks so they don't render as body text
            if (l.trim().startsWith('```')) {
                li++; // skip opening fence
                while (li < rawLines.length && !rawLines[li].trim().startsWith('```')) li++;
                li++; // skip closing fence
                continue; // discard code block entirely — charts handle the visual output
            }
            if (l.trim().startsWith('|')) {
                const tbl = [];
                while (li < rawLines.length && rawLines[li].trim().startsWith('|')) {
                    tbl.push(rawLines[li++]);
                }
                blocks.push({ type: 'table', lines: tbl });
            } else {
                blocks.push({ type: 'line', text: l });
                li++;
            }
        }

        // ─────────────────────────────────────────────────────────
        // PAGE 1 — header + watermark
        // ─────────────────────────────────────────────────────────
        drawHeader(true);
        drawWatermark();

        // ─────────────────────────────────────────────────────────
        // RENDER BLOCKS
        // ─────────────────────────────────────────────────────────
        // Consecutive plain-text lines are buffered and flushed as one
        // paragraph so they reflow to full content width instead of
        // each rendering as a separate short line.
        const paraBuffer = [];
        function flushPara() {
            if (!paraBuffer.length) return;
            renderParagraph(paraBuffer.join(' '));
            paraBuffer.length = 0;
        }

        for (const block of blocks) {

            if (block.type === 'table') {
                flushPara();
                renderTable(block.lines);
                continue;
            }

            const line = block.text;
            const trimmed = line.trim();

            if (line.startsWith('## ') || line.startsWith('# ')) { flushPara(); renderH2(line); }
            else if (line.startsWith('### ')) { flushPara(); renderH3(line); }
            else if (/^---+$/.test(trimmed)) { flushPara(); renderHRule(); }
            else if (/^[-•*] /.test(trimmed)) {
                flushPara();
                const leading = line.match(/^(\s*)/)[1].length;
                renderBullet(line, Math.min(Math.floor(leading / 2), 3));
            }
            else if (/^\d+\. /.test(trimmed)) {
                flushPara();
                const leading = line.match(/^(\s*)/)[1].length;
                renderBullet(line.replace(/^\d+\.\s*/, ''), Math.min(Math.floor(leading / 2), 3));
            }
            else if (trimmed) { paraBuffer.push(trimmed); }
            else { flushPara(); yPos += 6; }
        }
        flushPara();

        // ─────────────────────────────────────────────────────────
        // CHARTS — rendered inline after text.
        // A new page is added only when available vertical space
        // is < 80 pt (too small for any readable chart image).
        // maxH already scales the chart to fit whatever remains.
        // ─────────────────────────────────────────────────────────
        const charts = container.querySelectorAll('.highcharts-container');
        const CHART_TITLE_H = 26; // title bar height + gap below it

        for (let ci = 0; ci < charts.length; ci++) {
            yPos += 14; // breathing gap before chart

            try {
                // ── Capture canvas FIRST so we know the chart height ──────────
                const cnv = await html2canvas(charts[ci], {
                    backgroundColor: '#ffffff',
                    scale: 2,
                    allowTaint: true,
                    useCORS: true,
                    ignoreElements: el =>
                        el.tagName === 'LINK' && el.rel === 'stylesheet' &&
                        el.href && !el.href.startsWith(window.location.origin)
                });

                const imgW = CW;
                const naturalH = (cnv.height * imgW) / cnv.width;

                // ── Page-break decision: title + chart must land on the same page ──
                const spaceNeeded = CHART_TITLE_H + Math.min(naturalH, SAFE_BOTTOM - 56 - 6);
                if (SAFE_BOTTOM - yPos < spaceNeeded) {
                    pdf.addPage();
                    drawHeader(false);
                    drawWatermark();
                    yPos += 6;
                }

                // ── Draw title bar (now guaranteed to be on same page as chart) ──
                const titleY = yPos;
                pdf.setFillColor(255, 240, 224);
                pdf.roundedRect(ML, titleY - 12, CW, 22, 3, 3, 'F');
                pdf.setFillColor(...ORANGE);
                pdf.rect(ML, titleY - 12, 4, 22, 'F');
                pdf.setFontSize(10.5);
                pdf.setFont(undefined, 'bold');
                pdf.setTextColor(...ORANGE_D);
                pdf.text(`Chart ${ci + 1}`, ML + 12, titleY + 5);
                yPos += 20;

                // ── Place chart image ─────────────────────────────────────────
                const maxH = SAFE_BOTTOM - yPos - 6;
                const imgH = Math.min(naturalH, maxH);
                const finalW = imgH < naturalH ? (imgH * imgW) / naturalH : imgW;
                const offsetX = ML + (imgW - finalW) / 2;

                const imgData = cnv.toDataURL('image/png');

                pdf.setFillColor(210, 210, 210);
                pdf.roundedRect(offsetX + 3, yPos + 3, finalW, imgH, 4, 4, 'F');
                pdf.setFillColor(...WHITE);
                pdf.roundedRect(offsetX, yPos, finalW, imgH, 4, 4, 'F');
                pdf.addImage(imgData, 'PNG', offsetX, yPos, finalW, imgH);
                pdf.setDrawColor(...DIVIDER);
                pdf.setLineWidth(0.75);
                pdf.roundedRect(offsetX, yPos, finalW, imgH, 4, 4, 'S');

                yPos += imgH + 10;

            } catch (e) {
                pdf.setFontSize(9);
                pdf.setTextColor(...SUB);
                pdf.text('Chart could not be rendered.', ML, yPos + 24);
                yPos += 40;
            }
        }

        // ─────────────────────────────────────────────────────────
        // FOOTERS — retroactively stamp every page
        // ─────────────────────────────────────────────────────────
        const totalPages = pdf.internal.getNumberOfPages();
        for (let p = 1; p <= totalPages; p++) {
            pdf.setPage(p);
            drawFooter(p, totalPages);
        }

        // ─────────────────────────────────────────────────────────
        // SAVE
        // ─────────────────────────────────────────────────────────
        const stamp = new Date().toISOString().slice(0, 10);
        pdf.save(`AXI_Report_${stamp}.pdf`);
    }


    function renderInsightsInMessage(contentWrap, insights) {
        const card = document.createElement("article");
        card.className = "insightsCard";

        const headline = document.createElement("div");
        headline.className = "insightsCard__headline";
        headline.textContent = insights?.headline || "Dataset insights";

        const summary = document.createElement("div");
        summary.className = "insightsCard__summary";
        summary.textContent = insights?.summary || "";

        const metrics = document.createElement("div");
        metrics.className = "insightsCard__metrics";

        (insights?.key_metrics || []).forEach((m) => {
            const item = document.createElement("div");
            item.className = "insightsCard__metric";

            const label = document.createElement("div");
            label.className = "insightsCard__metricLabel";
            label.textContent = m?.label || "";

            const value = document.createElement("div");
            value.className = "insightsCard__metricValue";
            value.textContent = m?.value || "";

            item.appendChild(label);
            item.appendChild(value);
            metrics.appendChild(item);
        });

        const highlights = document.createElement("ul");
        highlights.className = "insightsCard__list";
        (insights?.highlights || []).forEach((t) => {
            const li = document.createElement("li");
            li.textContent = t;
            highlights.appendChild(li);
        });

        card.appendChild(headline);
        if (insights?.summary) card.appendChild(summary);
        if ((insights?.key_metrics || []).length) card.appendChild(metrics);
        if ((insights?.highlights || []).length) card.appendChild(highlights);

        contentWrap.appendChild(card);
    }

    function pushMessage(role, content, markdown = false, charts = []) {
        const chat = getActiveChat();
        if (!chat) return;

        const m = { id: uid(), role, content, markdown, ts: Date.now(), charts };
        chat.messages.push(m);

        // Update sidebar preview
        if (chat.title === "New chat" && role === "user") {
            chat.title = content.slice(0, 40) + (content.length > 40 ? "..." : "");
        }
        chat.updatedAt = Date.now();
        saveChats();
        renderChatList();

        // Render to DOM
        const result = createMessageNode(role, content, markdown, m.ts);

        // --- FIX START: Convert string to Node ---
        let node;
        if (typeof result === 'string') {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = result.trim();
            node = wrapper.firstChild; // Extracts the actual message element
        } else {
            node = result; // It's already a node
        }
        // --- FIX END ---

        const thread = document.getElementById("messages");
        if (thread && node) {
            // If we have charts, render them inside the bubble
            if (charts && charts.length) {
                const bubble = node.querySelector('.messagebubble') || node;
                charts.forEach(spec => renderHighchartInMessage(bubble, spec));
            }

            thread.appendChild(node);
            animateMessageIn(node);
            scrollToBottom(true);
        }
    }

    function animateMessageIn(node) {
        if (!node) return;
        node.classList.remove('message--enter');
        void node.offsetWidth;
        node.classList.add('message--enter');
    }
    /* Premium chart with distinct colors per category */
    function renderChartInMessage(contentWrap, chartSpec) {
        const card = document.createElement("div");
        card.className = "messageChart";

        const title = document.createElement("div");
        title.className = "messageChart__title";
        title.textContent = chartSpec.title || "Chart";

        const canvas = document.createElement("canvas");
        card.appendChild(title);
        card.appendChild(canvas);
        contentWrap.appendChild(card);

        // Premium matte color palette - distinct per category
        const palette = [
            "#3b82f6", // blue
            "#10b981", // green
            "#f59e0b", // amber
            "#8b5cf6", // purple
            "#ef4444", // red
            "#06b6d4", // cyan
            "#ec4899", // pink
            "#64748b", // slate
            "#14b8a6", // teal
            "#f97316", // orange
            "#a855f7", // violet
            "#84cc16"  // lime
        ];

        const type = (chartSpec.type || "bar").toLowerCase();

        // For doughnut/pie, use different color per segment
        const isDoughnutPie = type === "doughnut" || type === "pie";

        new Chart(canvas, {
            type,
            data: {
                labels: chartSpec.labels || [],
                datasets: (chartSpec.datasets || []).map((dataset, dsIdx) => {
                    const baseColor = palette[dsIdx % palette.length];
                    const perCategoryColors = (dataset.data || []).map((_, i) => palette[i % palette.length]);
                    return {
                        label: dataset.label || `Series ${dsIdx + 1}`,
                        data: dataset.data || [],
                        backgroundColor: perCategoryColors,
                        borderColor: isDoughnutPie ? "#ffffff" : baseColor,
                        borderWidth: isDoughnutPie ? 3 : 0,
                        borderRadius: type === "bar" ? 10 : 0,
                        hoverOffset: isDoughnutPie ? 8 : 0
                    };
                })
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: { left: 6, right: 6, top: 6, bottom: 6 } },
                plugins: {
                    legend: {
                        position: "bottom",
                        labels: {
                            color: "#666666",
                            font: { size: 12, weight: "500" },
                            padding: 12,
                            boxWidth: 12,
                            boxHeight: 12,
                            usePointStyle: true,
                            pointStyle: "circle"
                        }
                    },
                    tooltip: {
                        backgroundColor: "rgba(0,0,0,0.85)",
                        titleColor: "#ffffff",
                        bodyColor: "#ffffff",
                        borderColor: "rgba(255,255,255,0.1)",
                        borderWidth: 1,
                        padding: 12,
                        cornerRadius: 10,
                        displayColors: true,
                        intersect: false,
                        mode: "index"
                    }
                },
                scales: (isDoughnutPie) ? {} : {
                    x: {
                        grid: { display: false },
                        ticks: {
                            color: "#8f8f8f",
                            font: { size: 11 }
                        }
                    },
                    y: {
                        grid: { color: "#ecece6", drawBorder: false },
                        ticks: {
                            color: "#8f8f8f",
                            font: { size: 11 }
                        }
                    }
                }
            }
        });
    }


    /* Dataset parsing + insights in chat */
    function normalizeRow(r) {
        const clean = {};
        let hasData = false;

        for (const [k, v] of Object.entries(r)) {
            const key = (k || "").trim();
            const val = (v ?? "").toString().trim();

            // Ignore internal empty excel columns usually named __EMPTY
            if (!key.startsWith("__EMPTY")) {
                clean[key] = val;
                if (val !== "" && val !== "0") {
                    hasData = true;
                }
            }
        }

        if (clean.noofpile !== undefined) {
            const n = parseInt(clean.noofpile, 10);
            clean.noofpile = Number.isFinite(n) ? n : null;
        }

        // Attach a hidden flag so we can filter out empty rows
        Object.defineProperty(clean, '_hasData', { value: hasData, enumerable: false, writable: true });
        return clean;
    }

    function buildProfile(rows) {
        const columns = rows.length ? Object.keys(rows[0]) : [];
        const blanks = {};
        for (const c of columns) blanks[c] = 0;

        for (const r of rows) {
            for (const c of columns) {
                const v = r[c];
                if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) blanks[c]++;
            }
        }

        const totalCells = rows.length * columns.length || 1;
        const missingCells = Object.values(blanks).reduce((s, v) => s + v, 0);
        const missingRatio = missingCells / totalCells;

        return { rowCount: rows.length, columns, blanks, missingRatio };
    }

    function countBy(rows, field) {
        const out = {};
        for (const r of rows) {
            const key = (r[field] ?? "").toString().trim() || "(blank)";
            out[key] = (out[key] || 0) + 1;
        }
        return out;
    }


    function buildAggregates(rows) {
        if (!rows || !rows.length) return {};
        const aggregates = {};

        // Use up to 500 rows for type detection — accurate for any realistic dataset
        const detectionSample = rows.length > 500 ? rows.slice(0, 500) : rows;
        const keys = Object.keys(detectionSample[0] || {});

        keys.forEach(key => {
            let uniqueValues = new Set();
            let isCategory = true;
            let isNumeric = true;

            for (let row of detectionSample) {
                const val = row[key];
                if (val !== null && val !== undefined && String(val).trim() !== '') {
                    uniqueValues.add(val);
                    if (isNaN(parseFloat(val))) {
                        isNumeric = false;
                    }
                }
                if (uniqueValues.size > 100 && !isNumeric) {
                    isCategory = false;
                    break;
                }
            }

            if (isCategory && uniqueValues.size > 0 && uniqueValues.size < detectionSample.length) {
                aggregates[key] = {
                    type: "categorical",
                    counts: countBy(rows, key)  // uses ALL rows for counts
                };
            }

            // Store numeric aggregates as a typed object (not key_total) so buildLLMPayload can read them
            if (isNumeric && uniqueValues.size > 0) {
                let total = 0, count = 0;
                let min = Infinity, max = -Infinity;
                rows.forEach(r => {
                    const v = parseFloat(r[key]);
                    if (!isNaN(v)) {
                        total += v;
                        count++;
                        if (v < min) min = v;
                        if (v > max) max = v;
                    }
                });
                if (count > 0) {
                    aggregates[key] = {
                        type: 'numeric',
                        sum: parseFloat(total.toFixed(2)),
                        avg: parseFloat((total / count).toFixed(2)),
                        min: min === Infinity ? null : min,
                        max: max === -Infinity ? null : max,
                        count: count
                    };
                }
            }
        });
        return aggregates;
    }


    function topN(obj, n = 8) {
        return Object.entries(obj || {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, n);
    }

    /* Polished dataset insight message (no bullets) */
    function datasetInsightMessage(fileName, profile, aggregates) {
        const missingTop = topN(profile.blanks, 3)
            .map(([k, v]) => `${k}: ${v.toLocaleString()}`)
            .join(" • ") || "None";

        const girderTop = topN(aggregates.girderStatus, 3)
            .map(([k, v]) => `${k}: ${v.toLocaleString()}`)
            .join(" • ") || "—";

        // Polished markdown card (no bullets, cleaner spacing)
        const md = `
            <div class="datasetCard">
                <div class="datasetCard__header">
                    <div class="datasetCard__badge">
                        <svg viewBox="0 0 24 24" fill="none" class="datasetCard__icon">
                            <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2" />
                            <path d="M3 9h18M9 21V9" stroke="currentColor" stroke-width="2" />
                        </svg>
                        Dataset loaded
                    </div>
                </div>

                <div class="datasetCard__body">
                    <div class="datasetCard__file">${fileName}</div>

                    <div class="datasetCard__grid">
                        <div class="datasetCard__stat">
                            <div class="datasetCard__label">Rows</div>
                            <div class="datasetCard__value">${profile.rowCount.toLocaleString()}</div>
                        </div>
                        <div class="datasetCard__stat">
                            <div class="datasetCard__label">Columns</div>
                            <div class="datasetCard__value">${profile.columns.length}</div>
                        </div>
                        <div class="datasetCard__stat">
                            <div class="datasetCard__label">Missing</div>
                            <div class="datasetCard__value">${(profile.missingRatio * 100).toFixed(1)}%</div>
                        </div>
                    </div>

                    <div class="datasetCard__meta">
                        <strong>Top missing:</strong> ${missingTop}
                    </div>
                    <div class="datasetCard__meta">
                        <strong>Top girder status:</strong> ${girderTop}
                    </div>
                </div>
            </div>
            `;

        // Charts with accurate labels from data
        const girder = topN(aggregates.girderStatus, 10);
        const pier = topN(aggregates.pierStatus, 10);
        const context = topN(aggregates.context, 8);

        const charts = [
            {
                title: "Girder status distribution",
                type: "bar",
                labels: girder.map(x => x[0]), // accurate label from data
                datasets: [{
                    label: "Girder Status Count", // accurate legend
                    data: girder.map(x => x[1])
                }]
            },
            {
                title: "Context split",
                type: "doughnut",
                labels: context.map(x => x[0]), // accurate label from data
                datasets: [{
                    label: "Context Distribution", // accurate legend
                    data: context.map(x => x[1])
                }]
            },
            {
                title: "Pier status distribution",
                type: "bar",
                labels: pier.map(x => x[0]), // accurate label from data
                datasets: [{
                    label: "Pier Status Count", // accurate legend
                    data: pier.map(x => x[1])
                }]
            }
        ];

        return { md, charts };
    }
    /* CSV/XLSX upload only triggers dataset info + charts */
    async function readAsArrayBuffer(file) { return await file.arrayBuffer(); }

    function createAssistantShell(ts = Date.now()) {
        const result = createMessageNode("assistant", "", false, ts);

        let node;
        if (result instanceof Node) {
            node = result;
        } else {
            const wrapper = document.createElement("div");
            wrapper.innerHTML = String(result).trim();
            node = wrapper.firstElementChild;
        }

        const contentWrap =
            node.querySelector(".messagebubble") ||
            node.querySelector(".bubble") ||
            node;

        const thread = document.getElementById("messages");
        if (thread && node) thread.appendChild(node);

        return { node, contentWrap };
    }




    async function callOpenRouterForInsightsAndCharts(chartPayload, userGoal = "Generate charts and insights") {
        const system = `
Return ONLY valid JSON:
{
  "insights": {
    "headline": "string",
    "summary": "string",
    "keymetrics": [{"label":"string","value":"string"}],
    "highlights": ["string"],
    "qualityFlags": ["string"]
  },
  "charts": [
    {
      "type": "column",
      "title": "string",
      "xAxis": { "categories": ["A", "B"] },
      "series": [{ "name": "string", "data": [1, 2] }]
    }
  ]
}

Rules:
- Use only the provided dataset fields and aggregates.
- Return 1 or 2 charts only.
- Use exact dataset labels.
- Do not infer missing person attributes from names.
- Keep insights short.
  `.trim();

        const userMsg = JSON.stringify({
            goal: userGoal,
            dataset: chartPayload
        });

        const raw = await axiChatCompletion({
            messages: [
                { role: "system", content: system },
                { role: "user", content: userMsg }
            ],
            temperature: 0,
            maxtokens: 800
        });

        const text = typeof raw === "string" ? raw : (raw?.text || "");
        const parsed = tryParseJsonStrict(text);
        return parsed ? parsed : { fallbackText: text };
    }

    function estimateChars(obj) {
        try {
            return JSON.stringify(obj).length;
        } catch {
            return 0;
        }
    }

    async function parseCSV(file) {
        const text = await file.text();
        const parsed = Papa.parse(text, { header: true, skipEmptyLines: "greedy" });
        const rows = (parsed.data || []).map(normalizeRow);
        const profile = buildProfile(rows);
        const aggregates = buildAggregates(rows);

        const chat = getActiveChat();
        if (chat) {
            chat.dataset = { fileName: file.name, profile, aggregates };
            chat.datasetFileName = file.name;
            chat.datasetRows = rows;
            chat.datasetProfile = profile;
            chat.datasetAggregates = aggregates;
            chat.updatedAt = Date.now();
        }
        saveChats();

        window.pendingDatabaseData = { name: file.name, data: rows };

        const promptInput = document.getElementById("prompt");
        if (promptInput && !promptInput.value.trim()) {
            promptInput.value = `Analyze this file: ${file.name}`;
            promptInput.dispatchEvent(new Event("input", { bubbles: true }));
            refreshComposerState();
        }

        // 1. SHOW LOADING STATE IMMEDIATELY
        if (typeof setBusy === "function") setBusy(true);
        const { node: loadingNode, contentWrap: loadingWrap } = createAssistantShell(Date.now());
        loadingWrap.innerHTML = `<div style="display:flex; align-items:center; gap:8px;">
        <span class="material-icons" style="animation: spin 1s linear infinite;">sync</span>
        Analyzing dataset (this may take 10-20 seconds)...
    </div>`;
        document.getElementById("messages")?.appendChild(loadingNode);
        scrollToBottom();

        try {

            const analysisPayload = buildLLMPayload(file.name, rows, profile, aggregates);
            const chartPayload = buildChartPayload(file.name, rows, profile, aggregates);

            const chartAi = await callOpenRouterForInsightsAndCharts(
                chartPayload,
                "Generate charts and insights."
            );
            // 2. CALL AI
            const tableAi = await callOpenRouterForTableAndInsights(
                analysisPayload,
                "Create a smart table preview and insights."
            );


            // 3. RENDER REAL CONTENT
            const { node, contentWrap } = createAssistantShell(Date.now());

            if (tableAi?.table) renderTableInMessage(contentWrap, rows, tableAi.table, profile);
            if (tableAi?.insights) renderInsightsInMessage(contentWrap, tableAi.insights);
            if (tableAi?.report) renderNarrativeReport(contentWrap, tableAi.report);
            if (typeof renderTableNotes === "function") renderTableNotes(contentWrap, tableAi);

            if (chartAi?.insights) renderInsightsInMessage(contentWrap, chartAi.insights);
            if (Array.isArray(chartAi?.charts)) {
                chartAi.charts.forEach(ch => renderHighchartInMessage(contentWrap, ch));
            }

            // Replace the temporary loading node with the real one
            loadingNode.replaceWith(node);
            scrollToBottom();

            // Fallbacks
            if (!tableAi?.table && tableAi?.fallbackText) {
                pushMessage("assistant", tableAi.fallbackText, true);
            }
            if ((!chartAi?.charts || !chartAi.charts.length) && chartAi?.fallbackText) {
                pushMessage("assistant", chartAi.fallbackText, true);
            }
        } catch (err) {
            console.error("Dataset Analysis Error:", err);
            loadingWrap.innerHTML = `<span style="color: red;">Error analyzing file: ${err.message}</span>`;
        } finally {
            if (typeof setBusy === "function") setBusy(false);
        }
    }

    async function parseXLSX(file) {
        const buf = await readAsArrayBuffer(file);
        const wb = XLSX.read(buf, { type: "array" });
        const sheetName = wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
        const rows = json.map(normalizeRow);
        const profile = buildProfile(rows);
        const aggregates = buildAggregates(rows);

        const datasetName = `${file.name} / ${sheetName}`;

        const chat = getActiveChat();
        if (chat) {
            chat.dataset = { fileName: datasetName, profile, aggregates };
            chat.datasetFileName = datasetName;
            chat.datasetRows = rows;
            chat.datasetProfile = profile;
            chat.datasetAggregates = aggregates;
            chat.updatedAt = Date.now();
        }
        saveChats();

        // Lock the global dataset to this chat so handleSend behaves safely
        window.pendingDatabaseData = {
            name: datasetName,
            data: rows,
            chatId: chat ? chat.id : null
        };

        // 1. SHOW LOADING STATE IMMEDIATELY
        if (typeof setBusy === "function") setBusy(true);

        // Add the user's implicit query to the chat array so it persists on reload
        pushMessage("user", `Uploaded and analyzed file: ${file.name}`, false);

        const { node: loadingNode, contentWrap: loadingWrap } = createAssistantShell(Date.now());
        loadingWrap.innerHTML = `<div style="display:flex; align-items:center; gap:8px;">
        <span class="material-icons" style="animation: spin 1s linear infinite;">sync</span>
        Analyzing dataset (this may take 10-20 seconds)...
    </div>`;
        document.getElementById("messages")?.appendChild(loadingNode);
        scrollToBottom();

        try {
            const payload = buildLLMPayload(file.name, rows, profile, aggregates);

            const tableAi = await callOpenRouterForTableAndInsights(
                payload,
                "Create a smart table preview and insights."
            );

            const chartAi = await callOpenRouterForInsightsAndCharts(
                payload,
                "Generate charts and insights."
            );

            // Remove loading state
            loadingNode.remove();

            // 3. RENDER REAL CONTENT
            const { node, contentWrap } = createAssistantShell(Date.now());

            if (tableAi?.table) renderTableInMessage(contentWrap, rows, tableAi.table, profile);
            if (chartAi?.charts && Array.isArray(chartAi.charts)) {
                chartAi.charts.forEach(spec => renderHighchartInMessage(contentWrap, spec));
            }
            if (tableAi?.report) renderNarrativeReport(contentWrap, tableAi.report);
            renderDatasetOverviewCard(contentWrap, profile, aggregates);
            if (tableAi?.insights) renderTableNotes(contentWrap, tableAi);

            document.getElementById("messages")?.appendChild(node);
            scrollToBottom();

            // Push an invisible confirmation to the message log so history doesn't break
            const currentChat = getActiveChat();
            if (currentChat) {
                currentChat.messages.push({
                    role: "assistant",
                    content: "**Dataset Analysis Complete.**\n\n(See visual report above)",
                    markdown: true,
                    ts: Date.now()
                });
                saveChats();
            }

        } catch (err) {
            loadingNode.remove();
            console.error("XLSX Analysis Error:", err);
            pushMessage("assistant", `Failed to analyze dataset: ${err.message}`, true);
        } finally {
            if (typeof setBusy === "function") setBusy(false);
            const promptInput = document.getElementById("prompt");
            if (promptInput) {
                promptInput.value = ""; // Clear input so user doesn't accidentally hit enter on the default text
                refreshComposerState();
                if (typeof syncComposerButtons === "function") syncComposerButtons();
            }
        }
    }

    function extOf(name = "") {
        const i = name.lastIndexOf(".");
        return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
    }

    el.fileInput?.addEventListener("change", async e => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        if (!files.length) return;

        setBusy(true);
        try {
            for (const f of files) {
                const ext = extOf(f.name);

                // Group ALL valid data types together so they flow securely into handleSend()
                if (ext === "csv" || ext === "xlsx" || ext === "xls" || ext === "json" || ext === "txt" || ext === "pdf" || ext === "docx") {

                    // Clear any old database injection so it doesn't merge with the new file
                    window.pendingDatabaseData = null;

                    state.pendingAttachments.push({
                        kind: "file",
                        name: f.name,
                        fileObj: f
                    });

                    renderAttachmentTray();
                    if (typeof syncComposerButtons === "function") syncComposerButtons();

                    if (!el.prompt.value.trim()) {
                        el.prompt.value = `Analyze this file: ${f.name}`;
                        el.prompt.dispatchEvent(new Event("input", { bubbles: true }));
                        refreshComposerState();
                    }

                    // This triggers the exact same structured Executive Summary you get for JSON
                    await handleSend();
                    continue;
                }

                if (typeof pushMessage === "function") {
                    pushMessage(
                        "assistant",
                        `Unsupported file type: ${f.name}. Supported types: CSV, XLSX, XLS, TXT, JSON, PDF, DOCX.`,
                        true
                    );
                }
            }
        } catch (err) {
            if (typeof pushMessage === "function") {
                pushMessage("assistant", `Upload failed: ${err.message || err}`, true);
            }
        } finally {
            setBusy(false);
        }
    });




    /* Chat send (text only here; plug backend if needed) */
    // REPLACE your existing el.composer event listener with this:
    el.composer.addEventListener("submit", async (e) => {
        e.preventDefault();
        await handleSend();
    });


    el.prompt.addEventListener("input", () => {
        el.prompt.style.height = "auto";
        el.prompt.style.height = Math.min(el.prompt.scrollHeight, 120) + "px";
        syncComposerButtons();
    });

    /* BUG-1 FIX: plain Enter submits; Shift+Enter inserts a newline */
    el.prompt.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            el.composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        }
    });

    el.newChat?.addEventListener("click", () => { newChat(); });
    el.reset?.addEventListener("click", () => {
        const chat = getActiveChat();
        if (!chat) return;
        chat.messages = [];
        chat.dataset = null;
        chat.title = "New chat";
        chat.updatedAt = Date.now();
        saveChats();
        renderThread();
        renderChatList();
    });

    /* init */
    (function init() {
        state.chats = loadChats();
        ensureAtLeastOneChat();

        initHeaderUI();
        initHeaderActions();
        setActiveChat(state.activeChatId);
        syncComposerButtons();
    })();

    function setActiveChat(chatId) {
        state.activeChatId = chatId;
        saveChats();
        renderChatList();
        renderThread();
    }

    function newChat() {
        const c = { id: uid(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), messages: [], dataset: null };
        state.chats.unshift(c);
        saveChats();
        setActiveChat(c.id);
    }

    const btn = document.getElementById("newChatFromHistory");

    if (btn) {
        // 1. Clone the button to remove ALL existing event listeners (fixes double-add)
        const freshBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(freshBtn, btn);

        // 2. Add the SINGLE correct listener
        freshBtn.addEventListener("click", (e) => {
            e.stopPropagation(); // Prevents clicks from triggering "close" logic elsewhere
            e.preventDefault();  // Stops default browser behavior
            newChat();           // Creates the chat
            // Notice: We do NOT call closeHistory() here, so it stays open.
        });
    }

    async function extractTextFromDocx(file) {
        if (!window.mammoth) {
            throw new Error("DOCX parser not loaded. Add mammoth.browser.min.js to index.html.");
        }

        // DataBin stores files as metadata-only objects without binary content.
        // Detect this early so the error message is meaningful to the user.
        if (typeof file.arrayBuffer !== "function") {
            throw new Error(
                `"${file.name}" content is not available in this session. ` +
                `The Data Bin stores file metadata only — not the actual file bytes. ` +
                `Upload "${file.name}" directly in the chat for AI analysis.`
            );
        }

        const arrayBuffer = await file.arrayBuffer();

        // DOCX is a ZIP archive — magic bytes must be PK\x03\x04 (0x50 0x4B 0x03 0x04).
        // DataBin file stubs have a real .arrayBuffer() method but return an empty/invalid
        // buffer, causing mammoth to throw "Can't find end of central directory".
        // Catch this early with a meaningful error before mammoth ever sees the data.
        const magic = new Uint8Array(arrayBuffer, 0, 4);
        if (arrayBuffer.byteLength < 4 || magic[0] !== 0x50 || magic[1] !== 0x4B ||
            magic[2] !== 0x03 || magic[3] !== 0x04) {
            throw new Error(
                `"${file.name}" does not contain valid DOCX data. ` +
                `The Data Bin stores file metadata only — not the actual file bytes. ` +
                `Upload "${file.name}" directly in the chat to analyze its content.`
            );
        }

        let rawText = "";
        try {
            const result = await window.mammoth.extractRawText({ arrayBuffer });
            rawText = String(result?.value || "").trim();
            console.log("DOCX raw extraction:", {
                name: file.name,
                chars: rawText.length,
                warnings: result?.messages || []
            });
        } catch (err) {
            console.error("DOCX raw extraction failed:", err);
        }

        if (rawText) return rawText;

        try {
            const htmlResult = await window.mammoth.convertToHtml({ arrayBuffer });
            const html = String(htmlResult?.value || "").trim();
            const text = new DOMParser().parseFromString(html, "text/html").body.textContent.trim();

            console.log("DOCX html fallback extraction:", {
                name: file.name,
                chars: text.length,
                warnings: htmlResult?.messages || []
            });

            if (text) return text;
        } catch (err) {
            console.error("DOCX html fallback failed:", err);
        }

        throw new Error("Could not extract readable text from this DOCX file.");
    }

    function getPdfMetaFromContext(fileName = "", fileContext = "") {
        const safeName = String(fileName || "").trim();
        const text = String(fileContext || "");
        const pageMatches = text.match(/--- Page \d+ ---/g) || [];
        return {
            fileName: safeName,
            extractedPageCount: pageMatches.length,
            isPdf: /\.pdf$/i.test(safeName)
        };
    }


    /* ==========================================================================
       UPDATED handleSend Function
       (Replace your existing handleSend with this complete block)
       ========================================================================== */

    // --- PLACE THESE 3 HELPERS ABOVE handleSend ---

    function clearDatasetState(chat = getActiveChat(), options = {}) {
        const { clearFileContext = false } = options;
        if (chat) {
            chat.dataset = null;
            chat.datasetFileName = null;
            chat.datasetRows = null;
            chat.datasetProfile = null;
            chat.datasetAggregates = null;
            if (clearFileContext) {
                chat.fileContext = null;
                chat.fileName = null;
            }
            chat.updatedAt = Date.now();
            saveChats();
        }
        window.pendingDatabaseData = null;
    }

    function syncPendingDatabaseToActiveChat(chat = getActiveChat()) {
        if (chat && Array.isArray(chat.datasetRows) && chat.datasetRows.length) {
            window.pendingDatabaseData = {
                name: chat.datasetFileName || chat.fileName || "dataset",
                data: chat.datasetRows,
                chatId: chat.id
            };
            return;
        }
        window.pendingDatabaseData = null;
    }

    function isLikelyTabularText(text, parsed, rows) {
        if (!Array.isArray(rows) || !rows.length) return false;
        const fields = Array.isArray(parsed?.meta?.fields)
            ? parsed.meta.fields.filter(f => String(f).trim() !== "")
            : Object.keys(rows[0] || {}).filter(f => String(f).trim() !== "");
        if (fields.length < 2) return false;
        if (rows.length < 2) return false;
        const filledRows = rows.filter(row => {
            let filled = 0;
            for (const field of fields) {
                if (String(row?.[field] ?? "").trim() !== "") filled++;
            }
            return filled >= 2;
        }).length;
        if (filledRows < 2) return false;
        const raw = String(text || "").trim();
        if ((raw.startsWith("{") || raw.startsWith("[")) && rows.length <= 2) return false;
        return true;
    }


    // ─── STREAMING DOM HELPERS ───────────────────────────────────────────────────

    /** Creates the initial streaming assistant message node with a live thinking block */
    function createStreamingNode() {
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const wrap = document.createElement('div');
        wrap.innerHTML = `
<div class="message message--assistant axi-streaming-msg">
  <div class="message__avatar">
    <img src="../../images/ai-logo.png" alt="">
  </div>
  <div class="message__content">
    <div class="axi-thinking-block axi-thinking-block--active">
      <div class="axi-thinking-header">
        <svg class="axi-thinking-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a7 7 0 0 1 7 7c0 2.5-1.3 4.7-3.3 6L15 17H9l-.7-2C6.3 13.7 5 11.5 5 9a7 7 0 0 1 7-7z"/>
          <path d="M9 17v1a3 3 0 0 0 6 0v-1"/>
        </svg>
        <span class="axi-thinking-label">Thinking</span>
        <span class="axi-thinking-dots">
          <span></span><span></span><span></span>
        </span>
      </div>
      <div class="axi-thinking-body">
        <div class="axi-thinking-content"></div>
      </div>
    </div>
    <div class="message__bubble"></div>
    <div class="message__meta">${timeStr}</div>
  </div>
</div>`.trim();
        return wrap.firstElementChild;
    }

    /** Incrementally updates the bubble with partial markdown during streaming */
    function _updateStreamBubble(bubbleEl, text) {
        if (!bubbleEl || !text) return;
        try {
            let html = (typeof marked !== 'undefined')
                ? (typeof DOMPurify !== 'undefined'
                    ? DOMPurify.sanitize(marked.parse(text))
                    : marked.parse(text))
                : axiEscHtml(text);
            bubbleEl.innerHTML = html;
        } catch (_) {
            bubbleEl.textContent = text;
        }
        // Append blinking cursor
        const cursor = document.createElement('span');
        cursor.className = 'axi-stream-cursor';
        bubbleEl.appendChild(cursor);
    }

    /**
     * Transitions the thinking block from the "active / animating" state to the
     * collapsed "Thought for Xs" pill the user can expand to see full reasoning.
     */
    function _finalizeThinkingBlock(node, thinkingText, duration) {
        const block = node.querySelector('.axi-thinking-block');
        if (!block) return;

        block.classList.remove('axi-thinking-block--active');
        block.classList.add('axi-thinking-block--done');

        const header = block.querySelector('.axi-thinking-header');
        if (header) {
            header.innerHTML = `
          <svg class="axi-thinking-done-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M8 12l3 3 5-5"/>
          </svg>
          <span class="axi-thinking-label">Thought for ${duration}s</span>
          <svg class="axi-thinking-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
            <path d="M6 9l6 6 6-6"/>
          </svg>`;
            header.addEventListener('click', () => {
                block.classList.toggle('axi-thinking-block--expanded');
                // Auto-scroll content to bottom when expanding
                if (block.classList.contains('axi-thinking-block--expanded')) {
                    const contentEl = block.querySelector('.axi-thinking-content');
                    if (contentEl) contentEl.scrollTop = contentEl.scrollHeight;
                }
            });
        }

        const contentEl = block.querySelector('.axi-thinking-content');
        if (contentEl) {
            contentEl.textContent = thinkingText || 'Processed the request and composed a response.';
        }
    }

    /**
     * Called once streaming is complete.
     * Renders the full markdown, applies code-block / callout / chart enhancements,
     * and removes the blinking cursor.
     */
    function _finalizeStreamNode(node, bubbleEl, finalContent, chartDataList = []) {
        if (!bubbleEl) return;

        // Remove stream cursor
        bubbleEl.querySelector('.axi-stream-cursor')?.remove();

        // Target the inner wrapper if it exists (created by _scheduleRender patch)
        // so we don't nuke the bubble's own background
        const target = bubbleEl.querySelector('.axi-stream-inner') || bubbleEl;

        // Full final render
        if (isFullHtmlDocument(finalContent)) {
            target.innerHTML = buildHtmlPreviewHTML(finalContent);
        } else if (typeof marked !== 'undefined') {
            let html = marked.parse(finalContent || '');
            if (typeof DOMPurify !== 'undefined') html = DOMPurify.sanitize(html);
            target.innerHTML = html;
        } else {
            target.textContent = finalContent;
        }

        // Post-processing enhancements
        enhanceCodeBlocks(node);
        if (typeof axiEnhanceCallouts === 'function') axiEnhanceCallouts(node);
        if (chartDataList.length > 0 && typeof renderHighchartInMessage === 'function') {
            chartDataList.forEach(spec => renderHighchartInMessage(bubbleEl, spec));
        }

        node.classList.remove('axi-streaming-msg');

        if (finalContent) {
            bubbleEl.style.position = 'relative';
        }
    }
    // ─────────────────────────────────────────────────────────────────────────────

    // --- YOUR FULLY UPDATED handleSend FUNCTION ---
    async function hydrateChatFromActiveDataBin(currentChat) {
        const context = window.ACTIVEDATABINCONTEXT;
        if (!context || !currentChat) return { binFileContext: "", usedBin: false };

        let binFileContext = "";
        const files = Array.isArray(context.files) ? context.files : [];
        const combinedRows = Array.isArray(context.combinedDatabaseRows) ? context.combinedDatabaseRows : [];

        let preferredDataset = null;

        for (const file of files) {
            // Skip DataBin metadata entries that have no text or binary content at all
            const hasContent = typeof file.text === 'function'
                || typeof file.arrayBuffer === 'function'
                || typeof file.content === 'string'
                || typeof file.rawText === 'string'
                || typeof file.data === 'string';
            if (!hasContent) {
                console.info('[AXI DataBin] Skipping content-less file entry:', file?.name);
                continue;
            }
            try {
                const rows = await getDatasetRowsForAiFromFile(file);
                if (Array.isArray(rows) && rows.length) {
                    preferredDataset = {
                        fileName: file.name,
                        rows
                    };
                    break;
                }
            } catch (err) {
                console.warn("Could not parse Data Bin file as dataset:", file?.name, err);
            }
        }

        if (preferredDataset) {
            const profile = typeof buildProfile === "function" ? buildProfile(preferredDataset.rows) : null;
            const aggregates = typeof buildAggregates === "function" ? buildAggregates(preferredDataset.rows) : null;

            currentChat.dataset = {
                fileName: preferredDataset.fileName,
                profile,
                aggregates,
                dataBinId: context.id || null,
                sourceType: "dataBinFile"
            };
            currentChat.datasetFileName = preferredDataset.fileName;
            currentChat.datasetRows = preferredDataset.rows;
            currentChat.datasetProfile = profile;
            currentChat.datasetAggregates = aggregates;
            currentChat.fileName = preferredDataset.fileName;
            currentChat.updatedAt = Date.now();

            window.pendingDatabaseData = {
                name: preferredDataset.fileName,
                data: preferredDataset.rows,
                chatId: currentChat.id,
                source: "dataBinFile"
            };
        } else if (combinedRows.length) {
            const profile = typeof buildProfile === "function" ? buildProfile(combinedRows) : null;
            const aggregates = typeof buildAggregates === "function" ? buildAggregates(combinedRows) : null;

            currentChat.dataset = {
                fileName: context.name || "Data Bin",
                profile,
                aggregates,
                dataBinId: context.id || null,
                datasourceNames: (context.datasources || []).map(ds => ds.name)
            };
            currentChat.datasetFileName = context.name || "Data Bin";
            currentChat.datasetRows = combinedRows;
            currentChat.datasetProfile = profile;
            currentChat.datasetAggregates = aggregates;
            currentChat.updatedAt = Date.now();

            window.pendingDatabaseData = {
                name: context.name || "Data Bin",
                data: combinedRows,
                chatId: currentChat.id,
                source: "dataBinDatasource"
            };
        }

        if (files.length) {
            const chunks = [];
            for (const file of files) {
                try {
                    const ext = extOf(file.name);

                    // DataBin files are persisted as metadata-only objects {name, type, size}.
                    // They have no .text() or .arrayBuffer() method, so any binary access
                    // throws TypeError. Detect this once here and emit a clear notice for ALL
                    // file types — the AI will relay the correct action to the user.
                    const hasContent = typeof file.text === "function" || typeof file.arrayBuffer === "function";
                    if (!hasContent) {
                        chunks.push(buildFileContextFromText(
                            file.name,
                            `[FILE_CONTENT_UNAVAILABLE]\n` +
                            `File: ${file.name}\n` +
                            `Status: This file is stored in the Data Bin as a reference only ` +
                            `(metadata: name, type, size). Its binary content is not available ` +
                            `in this session.\n` +
                            `Instruction: Tell the user to upload "${file.name}" directly into ` +
                            `the chat (drag-and-drop or the attachment button) so the AI can ` +
                            `read and analyze its content. The Data Bin does not retain file bytes.`
                        ));
                        continue;
                    }

                    if (ext === "csv") {
                        const raw = await file.text();
                        chunks.push(buildFileContextFromText(file.name, raw));
                        continue;
                    }

                    if (ext === "xlsx" || ext === "xls") {
                        const rows = await getDatasetRowsForAiFromFile(file);
                        chunks.push(buildFileContextFromText(file.name, JSON.stringify(rows.slice(0, 200), null, 2)));
                        continue;
                    }

                    if (ext === "txt" || ext === "json") {
                        const raw = await file.text();
                        chunks.push(buildFileContextFromText(file.name, raw));
                        continue;
                    }

                    if (ext === "pdf" || ext === "docx") {
                        const raw = await extractTextForAnalysis(file);
                        chunks.push(buildFileContextFromText(file.name, raw));
                        continue;
                    }
                } catch (err) {
                    chunks.push(buildFileContextFromText(file.name, `Failed to read this file for analysis. ${err?.message || err}`));
                }
            }

            binFileContext = chunks.join("\n\n");
            currentChat.fileContext = binFileContext;
        }

        currentChat.activeDataBinId = context.id || null;
        currentChat.activeDataBinName = context.name || "Data Bin";
        currentChat.updatedAt = Date.now();
        saveChats();

        return { binFileContext, usedBin: true };
    }


    window.ACTIVEDATABINAIPAYLOAD = window.ACTIVEDATABINAIPAYLOAD || null;

    function splitPlainTextForAi(text, maxChars = 12000) {
        const raw = String(text || '').trim();
        if (!raw) return [];
        if (raw.length <= maxChars) return [raw];

        const out = [];
        for (let i = 0; i < raw.length; i += maxChars) {
            out.push(raw.slice(i, i + maxChars));
        }
        return out;
    }

    function splitToonForAi(toon, maxChars = 12000) {
        const raw = String(toon || '').trim();
        if (!raw) return [];

        const lines = raw.split(/\r?\n/);
        if (lines.length <= 1) return splitPlainTextForAi(raw, maxChars);

        const header = lines[0];
        const chunks = [];
        let current = header;

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            const next = current + '\n' + line;

            if (next.length > maxChars && current !== header) {
                chunks.push(current);
                current = header + '\n' + line;
                continue;
            }

            if (next.length > maxChars) {
                const pieces = splitPlainTextForAi(
                    line,
                    Math.max(2000, maxChars - header.length - 1)
                );
                pieces.forEach(function (piece) {
                    chunks.push(header + '\n' + piece);
                });
                current = header;
                continue;
            }

            current = next;
        }

        if (current && current !== header) chunks.push(current);
        return chunks.length ? chunks : [header];
    }

    function buildAiDatasetUnit(name, rows, meta) {
        const safeRows = Array.isArray(rows) ? rows : [];
        const profile = typeof buildProfile === 'function'
            ? buildProfile(safeRows)
            : {
                rowCount: safeRows.length,
                columns: safeRows[0] ? Object.keys(safeRows[0]) : [],
                missingRatio: 0
            };

        const aggregates = typeof buildAggregates === 'function'
            ? buildAggregates(safeRows)
            : null;

        const llmPayload = typeof buildLLMPayload === 'function'
            ? buildLLMPayload(name, safeRows, profile, aggregates)
            : null;

        const toon = typeof jsonToToon === 'function' ? jsonToToon(safeRows) : '';

        return {
            kind: 'dataset',
            name: name || 'Dataset',
            rowCount: safeRows.length,
            columns: Array.isArray(profile?.columns)
                ? profile.columns
                : (safeRows[0] ? Object.keys(safeRows[0]) : []),
            llmPayload: llmPayload || null,
            toonChunks: splitToonForAi(toon),
            meta: meta || {}
        };
    }

    async function getDatasetRowsForAiFromFile(file) {
        const ext = extOf(file.name);

        // DataBin "files" are plain objects, not real File/Blob instances.
        // Use this helper so both cases work.
        const getText = async () => {
            if (typeof file.text === 'function') return file.text();
            if (typeof file.content === 'string') return file.content;
            if (typeof file.rawText === 'string') return file.rawText;
            if (typeof file.data === 'string') return file.data;
            throw new TypeError('No readable text content on file object: ' + file.name);
        };

        const getBuffer = async () => {
            if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
            throw new TypeError('No arrayBuffer on file object: ' + file.name);
        };

        if (ext === 'csv') {
            const raw = await getText();
            return parseDelimitedTextToRows(raw, { strict: true }) || [];
        }

        if (ext === 'xlsx' || ext === 'xls') {
            const buf = await getBuffer();
            const wb = XLSX.read(buf, { type: 'array' });
            const rows = [];
            (wb.SheetNames || []).forEach(function (sheetName) {
                const ws = wb.Sheets[sheetName];
                const json = ws ? XLSX.utils.sheet_to_json(ws, { defval: '' }) : [];
                json.forEach(function (row) {
                    const base = typeof normalizeRow === 'function' ? normalizeRow(row) : row;
                    const enriched = Object.assign({ __sheet: sheetName }, base);
                    const hasData = Object.values(enriched).some(function (v) {
                        return String(v ?? '').trim() !== '';
                    });
                    if (hasData) rows.push(enriched);
                });
            });
            return rows;
        }

        if (ext === 'json') {
            const raw = await getText();
            return tryParseDatasetJson(raw) || [];
        }

        if (ext === 'txt') {
            const raw = await getText();
            return tryParseDatasetJson(raw) || parseDelimitedTextToRows(raw, { strict: true }) || [];
        }

        return [];
    }

    async function buildAiFileUnit(file) {
        const ext = extOf(file.name);

        // DataBin files are metadata-only objects without binary content.
        // Short-circuit before any .arrayBuffer() / .text() / FileReader call throws.
        const hasContent = typeof file.text === "function" || typeof file.arrayBuffer === "function";
        if (!hasContent) {
            const notice =
                `[FILE_CONTENT_UNAVAILABLE]\n` +
                `File: ${file.name}\n` +
                `Status: Content not accessible. The Data Bin stores file metadata only.\n` +
                `Instruction: The user must upload "${file.name}" directly in the chat ` +
                `(attachment button or drag-and-drop) for AI analysis.`;
            return {
                kind: 'document',
                name: file.name,
                fileType: ext,
                textChunks: splitPlainTextForAi(buildFileContextFromText(file.name, notice)),
                meta: { origin: 'file', contentUnavailable: true }
            };
        }

        const rows = await getDatasetRowsForAiFromFile(file);

        if (Array.isArray(rows) && rows.length) {
            return buildAiDatasetUnit(file.name, rows, {
                origin: 'file',
                fileType: ext
            });
        }

        let raw = '';
        if (ext === 'pdf' || ext === 'docx') raw = await extractTextForAnalysis(file);
        else if (ext === 'txt' || ext === 'json') raw = await file.text();
        else raw = await readFileAsText(file);

        const fileContext = buildFileContextFromText(file.name, raw);

        return {
            kind: 'document',
            name: file.name,
            fileType: ext,
            textChunks: splitPlainTextForAi(fileContext),
            meta: { origin: 'file' }
        };
    }

    window.buildActiveDataBinAiPayload = async function (context, options = {}) {
        const {
            includeDatasources = true,
            includeFiles = true,
            includeCombined = true
        } = options;

        if (!context) return null;

        const datasourceUnits = includeDatasources && Array.isArray(context.datasources)
            ? context.datasources.map(function (ds) {
                return buildAiDatasetUnit(
                    ds.caption || ds.name,
                    Array.isArray(ds.rows) ? ds.rows : [],
                    {
                        origin: "datasource",
                        sourceName: ds.name,
                        sourceCaption: ds.caption || ds.name
                    }
                );
            })
            : [];

        const fileUnits = [];
        if (includeFiles) {
            for (const file of Array.isArray(context.files) ? context.files : []) {
                try {
                    fileUnits.push(await buildAiFileUnit(file));
                } catch (err) {
                    fileUnits.push({
                        kind: "document",
                        name: file?.name || "Unknown file",
                        fileType: file?.name ? extOf(file.name) : "",
                        textChunks: splitPlainTextForAi(
                            buildFileContextFromText(
                                file?.name || "Unknown file",
                                `Failed to read this file for analysis. ${String(err?.message || err || "Unknown error")}`
                            )
                        ),
                        meta: { origin: "file", error: true }
                    });
                }
            }
        }

        const combinedRows = includeCombined && Array.isArray(context.combinedDatabaseRows)
            ? context.combinedDatabaseRows
            : [];

        // Collect all unique column names from every datasource so the combined
        // unit's metadata reflects all columns, not just those in the first row.
        const allDatasourceColumns = [...new Set(
            datasourceUnits.flatMap(function (u) { return Array.isArray(u.columns) ? u.columns : []; })
        )];

        const combined = combinedRows.length
            ? buildAiDatasetUnit(context.name || "Data Bin Combined", combinedRows, {
                origin: "combined",
                allColumns: allDatasourceColumns
            })
            : null;

        // Patch the combined unit's column list to include all datasource columns.
        if (combined && allDatasourceColumns.length) {
            const existing = new Set(combined.columns || []);
            allDatasourceColumns.forEach(function (c) { existing.add(c); });
            combined.columns = [...existing];
        }

        return {
            id: context.id || null,
            name: context.name || "Data Bin",
            meta: {
                id: context.id || null,
                name: context.name || "Data Bin",
                datasourceCount: datasourceUnits.length,
                fileCount: fileUnits.length,
                combinedRowCount: combinedRows.length,
                allColumns: allDatasourceColumns
            },
            datasources: datasourceUnits,
            files: fileUnits,
            combined
        };
    };

    async function handleSend() {
        const text = el.prompt.value.trim();

        /* BUG-2 FIX: hard block if over 2000 chars */
        if ((el.prompt.value || '').length > 2000) {
            if (typeof toast === 'function') toast('Message too long — maximum 2000 characters.', 'error', 3500);
            const ct = document.getElementById('axiCharCount');
            if (ct) { ct.style.color = '#EF4444'; ct.style.fontWeight = '700'; }
            return;
        }

        if (!getActiveChat()) newChat();           // ✅ moved up
        let currentChat = getActiveChat();
        const isChartRequest =
            /\b(chart|graph|plot|visuali[sz]e|visualization|bar chart|line chart|pie chart|column chart)\b/i.test(text);

        const hasDatasetRows =
            (Array.isArray(currentChat?.datasetRows) && currentChat.datasetRows.length > 0) ||
            (window.pendingDatabaseData && Array.isArray(window.pendingDatabaseData.data) && window.pendingDatabaseData.data.length > 0);
        // NEW: Detect if this is a chatty follow-up
        const isConversationalFollowUp =
            /explain|what does|why (is|are)|how come|tell me more|elaborate|can you explain|help me understand|clarify|summarize|interpret|describe|what do (these|the|those) charts?|break.{0,10}down/i.test(text)
            || /these charts?|this chart|the previous|above data|from the (chart|graph|data|report)/i.test(text)
            || /give me charts? for this/i.test(text)
            || (text.split(' ').length <= 8 && /chart|graph|that|this|it|mean|show|say/i.test(text));
        const upperText = text.toUpperCase();
        if (upperText === "AXI CONNECT") {
            if (hasRuntimeKey()) {
                appendMessage("assistant", "✅ Already connected — your organisation's API key is active for this session.");
                return;
            }
            window.location.href = "axi-connect.html";
            return;
        }
        if (upperText === "AXI UPLOAD") { window.location.href = "axi-upload.html"; return; }
        if (upperText === "AXI ASK") { window.location.href = "axi-ask.html"; return; }

        const attachments = state.pendingAttachments.slice();

        // Guard: prevent sending while a Data Bin is still being applied.
        // The skeleton patch hides the global loader before applyPin finishes,
        // so without this guard the user could send before ACTIVEDATABINCONTEXT
        // and ACTIVEDATABINAIPAYLOAD are ready, causing the first message to
        // receive no bin context (only stale data or nothing at all).
        if (window.IS_APPLYING_DATABIN) {
            if (typeof toast === 'function') toast('Data Bin is still loading — please wait a moment.', 'info', 2000);
            return;
        }

        if (!text && !attachments.length) return;



        let fileContext = "";
        let activeBinFileContext = "";

        if (!attachments.length && window.ACTIVEDATABINCONTEXT) {
            const binState = await hydrateChatFromActiveDataBin(currentChat);
            activeBinFileContext = binState.binFileContext || "";
        } else if (!attachments.length) {
            if (window.pendingDatabaseData && window.pendingDatabaseData.chatId !== currentChat.id) {
                const rows = window.pendingDatabaseData.data || [];

                if (rows.length > 0) {
                    const profile = typeof buildProfile === "function" ? buildProfile(rows) : null;
                    const aggregates = typeof buildAggregates === "function" ? buildAggregates(rows) : null;

                    currentChat.dataset = { fileName: window.pendingDatabaseData.name, profile, aggregates };
                    currentChat.datasetFileName = window.pendingDatabaseData.name;
                    currentChat.datasetRows = rows;
                    currentChat.datasetProfile = profile;
                    currentChat.datasetAggregates = aggregates;
                    currentChat.fileName = window.pendingDatabaseData.name;
                    currentChat.fileContext = "";
                    currentChat.updatedAt = Date.now();
                    saveChats();
                }

                window.pendingDatabaseData.chatId = currentChat.id;
            } else {
                syncPendingDatabaseToActiveChat(currentChat);
            }
        }

        if (attachments.length > 0) {
            const att = attachments[0];
            const file = (att instanceof File) ? att : (att.fileObj || att.file || att.blob || null);

            if (!file || !file.name) {
                fileContext = "System: Attachment found but file object is missing.";
                if (currentChat) {
                    currentChat.fileContext = fileContext;
                    currentChat.fileName = "unknown";
                    currentChat.updatedAt = Date.now();
                    saveChats();
                }
            } else {
                const ext = extOf(file.name);

                try {
                    if (ext === "csv") {
                        if (typeof Papa === "undefined") {
                            throw new Error("PapaParse not loaded.");
                        }

                        const fullData = await file.text();
                        const rows = parseDelimitedTextToRows(fullData);

                        if (!rows.length) {
                            throw new Error("No usable rows found in CSV file.");
                        }

                        await handleDatasetRowsFromFile(file, rows);

                    } else if (ext === "xlsx" || ext === "xls") {
                        if (typeof XLSX === "undefined") {
                            throw new Error("XLSX library not loaded.");
                        }

                        const buf = await file.arrayBuffer();
                        const wb = XLSX.read(buf, { type: "array" });
                        const sheetName = wb.SheetNames?.[0];
                        if (!sheetName) {
                            throw new Error("No sheet found in workbook.");
                        }

                        const ws = wb.Sheets[sheetName];
                        const json = XLSX.utils.sheet_to_json(ws, { defval: "" });

                        const mainHeaders = Object.keys(json[0] || {}).filter(k => !k.startsWith("__EMPTY"));
                        const primaryCol = mainHeaders[0];

                        const rows = json.map(r => {
                            const clean = {};
                            let validMainFieldsCount = 0;

                            for (const [k, v] of Object.entries(r)) {
                                const key = (k || "").trim();
                                const val = (v ?? "").toString().trim();

                                if (!key.startsWith("__EMPTY")) {
                                    clean[key] = val;
                                    if (val !== "" && val !== "0") {
                                        validMainFieldsCount++;
                                    }
                                }
                            }

                            clean._isValid =
                                (clean[primaryCol] && String(clean[primaryCol]).trim() !== "") ||
                                (validMainFieldsCount >= 2);

                            return clean;
                        })
                            .filter(r => r._isValid)
                            .map(r => {
                                delete r._isValid;
                                return r;
                            });

                        if (!rows.length) {
                            throw new Error("No usable rows found in workbook.");
                        }

                        await handleDatasetRowsFromFile(file, rows);

                    } else if (ext === "txt" || ext === "json") {
                        const fullData = await file.text();

                        let rows = typeof tryParseDatasetJson === "function" ? tryParseDatasetJson(fullData) : [];

                        if (!rows || !rows.length) {
                            rows = parseDelimitedTextToRows(fullData, { strict: true });
                        }

                        if (rows && rows.length) {
                            await handleDatasetRowsFromFile(file, rows);
                        } else {
                            clearDatasetState(currentChat);

                            fileContext = buildFileContextFromText(file.name, fullData);

                            if (currentChat) {
                                currentChat.fileContext = fileContext;
                                currentChat.fileName = file.name;
                                currentChat.updatedAt = Date.now();
                                saveChats();
                            }
                        }

                    } else if (ext === "pdf" || ext === "docx") {
                        clearDatasetState(currentChat);

                        const fullData = await extractTextForAnalysis(file);
                        fileContext = buildFileContextFromText(file.name, fullData);

                        if (currentChat) {
                            currentChat.fileContext = fileContext;
                            currentChat.fileName = file.name;
                            currentChat.updatedAt = Date.now();
                            saveChats();
                        }

                        if (!el.prompt.value.trim()) {
                            el.prompt.value = `Analyze this file: ${file.name}`;
                            el.prompt.dispatchEvent(new Event("input", { bubbles: true }));
                            refreshComposerState();
                        }

                    } else {
                        clearDatasetState(currentChat);

                        const fullData = await extractTextFromUploadedFile(file);
                        const MAX_CHARS = 60000;
                        const clipped =
                            fullData.length > MAX_CHARS
                                ? fullData.slice(0, MAX_CHARS) + `\n\n[TRUNCATED: ${fullData.length - MAX_CHARS} chars omitted]`
                                : fullData;

                        fileContext =
                            `--- SYSTEM FILE CONTENT ATTACHED ---\n` +
                            `File Name: ${file.name}\n` +
                            `Data Content:\n${clipped}\n` +
                            `--- END FILE CONTENT ---`;

                        if (currentChat) {
                            currentChat.fileContext = fileContext;
                            currentChat.fileName = file.name;
                            currentChat.updatedAt = Date.now();
                            saveChats();
                        }
                    }

                } catch (err) {
                    console.error("Failed to read attachment:", err);
                    // Use buildFileContextFromText so the error arrives in the same structured
                    // format as all other file contexts — the AI can read and report it clearly.
                    fileContext = buildFileContextFromText(
                        file.name,
                        `[FILE_READ_ERROR]\nFile: ${file.name}\nReason: ${err.message}\nInstruction: Clearly inform the user that this file could not be read and suggest a remedy (e.g., re-upload as a text-based PDF or a different format).`
                    );

                    if (currentChat) {
                        currentChat.fileContext = fileContext;
                        currentChat.fileName = file.name;
                        currentChat.updatedAt = Date.now();
                        saveChats();
                    }
                }
            }
        }

        if (!text && !attachments.length) return;

        if (!getActiveChat()) newChat();
        currentChat = getActiveChat();

        state.pendingAttachments = [];
        renderAttachmentTray();
        el.prompt.value = "";
        el.prompt.dispatchEvent(new Event('input', { bubbles: true }));

        el.prompt.style.height = "auto";

        const firstAttachmentName =
            attachments?.[0]?.name ||
            attachments?.[0]?.file?.name ||
            attachments?.[0]?.fileObj?.name ||
            attachments?.[0]?.blob?.name ||
            "attachment";

        const userContent = text || (attachments.length ? `Uploaded ${firstAttachmentName}` : "");
        pushMessage("user", userContent, false);
        setBusy(true);

        // ── Streaming assistant setup ─────────────────────────────────────────────
        currentChat = getActiveChat();
        currentChat.messages.push({
            role: "assistant",
            content: "",
            markdown: true,
            ts: Date.now(),
            _streaming: true
        });
        currentChat.updatedAt = Date.now();
        saveChats();
        const assistantMsgIndex = currentChat.messages.length - 1;

        let firstChunkReceived = false;
        let thinkingText = "";
        const thinkingStartTime = Date.now();

        // create the real streaming DOM node
        const streamingNode = createStreamingNode();
        el.messages?.appendChild(streamingNode);
        scrollToBottom(true);

        const streamBubble =
            streamingNode.querySelector(".message__bubble") ||
            streamingNode.querySelector(".messagebubble") ||
            streamingNode.querySelector(".bubble") ||
            null;

        // Debounced live markdown render — fires every ~120ms so the user sees
        // formatted text (headers, bullets, bold, code) while it streams in.
        // Uses an inner wrapper div so the outer bubble (with its background)
        // is never nuked — this eliminates the white-flash / blink on each update.
        let _renderTimer = null;
        let _latestText = "";

        // Create stable inner wrapper once — never destroy it
        const _streamInner = document.createElement('div');
        _streamInner.className = 'axi-stream-inner';
        const _streamCursor = document.createElement('span');
        _streamCursor.className = 'axi-stream-cursor';
        if (streamBubble) {
            streamBubble.appendChild(_streamInner);
            streamBubble.appendChild(_streamCursor);
        }

        function _scheduleRender(text) {
            _latestText = text;
            if (_renderTimer) return;
            _renderTimer = setTimeout(() => {
                _renderTimer = null;
                if (!streamBubble) return;
                try {
                    let html = (typeof marked !== "undefined")
                        ? ((typeof DOMPurify !== "undefined")
                            ? DOMPurify.sanitize(marked.parse(_latestText))
                            : marked.parse(_latestText))
                        : _latestText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                    // ✅ Only update the inner wrapper — outer bubble stays intact, no flash
                    _streamInner.innerHTML = html;
                } catch (_) {
                    _streamInner.textContent = _latestText;
                }
                if (isNearBottom(el.messages, 220)) scrollToBottom();
            }, 120);
        }


        const streamCallbacks = {
            onChunk(chunk, fullText) {
                if (!firstChunkReceived) {
                    firstChunkReceived = true;
                    if (thinkingText.trim()) {
                        // Real reasoning tokens arrived (Anthropic, o1, DeepSeek R1, etc.)
                        const duration = ((Date.now() - thinkingStartTime) / 1000).toFixed(1);
                        _finalizeThinkingBlock(streamingNode, thinkingText, duration);
                    } else {
                        // Provider doesn't expose thinking tokens (standard OpenAI, Gemini, etc.)
                        // — silently remove the block so nothing awkward shows
                        streamingNode.querySelector('.axi-thinking-block')?.remove();
                    }
                }
                _scheduleRender(fullText);
            },
        };

        try {
            const history = currentChat.messages
                .filter((m, i) => i !== assistantMsgIndex)
                .map(m => ({ role: m.role, content: m.content }));

            // ── Context-window guard ────────────────────────────────────────────
            // Detect follow-up BEFORE any system messages are prepended.
            const _isConvFollowUp = history.filter(function (m) {
                return m.role !== 'system';
            }).length > 1;

            // Keep the most-recent 20 conversational messages.
            const _AXI_MAX_CONV_MSGS = 20;
            if (history.length > _AXI_MAX_CONV_MSGS) {
                history.splice(0, history.length - _AXI_MAX_CONV_MSGS);
            }

            // Truncate large individual messages (first analysis response can be 100k+ chars).
            const _AXI_MAX_MSG_CHARS = 12000;
            history.forEach(function (m) {
                if (m.content && m.content.length > _AXI_MAX_MSG_CHARS) {
                    m.content = m.content.slice(0, _AXI_MAX_MSG_CHARS) +
                        '\n[…truncated to fit context window]';
                }
            });

            // If applyPin ran before buildActiveDataBinAiPayload was ready, build it now.
            if (!window.ACTIVEDATABINAIPAYLOAD && window.ACTIVEDATABINCONTEXT &&
                typeof window.buildActiveDataBinAiPayload === 'function') {
                try {
                    window.ACTIVEDATABINAIPAYLOAD = await window.buildActiveDataBinAiPayload(window.ACTIVEDATABINCONTEXT);
                } catch (e) {
                    console.warn('[AXI] on-demand payload build failed', e);
                }
            }

            const activeDataBinAiPayload =
                !attachments.length && window.ACTIVEDATABINAIPAYLOAD
                    ? window.ACTIVEDATABINAIPAYLOAD
                    : null;

            // ── Chip file target ─────────────────────────────────────────────────
            // Set by renderFilePills when a specific file pill is clicked.
            // Single-use: consumed here and cleared so normal sends are unaffected.
            const _chipTarget = window._axiChipFileTarget || null;
            window._axiChipFileTarget = null;

            // Detect if the user is asking about a specific datasource by name
            const _allDsNames = activeDataBinAiPayload
                ? (activeDataBinAiPayload.datasources || []).map(function (d) {
                    return { key: d.meta?.sourceName || d.name || '', unit: d };
                })
                : [];

            const _mentionedDs = _allDsNames.length > 1
                ? _allDsNames.find(function (d) {
                    return d.key && new RegExp('\\b' + d.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text);
                })
                : null;
            // When a chip targets a specific file (or all files), restrict the payload
            // to only that file's units — no datasource chunks, no combined summary.
            // This prevents the "Analyze all together" rule from overriding the user's
            // intent to analyze a specific file.
            const _binPayload = !activeDataBinAiPayload ? null
                : (_chipTarget || _mentionedDs) ? {
                    ...activeDataBinAiPayload,
                    datasources: _mentionedDs
                        ? [_mentionedDs.unit]
                        : (_chipTarget === '__all__'
                            ? []   // _fileOnly=true: wipe datasources so the TOON loop sends nothing
                            : (activeDataBinAiPayload.datasources || []).filter(function (fu) { return fu.name === _chipTarget; })),
                    combined: null,
                    files: _chipTarget
                        ? (_chipTarget === '__all__'
                            ? (activeDataBinAiPayload.files || [])
                            : (activeDataBinAiPayload.files || []).filter(function (fu) { return fu.name === _chipTarget; }))
                        : (activeDataBinAiPayload.files || []),
                    _fileOnly: !_mentionedDs && !!_chipTarget,
                    meta: activeDataBinAiPayload.meta ? {
                        ...activeDataBinAiPayload.meta,
                        datasourceCount: _mentionedDs ? 1 : activeDataBinAiPayload.meta.datasourceCount,
                        combinedRowCount: _mentionedDs ? (_mentionedDs.unit.rowCount || 0) : 0,
                        allColumns: _mentionedDs ? (_mentionedDs.unit.columns || []) : []
                    } : activeDataBinAiPayload.meta
                }
                    : activeDataBinAiPayload;

            // Keep file context available even in Data Bin mode
            const effectiveFileContext =
                fileContext || currentChat?.fileContext || activeBinFileContext || "";

            // Shared character budget for all raw TOON / file-text chunks in this request.
            // 1 token ≈ 4 chars; 75 000 tokens * 4 = 300 000 chars.
            // Headroom: meta + conversation + output ≈ 53 000 tokens → total ≤ 128 000.
            // Both the datasource and file loops below decrement this counter; once it
            // hits zero no further chunks are added (schema summaries are always kept).
            const _dsTotal = (_binPayload?.datasources || []).length;
            const _axiToonBudgetPerDs = _dsTotal > 1 ? Math.floor(300000 / _dsTotal) : 300000;
            let _axiToonBudget = 300000;
            const _binId = activeDataBinAiPayload?.id || null;
            const _isBinDataFresh = !_binId || !currentChat._axiSentBinIds?.has(_binId);
            if (_binPayload) {
                const binMessages = [
                    {
                        role: "system",
                        content: _binPayload._fileOnly
                            ? (function () {
                                const _fUnits = _binPayload.files || [];
                                const _fList = _fUnits.map(function (f, i) { return (i + 1) + '. ' + (f.name || 'File ' + (i + 1)); }).join(' | ');
                                return _fUnits.length > 1
                                    ? `FILE ANALYSIS — CRITICAL: You are analyzing ${_fUnits.length} REAL files from the Data Bin ` +
                                    `"${_binPayload.meta?.name || "Data Bin"}". ` +
                                    `Files present: ${_fList}. ` +
                                    `You MUST analyze EVERY file listed — do NOT stop after the first. ` +
                                    `File content is provided below as authoritative data.`
                                    : `FILE ANALYSIS — CRITICAL: You are analyzing a REAL file from the Data Bin ` +
                                    `"${_binPayload.meta?.name || "Data Bin"}". ` +
                                    `The file content is provided below as authoritative data. ` +
                                    `Do NOT reference or include any database/datasource content in this response. ` +
                                    `Focus exclusively on the file(s) specified by the user.`;
                            })()
                            : (function () {
                                const srcNames = (_binPayload.datasources || [])
                                    .map(function (ds) { return ds.meta?.sourceName || ds.name || "unnamed"; });
                                const srcList = srcNames.length
                                    ? srcNames.map(function (n, i) { return (i + 1) + '. ' + n; }).join(' | ')
                                    : "1 source";
                                return `DATA PROVENANCE — CRITICAL: You are analyzing ${srcNames.length || 1} REAL, live datasource(s) ` +
                                    `from the Data Bin "${_binPayload.meta?.name || "Data Bin"}" fetched live from Axpert. ` +
                                    `Sources present: ${srcList}. ` +
                                    `Total records across all sources: ${_binPayload.meta?.combinedRowCount ?? "?"}. ` +
                                    `This data is NOT fabricated, estimated, or invented. ` +
                                    `You MUST analyze EVERY source listed above in your response — ` +
                                    `do not stop after the first source. ` +
                                    `If the user asks you to prove authenticity, state that all data was fetched live from Axpert.`;
                            })()
                    },
                    {
                        role: "system",
                        content: "ACTIVE DATA BIN METADATA " + JSON.stringify(_binPayload.meta)
                    },
                    {
                        role: "system",
                        content: _binPayload._fileOnly
                            ? (function () {
                                const _fUnits = _binPayload.files || [];
                                const _fNames = _fUnits.map(function (f, i) { return (i + 1) + '. "' + (f.name || 'File ' + (i + 1)) + '"'; }).join('  ');
                                const multiFileRule = _fUnits.length > 1
                                    ? 'This bin contains ' + _fUnits.length + ' files: ' + _fNames + '. ' +
                                    'You MUST produce a separate ## section for EACH file. Do NOT skip any. '
                                    : '';
                                return 'FILE ANALYSIS RULES — ' + multiFileRule +
                                    'For EACH file section you MUST: ' +
                                    '(1) State what the file contains and its row/record count. ' +
                                    '(2) Give a concise 2-3 sentence insight from the actual content — key patterns, notable values, or findings. ' +
                                    '(3) If the file has numeric columns suitable for a chart, include ONE chart using the CHART PROTOCOL JSON block. ' +
                                    '(4) End with 1-2 bullet "Key Findings" grounded in the actual data. ' +
                                    'TOON blocks are authoritative raw data — use actual values. ' +
                                    'Never invent fields, values, or missing facts. ' +
                                    'If something is absent, say: Not available in the uploaded file.';
                            })()
                            : (function () {
                                const _ds = (_binPayload.datasources || []);
                                const nameList = _ds.map(function (d, i) {
                                    return (i + 1) + '. "' + (d.meta?.sourceName || d.name || 'Source ' + (i + 1)) + '"';
                                }).join('  ');
                                const multiRule = _ds.length > 1
                                    ? 'This bin contains ' + _ds.length + ' datasources: ' + nameList + '. ' +
                                    'You MUST produce a separate ## section for EACH datasource. Do NOT skip any. '
                                    : '';
                                return 'ACTIVE DATA BIN RULES — ' + multiRule +
                                    'For EACH datasource section you MUST: ' +
                                    '(1) State row count and a brief description of what the data represents. ' +
                                    '(2) Give a concise 2-3 sentence insight — key patterns, notable values, or anomalies from the actual rows. Do NOT just list column names. ' +
                                    '(3) If the data has numeric or categorical columns suitable for a chart, include ONE chart using the CHART PROTOCOL JSON block. ' +
                                    '(4) End with 1-2 bullet "Key Findings" grounded in the actual data. ' +
                                    'After all datasource sections, add a ## Summary section with cross-source observations if relevant. ' +
                                    'TOON blocks are the authoritative raw data — use actual values, not column names. ' +
                                    'Never invent values. If a value is absent, say: Not available in the data.';
                            })()
                    }
                ];

                // Only inject combined summary for single-source bins.
                // With multiple sources, it collapses all data into one blob and the AI
                // treats it as the sole dataset, ignoring the per-source blocks below.
                const _dsCount = (_binPayload.datasources || []).length;
                if (_binPayload.combined?.llmPayload && _dsCount <= 1) {
                    binMessages.push({
                        role: "system",
                        content: "ACTIVE DATA BIN COMBINED SUMMARY " + JSON.stringify(_binPayload.combined.llmPayload)
                    });
                }

                (_binPayload.datasources || []).forEach(function (ds) {
                    binMessages.push({
                        role: "system",
                        content: "DATA BIN DATASOURCE SUMMARY " + JSON.stringify({
                            name: ds.meta?.sourceName || ds.name,
                            caption: ds.meta?.sourceCaption || ds.name,
                            rowCount: ds.rowCount,
                            columns: ds.columns
                        })
                    });

                    let _dsToonBudget = _axiToonBudgetPerDs;
                    (ds.toonChunks || []).forEach(function (chunk, idx) {

                        if (_dsToonBudget <= 0) return;
                        const msg = "DATA BIN DATASOURCE TOON [" +
                            String(ds.meta?.sourceName || ds.name) +
                            "] chunk " + (idx + 1) + "/" + ds.toonChunks.length +
                            "\n" + chunk;
                        binMessages.push({ role: "system", content: msg });
                        _dsToonBudget -= msg.length;
                        _axiToonBudget -= msg.length;
                    });
                });

                (_binPayload.files || []).forEach(function (fileUnit) {
                    if (fileUnit.kind === "dataset") {
                        binMessages.push({
                            role: "system",
                            content: "DATA BIN FILE DATASET SUMMARY " + JSON.stringify({
                                name: fileUnit.name,
                                fileType: fileUnit.meta?.fileType || fileUnit.fileType || "",
                                rowCount: fileUnit.rowCount,
                                columns: fileUnit.columns,
                                llmPayload: fileUnit.llmPayload || null
                            })
                        });

                        (fileUnit.toonChunks || []).forEach(function (chunk, idx) {

                            if (_axiToonBudget <= 0) return;
                            const msg = "DATA BIN FILE TOON [" +
                                String(fileUnit.name) +
                                "] chunk " + (idx + 1) + "/" + fileUnit.toonChunks.length +
                                "\n" + chunk;
                            binMessages.push({ role: "system", content: msg });
                            _axiToonBudget -= msg.length;
                        });

                        return;
                    }

                    (fileUnit.textChunks || []).forEach(function (chunk, idx) {

                        if (_axiToonBudget <= 0) return;
                        const msg = "DATA BIN FILE TEXT [" +
                            String(fileUnit.name) +
                            "] chunk " + (idx + 1) + "/" + fileUnit.textChunks.length +
                            "\n" + chunk;
                        binMessages.push({ role: "system", content: msg });
                        _axiToonBudget -= msg.length;
                    });
                });
                console.log('[AXI DEBUG]', 'datasources:', (_binPayload.datasources || []).length, (_binPayload.datasources || []).map(d => d.name), '| binMessages:', binMessages.length, '| isConvFollowUp:', _isConvFollowUp, '| toonBudgetPerDs:', _axiToonBudgetPerDs);
                history.unshift(...binMessages);
                if (activeDataBinAiPayload && (_binPayload.datasources || []).length > 1) {
                    const _dsNames = (_binPayload.datasources || []).map(function (d) {
                        return d.meta?.sourceName || d.name || 'Unnamed';
                    });
                    history.push({
                        role: "system",
                        content: "MANDATORY RESPONSE FORMAT — Your response is INCOMPLETE unless it contains " +
                            "ALL of the following sections in this exact order:\n" +
                            _dsNames.map(function (n, i) { return "## " + (i + 1) + ". " + n; }).join("\n") + "\n" +
                            "## Summary\n\n" +
                            "Each section MUST contain: a 2-3 sentence insight from actual data values, " +
                            "at least one key finding, and a chart if numeric data is available. " +
                            "Do NOT merge sections. Do NOT omit any section. " +
                            "A response covering only " + _dsNames[0] + " is WRONG."
                    });
                }

                if (_binPayload._fileOnly && (_binPayload.files || []).length > 1) {
                    const _fNames = (_binPayload.files || []).map(function (f, i) {
                        return '## ' + (i + 1) + '. ' + (f.name || 'File ' + (i + 1));
                    });
                    history.push({
                        role: "system",
                        content: "MANDATORY RESPONSE FORMAT — Your response is INCOMPLETE unless it contains " +
                            "ALL of the following sections in this exact order:\n" +
                            _fNames.join("\n") + "\n" +
                            "## Summary\n\n" +
                            "Each section MUST contain: a 2-3 sentence insight from actual file content, " +
                            "at least one key finding, and a chart if numeric data is available. " +
                            "Do NOT merge sections. Do NOT omit any file. " +
                            "A response covering only " + (_binPayload.files[0]?.name || 'the first file') + " is WRONG."
                    });
                }

            }


            const activeFileName = String(currentChat?.fileName || firstAttachmentName || "");
            const activeExt = extOf(activeFileName);
            const isDocumentFile = activeExt === "pdf" || activeExt === "docx";

            if (isDocumentFile) {
                history.unshift({
                    role: "system",
                    content:
                        "DOCUMENT METADATA:\n" +
                        JSON.stringify({
                            fileName: activeFileName,
                            fileType: activeExt,
                            extractedPageCount: activeExt === "pdf"
                                ? getPdfMetaFromContext(activeFileName, effectiveFileContext).extractedPageCount
                                : null
                        })
                });

                history.unshift({
                    role: "system",
                    content: [
                        "DOCUMENT REPORT PROTOCOL (CRITICAL)",
                        "Return a polished markdown report using exactly these sections:",
                        "## Executive Summary",
                        "## Document Overview",
                        "## Key Findings",
                        "## Extracted Data",
                        "## Recommendations",
                        "## Data Confidence",
                        "",
                        "Rules:",
                        "- Use only the document text already provided in FILE CONTEXT.",
                        "- If the FILE CONTEXT contains a '[PDF_EXTRACTION_NOTICE]' or a read-error message, clearly explain the situation to the user (e.g., scanned PDF, no selectable text) and suggest corrective action. Otherwise, do not claim you cannot access the file — the extracted text is already present in FILE CONTEXT.",
                        "- Treat DOCX and PDF the same way for analysis.",
                        "- In Document Overview, mention the file type and page count if available.",
                        "- In Key Findings, give concrete insights grounded in the extracted text.",
                        "- In Extracted Data, include a markdown table with exactly 2 columns: Field | Value.",
                        "- Prefer exact dates, names, amounts, counts, totals, headings, and section names when present.",
                        "- If a value is not present, say: Not available in the uploaded file/data.",
                        "- If the document contains enough numeric or category data, include 1 or 2 charts using the existing CHART PROTOCOL JSON code block.",
                        "- If the document is mostly narrative and a chart is not justified, do not invent one.",
                        "- Keep the response concise, analytical, and grounded."
                    ].join("\n")
                });
            }

            const hasDatasetContext =
                !effectiveFileContext &&
                !activeDataBinAiPayload &&          // ← ADD THIS LINE
                (
                    (window.pendingDatabaseData &&
                        Array.isArray(window.pendingDatabaseData.data) &&
                        window.pendingDatabaseData.data.length) ||
                    (Array.isArray(currentChat?.datasetRows) && currentChat.datasetRows.length)
                );
            const allowedCols = hasDatasetContext
                ? (
                    (currentChat?.datasetProfile?.columns && Array.isArray(currentChat.datasetProfile.columns))
                        ? currentChat.datasetProfile.columns.map(String)
                        : (Array.isArray(currentChat?.datasetRows) && currentChat.datasetRows.length)
                            ? Object.keys(currentChat.datasetRows[0] || {}).map(String)
                            : []
                )
                : [];

            if (hasDatasetContext && allowedCols.length) {
                history.unshift({
                    role: "system",
                    content:
                        `ALLOWED_COLUMNS (exact):\n` +
                        `${allowedCols.join(", ")}\n\n` +
                        `Rules:\n` +
                        `- When you mention any column/field from the dataset, you MUST wrap the exact column name in backticks, like \`ColumnName\`.\n` +
                        `- You are NOT allowed to invent or infer new columns.\n` +
                        `- If the user asks for something requiring a column not in ALLOWED_COLUMNS, say: "Not available in the uploaded file/data."`
                });
            }

            if (
                hasDatasetContext &&
                Array.isArray(currentChat?.datasetRows) &&
                currentChat.datasetRows.length
            ) {
                const profile = currentChat.datasetProfile || buildProfile(currentChat.datasetRows);
                const aggregates = currentChat.datasetAggregates || buildAggregates(currentChat.datasetRows);
                const payload = buildLLMPayload(
                    currentChat.datasetFileName || "dataset",
                    currentChat.datasetRows,
                    profile,
                    aggregates
                );

                history.unshift({
                    role: "system",
                    content: "DATASET SAFETY:\n" + JSON.stringify(
                        buildDatasetSafetyContext(currentChat.datasetRows, profile)
                    )
                });

                history.unshift({
                    role: "system",
                    content: "DATASET PAYLOAD (schema, aggregates, sampleRows):\n" + JSON.stringify(payload)
                });
            }

            if (effectiveFileContext) {
                history.unshift({ role: "system", content: effectiveFileContext });
            }

            if (typeof SYSTEM_PROMPT_CHARTS !== 'undefined') {
                history.unshift({ role: "system", content: SYSTEM_PROMPT_CHARTS });
            }

            // UNIVERSAL FOLLOW-UP DETECTION:
            // history[0] is the current question. If history.length > 1, this is a follow-up!
            const isFollowUp = history.length > 1;

            if (!isFollowUp) {
                // STRICT MODE: Only for the very first file analysis
                history.unshift({
                    role: "system",
                    content: `You MUST answer only using the provided FILE/DATASET CONTEXT. If the answer is not in the context, say "Not available in the uploaded file/data." Do not guess or invent values.`.trim()
                });
            } else {
                // CONVERSATIONAL MODE: For all subsequent questions in the chat
                history.unshift({
                    role: "system",
                    content: `You are engaging in a continuous data conversation. You MUST use the conversation history to answer questions, explain charts, and discuss trends. Do NOT say "Not available" if the information can be deduced from the chat history or previous JSON charts you generated.`.trim()
                });
            }

            const previousPendingDatabaseData = window.pendingDatabaseData;
            const usingActiveDataBin = !!activeDataBinAiPayload;

            if (usingActiveDataBin) {
                window.pendingDatabaseData = null;
            }

            let rawAnswer;
            try {
                if (usingActiveDataBin) {
                    // Bypass callOpenAI — it has its own pipeline that rebuilds messages
                    // from pendingDatabaseData and ignores our bin context entirely.
                    if (typeof streamCallbacks?.onChunk === 'function') {
                        rawAnswer = await withRetry(() => axiChatCompletionStream({
                            messages: history,
                            temperature: 0.3,
                            maxtokens: 4000,
                            onChunk: streamCallbacks.onChunk,
                            onThinking: streamCallbacks?.onThinking
                        }));
                    } else {
                        rawAnswer = await withRetry(() => axiChatCompletion({ messages: history, temperature: 0.3, max_tokens: 4000 }));
                    }
                } else {
                    rawAnswer = await callOpenAI(history, null, streamCallbacks);
                }
            } finally {
                if (usingActiveDataBin) {
                    window.pendingDatabaseData = previousPendingDatabaseData;
                }
            }

            // Cancel any pending debounced render — _finalizeStreamNode does the final pass
            if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }

            // If streaming never fired (e.g. MCP fallback), do a bulk render now
            if (!firstChunkReceived && rawAnswer) {
                const streamedText = typeof rawAnswer === "string" ? rawAnswer : JSON.stringify(rawAnswer || "");
                _updateStreamBubble(streamBubble, streamedText);
                const duration = ((Date.now() - thinkingStartTime) / 1000).toFixed(1);
                _finalizeThinkingBlock(streamingNode, thinkingText, duration);
            }

            const answer = (typeof rawAnswer === "string")
                ? rawAnswer
                : JSON.stringify(rawAnswer || "No response received.");

            let finalContent = answer;
            let chartDataList = [];

            const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/gi;
            let match;
            while ((match = jsonBlockRegex.exec(answer)) !== null) {
                try {
                    const jsonStr = match[1];
                    const parsed = JSON.parse(jsonStr);
                    if (parsed.chart) chartDataList.push(parsed.chart);
                    else if (parsed.charts && Array.isArray(parsed.charts)) {
                        parsed.charts.forEach(item => chartDataList.push(item.chart || item));
                    }
                    finalContent = finalContent.replace(match[0], "");
                } catch (e) { }
            }
            // PATCH: handle "Report\nDASHBOARD\nCharts: [{chart:{...}, summary:"..."}]" format
            // This catches ALL template responses that come back in this raw format
            if (chartDataList.length === 0 && /Charts\s*:/i.test(answer)) {
                try {
                    const dashMatch = answer.match(/Charts\s*:\s*(\[[\s\S]*\])/i);
                    if (dashMatch) {
                        const items = JSON.parse(dashMatch[1]);
                        if (Array.isArray(items)) {
                            items.forEach(item => {
                                const spec = item.chart || item;
                                if (spec && spec.type) {
                                    if (item.summary) spec._summary = item.summary;
                                    chartDataList.push(spec);
                                }
                            });
                            // Strip the raw header so the bubble shows clean markdown
                            finalContent = finalContent
                                .replace(/^Report\s*[\r\n]*/i, '')
                                .replace(/^DASHBOARD\s*[\r\n]*/i, '')
                                .replace(/Charts\s*:\s*\[[\s\S]*\]/i, '')
                                .trim();
                            if (!finalContent) finalContent = '## 📊 Dashboard';
                        }
                    }
                } catch (e) { /* malformed – leave as-is */ }
            }

            // PATCH: handle "Section Name: {JSON}" inline format from template responses
            {
                const inlineParsed = parseInlineJsonSections(finalContent);
                if (inlineParsed && inlineParsed.markdown) {
                    finalContent = inlineParsed.markdown;
                    chartDataList.push(...inlineParsed.charts);
                }
            }

            if (chartDataList.length === 0 && answer.trim().startsWith("{")) {
                let parsed = null;
                try {
                    parsed = JSON.parse(answer);
                } catch (e) {
                    try { parsed = JSON.parse(sanitizeJsonString(answer)); } catch (e2) { }
                }

                if (parsed) {
                    const reportContent = parsed.report || parsed;
                    // Named-section format: { report: { "Executive Overview": ..., "Key Findings": ..., ... } }
                    const looksLikeNamedSection = Object.keys(reportContent).some(k =>
                        /overview|findings|anomal|risk|recommendation/i.test(k)
                    );

                    if (looksLikeNamedSection) {
                        const result = convertNamedSectionReport(parsed);
                        if (result) {
                            finalContent = result.markdown;
                            chartDataList.push(...result.charts);
                        }
                    } else if (reportContent.summary || reportContent.insights || (reportContent.recommendations && !reportContent.chart && !reportContent.charts)) {
                        // Legacy report JSON — convert to markdown
                        const reportMarkdown = convertReportJsonToMarkdown(parsed);
                        if (reportMarkdown) {
                            finalContent = reportMarkdown;
                            if (reportContent.charts && Array.isArray(reportContent.charts)) {
                                reportContent.charts.forEach(item => {
                                    if (item.chart) chartDataList.push(item.chart);
                                    else if (item.type) chartDataList.push(item);
                                });
                            }
                        }
                    } else if (parsed.chart || parsed.charts) {
                        // Regular chart JSON
                        if (parsed.chart) chartDataList.push(parsed.chart);
                        else if (parsed.charts) chartDataList.push(...parsed.charts.map(c => c.chart || c));
                        finalContent = `**Analysis Complete**\n\nGenerated ${chartDataList.length} chart(s).`;
                    } else {
                        // Unknown JSON format - convert to readable markdown anyway
                        const unknownMarkdown = convertUnknownJsonToMarkdown(parsed);
                        if (unknownMarkdown) {
                            finalContent = unknownMarkdown;
                        }
                    }
                }
            }

            // Also check for JSON anywhere in the response (not just at start)
            if (!finalContent || finalContent === answer) {
                const jsonMatch = answer.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    try {
                        const parsed = JSON.parse(jsonMatch[0]);
                        const reportContent = parsed.report || parsed;
                        if (reportContent.summary || reportContent.insights || reportContent.recommendations) {
                            const reportMarkdown = convertReportJsonToMarkdown(parsed);
                            if (reportMarkdown) {
                                finalContent = reportMarkdown;
                            }
                        }
                    } catch (e) { }
                }
            }

            // Strip any leading "Report\n" or "DASHBOARD\n" lines the AI may prepend (handle multiple)
            finalContent = finalContent.replace(/^(?:(?:Report|DASHBOARD)\s*[\r\n]+)+/gi, '').trim();

            // Last-resort: if content still has "SectionName: {json}" lines, convert them
            // Also handles bullet-prefixed lines like "* Executive Overview: {json}"
            if (/^[\*\-]?\s*[A-Za-z][\w\s&]+:\s*[{\[]/m.test(finalContent)) {
                const lastResort = parseInlineJsonSections(finalContent);
                if (lastResort && lastResort.markdown) {
                    finalContent = lastResort.markdown;
                    chartDataList.push(...lastResort.charts);
                }
            }

            finalContent = finalContent.trim();

            currentChat.messages[assistantMsgIndex].content = finalContent;
            currentChat.messages[assistantMsgIndex].markdown = true;
            currentChat.messages[assistantMsgIndex].ts = Date.now();
            delete currentChat.messages[assistantMsgIndex]._streaming;
            if (chartDataList.length > 0) {
                currentChat.messages[assistantMsgIndex].chartSpecs = chartDataList;
            }

            saveChats();

            // Finalize the streaming node in-place (no full renderThread re-render)
            const duration = ((Date.now() - thinkingStartTime) / 1000).toFixed(1);
            _finalizeThinkingBlock(streamingNode, thinkingText, duration);
            _finalizeStreamNode(streamingNode, streamBubble, finalContent, chartDataList);

            scrollToBottom(true);
            requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom(true)));

            setTimeout(() => {
                const lastBubble = streamBubble;

                if (finalContent.length > 50 && typeof renderReportActions === "function") {
                    renderReportActions(lastBubble, finalContent);
                }

                scrollToBottom(true);

                const lastUserMsg = currentChat.messages
                    .filter(m => m.role === "user")
                    .slice(-1)[0]?.content || "";

                const messageNode = streamingNode;

                generateFollowUpSuggestions(lastUserMsg, finalContent).then(suggestions => {
                    if (suggestions.length > 0 && messageNode) {
                        renderFollowUpSuggestions(messageNode, suggestions);
                        scrollToBottom(false);
                    }
                });
            }, 150);

        } catch (err) {
            console.error("HandleSend Error:", err);
            const errMsg = `Error: ${err.message}`;
            currentChat.messages[assistantMsgIndex].content = errMsg;
            delete currentChat.messages[assistantMsgIndex]._streaming;
            saveChats();
            // Show error in the streaming bubble directly
            if (streamBubble) {
                const retryId = `_axiRetry_${Date.now()}`;
                streamBubble.innerHTML = `
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <span style="color:#ef4444">${axiEscHtml(errMsg)}</span>
                <button id="${retryId}" type="button" style="padding:5px 13px;border-radius:8px;border:1.5px solid #fca5a5;background:#fef2f2;color:#dc2626;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .15s;">↺ Retry</button>
              </div>`;
                document.getElementById(retryId)?.addEventListener('click', () => {
                    const chat2 = typeof getActiveChat === 'function' ? getActiveChat() : null;
                    const lastUser = (chat2?.messages || []).filter(m => m.role === 'user').slice(-1)[0]?.content || '';
                    if (chat2?.messages) {
                        const len = chat2.messages.length;
                        if (len >= 2) chat2.messages.splice(len - 2, 2);
                        else if (len === 1) chat2.messages.splice(0, 1);
                        chat2.updatedAt = Date.now();
                        if (typeof saveChats === 'function') saveChats();
                    }
                    if (typeof renderThread === 'function') renderThread();
                    const p = document.getElementById('prompt');
                    if (p && lastUser) { p.value = lastUser; p.dispatchEvent(new Event('input', { bubbles: true })); }
                    setTimeout(() => { if (typeof handleSend === 'function') handleSend(); }, 80);
                });
                const cursor = streamBubble.querySelector('.axi-stream-cursor');
                if (cursor) cursor.remove();
            }
            const thinkBlock = streamingNode?.querySelector('.axi-thinking-block');
            if (thinkBlock) {
                thinkBlock.classList.remove('axi-thinking-block--active');
                thinkBlock.classList.add('axi-thinking-block--error');
                const hdr = thinkBlock.querySelector('.axi-thinking-label');
                if (hdr) hdr.textContent = 'Failed';
            }
            scrollToBottom(true);
        } finally {
            setBusy(false);
            if (typeof syncComposerButtons === "function") syncComposerButtons();
        }
    }


    function initHeaderActions() {
        const btnLinks = document.querySelector('.headerBtn[title="Links"]');
        const btnImages = document.querySelector('.headerBtn[title="Images"]');
        const btnVideos = document.querySelector('.headerBtn[title="Videos"]');
        const btnMenu = document.querySelector('.iconBtn[title="Menu"]');
        const btnShare = document.querySelector(".shareBtn");
        const modelToggle = document.querySelector(".modelToggle");

        if (!btnLinks && !btnImages && !btnVideos && !btnMenu && !btnShare && !modelToggle) return;

        btnLinks?.addEventListener("click", () => openHeaderDrawer("links"));
        btnImages?.addEventListener("click", () => openHeaderDrawer("images"));
        btnVideos?.addEventListener("click", () => openHeaderDrawer("videos"));
        btnMenu?.addEventListener("click", () => openHeaderDrawer("menu"));
        btnShare?.addEventListener("click", () => handleShareActiveChat());
        modelToggle?.addEventListener("click", () => openHeaderDrawer("models"));
    }

    function ensureHeaderDrawerEls() {
        const root = document.getElementById("headerDrawer");
        const titleEl = document.getElementById("headerDrawerTitle");
        const bodyEl = document.getElementById("headerDrawerBody");
        if (!root || !titleEl || !bodyEl) throw new Error("headerDrawer elements missing");

        // Close handlers (once)
        if (!root.dataset.wired) {
            root.dataset.wired = "1";
            root.addEventListener("click", (e) => {
                const t = e.target;
                if (t && t.dataset && t.dataset.close) closeHeaderDrawer();
            });
            document.addEventListener("keydown", (e) => {
                if (e.key === "Escape") closeHeaderDrawer();
            });
        }

        return { root, titleEl, bodyEl };
    }

    function openHeaderDrawer(kind) {
        const { root, titleEl, bodyEl } = ensureHeaderDrawerEls();
        const chat = getActiveChat(); // from your existing code [file:126]
        const resources = collectChatResources(chat);

        root.classList.remove("headerDrawer--hidden");
        root.setAttribute("aria-hidden", "false");

        if (kind === "links") {
            titleEl.textContent = `Links (${resources.links.length})`;
            bodyEl.innerHTML = renderLinksList(resources.links);
            return;
        }

        if (kind === "images") {
            titleEl.textContent = `Images (${resources.images.length})`;
            bodyEl.innerHTML = renderImagesGrid(resources.images);
            return;
        }

        if (kind === "videos") {
            titleEl.textContent = `Videos (${resources.videos.length})`;
            bodyEl.innerHTML = renderLinksList(resources.videos);
            return;
        }

        if (kind === "menu") {
            titleEl.textContent = "Menu";
            bodyEl.innerHTML = `
          <div class="drawerActions">
            <button class="drawerBtn" type="button" data-action="export-pdf">Export as PDF</button>
            <button class="drawerBtn" type="button" data-action="export-md">Export as Markdown</button>
            <button class="drawerBtn" type="button" data-action="export-docx">Export as DOCX</button>
      
            <div style="height:10px"></div>
      
            <button class="drawerBtn" type="button" data-action="export-json">Export chat JSON</button>
            <button class="drawerBtn" type="button" data-action="clear">Clear current chat</button>
          </div>
        `;

            bodyEl.querySelector('[data-action="export-pdf"]')?.addEventListener("click", async () => {
                await exportActiveChatPdf();
                closeHeaderDrawer();
            });

            bodyEl.querySelector('[data-action="export-md"]')?.addEventListener("click", async () => {
                await exportActiveChatMarkdown();
                closeHeaderDrawer();
            });

            bodyEl.querySelector('[data-action="export-docx"]')?.addEventListener("click", async () => {
                await exportActiveChatDocx();
                closeHeaderDrawer();
            });

            bodyEl.querySelector('[data-action="export-json"]')?.addEventListener("click", () => {
                exportActiveChatJson();
                // exportActiveChatJson() already calls closeHeaderDrawer() in your code; ok if double-closed. [file:178]
            });

            bodyEl.querySelector('[data-action="clear"]')?.addEventListener("click", () => {
                window.axiClearChat();
                closeHeaderDrawer();
            });

            return;
        }

        if (kind === "models") {
            titleEl.textContent = "Model (UI)";
            bodyEl.innerHTML = `
        <div class="drawerNote">
          Hook this up to your OpenRouter "model" field if you want true switching.
        </div>
        <div class="drawerActions">
          <button class="drawerBtn" type="button" data-model="Assistant">Assistant</button>
          <button class="drawerBtn" type="button" data-model="Analyst">Analyst</button>
        </div>
      `;

            bodyEl.querySelectorAll("[data-model]").forEach((b) => {
                b.addEventListener("click", () => {
                    const name = b.getAttribute("data-model");
                    const label = document.querySelector(".modelToggle__name");
                    if (label) label.textContent = name || "Assistant";
                    closeHeaderDrawer();
                });
            });

            return;
        }
    }

    function closeHeaderDrawer() {
        const root = document.getElementById("headerDrawer");
        if (!root) return;
        root.classList.add("headerDrawer--hidden");
        root.setAttribute("aria-hidden", "true");
    }

    // Top-level so it's available immediately — wired to the Clear Chat button in the composer.
    window.axiClearChat = function () {
        const c = getActiveChat();
        if (!c) return;
        if (!confirm('Clear all messages in this chat? This cannot be undone.')) return;
        c.messages = [];
        c.dataset = null;
        c.updatedAt = Date.now();
        saveChats();
        renderThread();
    };

    /* ---------- resource extraction ---------- */

    function collectChatResources(chat) {
        const out = { links: new Set(), images: new Set(), videos: new Set() };
        if (!chat || !Array.isArray(chat.messages)) {
            return { links: [], images: [], videos: [] };
        }

        for (const m of chat.messages) {
            const text = typeof m.content === "string" ? m.content : "";
            for (const u of extractUrls(text)) {
                if (isVideoUrl(u)) out.videos.add(u);
                else if (isImageUrl(u)) out.images.add(u);
                else out.links.add(u);
            }
        }

        return {
            links: Array.from(out.links),
            images: Array.from(out.images),
            videos: Array.from(out.videos),
        };
    }

    function extractUrls(text) {
        const urls = new Set();

        // Markdown images: ![alt](url)
        const mdImg = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/gi;
        for (const m of text.matchAll(mdImg)) urls.add(m[1]);

        // HTML: href/src
        const href = /href=["'](https?:\/\/[^"']+)["']/gi;
        for (const m of text.matchAll(href)) urls.add(m[1]);

        const src = /src=["'](https?:\/\/[^"']+)["']/gi;
        for (const m of text.matchAll(src)) urls.add(m[1]);

        // Plain URLs
        const plain = /(https?:\/\/[^\s)<>"]+)/gi;
        for (const m of text.matchAll(plain)) urls.add(m[1]);

        return Array.from(urls);
    }

    function isImageUrl(u) {
        return /\.(png|jpg|jpeg|gif|webp|svg)(\?|#|$)/i.test(u);
    }

    function isVideoUrl(u) {
        return (
            /(youtube\.com\/watch|youtu\.be\/|vimeo\.com\/)/i.test(u) ||
            /\.(mp4|webm|mov)(\?|#|$)/i.test(u)
        );
    }

    /* ---------- renderers ---------- */

    function renderLinksList(list) {
        if (!list.length) return `<div class="drawerEmpty">Nothing found yet.</div>`;
        const items = list
            .map((u) => {
                let host = "";
                try { host = new URL(u).hostname; } catch { }
                return `
          <a class="drawerLink" href="${u}" target="_blank" rel="noopener noreferrer">
            <div class="drawerLink__url">${u}</div>
            ${host ? `<div class="drawerLink__host">${host}</div>` : ""}
          </a>
        `;
            })
            .join("");
        return `<div class="drawerList">${items}</div>`;
    }

    function renderImagesGrid(list) {
        if (!list.length) return `<div class="drawerEmpty">No images found in this chat.</div>`;
        const items = list
            .map((u) => `<a class="drawerImg" href="${u}" target="_blank" rel="noopener noreferrer"><img src="${u}" alt=""></a>`)
            .join("");
        return `<div class="drawerGrid">${items}</div>`;
    }

    /* ---------- share / export ---------- */

    async function handleShareActiveChat() {
        const chat = getActiveChat();
        if (!chat) return;

        const text = (chat.messages || [])
            .slice(-10)
            .map((m) => `${m.role}: ${String(m.content || "").slice(0, 200)}`)
            .join("\n");

        // Web Share API if available, else copy
        if (navigator.share) {
            await navigator.share({ title: chat.title || "Chat", text, url: location.href });
            return;
        }

        await navigator.clipboard.writeText(text);
        // Optional: show a toast if you have one
    }

    function safeFileName(name) {
        return String(name || "chat")
            .replace(/[\\/:*?"<>|]+/g, "-")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80);
    }

    function stripHtmlToText(s) {
        const str = String(s || "");
        if (!str.trim()) return "";
        const doc = new DOMParser().parseFromString(str, "text/html");
        return (doc.body.textContent || "").trim();
    }

    function downloadBlob(blob, filename) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    function safeFileName(name) {
        return String(name || "chat")
            .replace(/[\\/:*?"<>|]+/g, "-")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80);
    }

    function stripHtmlToText(s) {
        const str = String(s || "");
        if (!str.trim()) return "";
        const doc = new DOMParser().parseFromString(str, "text/html");
        return (doc.body.textContent || "").trim();
    }

    function downloadBlob(blob, filename) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    function chatToMarkdown(chat) {
        const title = chat?.title || "Chat";
        const exportedAt = new Date().toLocaleString();

        const lines = [];
        lines.push(`# ${title}`);
        lines.push(``);
        lines.push(`_Exported: ${exportedAt}_`);
        lines.push(``);
        lines.push(`---`);
        lines.push(``);

        (chat?.messages || []).forEach((m) => {
            const role = m?.role === "assistant" ? "Assistant" : "User";
            const ts = m?.ts ? new Date(m.ts).toLocaleString() : "";
            const heading = ts ? `## ${role} — ${ts}` : `## ${role}`;

            let content = "";
            if (m?.markdown) {
                content = String(m?.content || "");
                if (content.trim().startsWith("<")) {
                    content = stripHtmlToText(content);
                }
            } else {
                const raw = String(m?.content || "");
                content = raw.trim().startsWith("<") ? stripHtmlToText(raw) : raw;
            }

            lines.push(heading);
            lines.push("");
            lines.push(content || "_(No content)_");
            lines.push("");
            lines.push("---");
            lines.push("");
        });

        return lines.join("\n");
    }


    async function exportActiveChatMarkdown() {
        const data = getExportableThread();
        if (!data.messages.length) return alert("No messages found to export.");

        const lines = [];
        lines.push(`# ${data.title}`);
        lines.push(``);
        lines.push(`_Exported: ${data.exportedAt}_`);
        lines.push(``);
        lines.push(`---`);
        lines.push(``);

        data.messages.forEach((m) => {
            const roleLabel = m.role === "assistant" ? "Assistant" : "User";
            const ts = m.ts ? new Date(m.ts).toLocaleString() : (m.tsText || "");
            lines.push(`## ${roleLabel}${ts ? ` — ${ts}` : ""}`);
            lines.push(``);
            lines.push(String(m.content || "").trim() || "—");
            lines.push(``);
            lines.push(`---`);
            lines.push(``);
        });

        const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
        downloadBlob(blob, `${safeFileName(data.title)}.md`);
    }


    async function exportActiveChatPdf() {
        const data = getExportableThread();
        if (!data.messages.length) {
            alert("No messages found to export");
            return;
        }

        const title = data.title;
        const exportedAt = data.exportedAt;
        const messages = data.messages;

        let messagesHtml = "";
        messages.forEach((m) => {
            const roleLabel = m?.role === "assistant" ? "Assistant" : "User";
            const ts = m?.ts ? new Date(m.ts).toLocaleString() : (m?.tsText || "");
            const timestamp = ts
                ? `<div style="color:#6b7280;font-size:11px;margin-bottom:6px;">${escapeHtml(ts)}</div>`
                : "";

            let raw = String(m?.content || "").trim();

            // If markdown, render it to HTML for the PDF window
            let bodyHtml = "";
            if (m?.markdown) {
                bodyHtml = renderMarkdown(raw || "_No content_");
            } else {
                if (raw.startsWith("<")) raw = stripHtmlToText(raw);
                bodyHtml = `<div style="white-space:pre-wrap;word-break:break-word;line-height:1.6;color:#374151">${escapeHtml(raw || "No content")}</div>`;
            }

            messagesHtml += `
              <div style="margin-bottom:24px;padding-bottom:18px;border-bottom:1px solid #e5e7eb">
                <div style="font-weight:600;margin-bottom:4px;color:#111827">${escapeHtml(roleLabel)}</div>
                ${timestamp || ""}
                <div>${bodyHtml}</div>
              </div>
            `;

        });

        const w = window.open("", "_blank");
        if (!w) {
            alert("Popup blocked. Allow popups to export PDF.");
            return;
        }

        w.document.open();
        w.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>${escapeHtml(title)}</title>
          <style>
            @page { margin: 1.5cm; }
            body {
              font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
              padding: 20px;
              color: #111827;
              line-height: 1.6;
              position: relative;
            }
            /* Axpert logo watermark in top-right corner */
            body::before {
              content: "";
              position: fixed;
              top: 20px;
              right: 20px;
              width: 80px;
              height: 80px;
              background-image: url('${logoUrl}');
              background-size: contain;
              background-repeat: no-repeat;
              opacity: 0.3;
              z-index: 1000;
            }
            h1 { margin: 0 0 8px; font-size: 24px; color: #111827; position: relative; z-index: 1; }
            .meta { color: #6b7280; font-size: 12px; margin-bottom: 24px; position: relative; z-index: 1; }
            @media print { 
              body { padding: 0; }
              body::before { position: absolute; }
            }
          </style>
        </head>
        <body>
          <h1>${escapeHtml(title)}</h1>
          <div class="meta">Exported: ${escapeHtml(exportedAt)}</div>
          ${messagesHtml}
          <script>
            window.onload = () => window.print();
          </script>
        </body>
      </html>
    `);
        w.document.close();
    }


    async function exportActiveChatDocx() {
        const data = getExportableThread();
        if (!data.messages.length) {
            alert("No messages found to export");
            return;
        }

        const docxLib = window.docx;
        if (!docxLib) {
            alert(
                "DOCX export requires the docx library. Add:\n" +
                "<script src=\"https://unpkg.com/docx@8.5.0/build/index.umd.js\"></script>"
            );
            return;
        }

        const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docxLib;

        const title = data.title;
        const exportedAt = data.exportedAt;
        const messages = data.messages;

        const children = [];
        children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }));
        children.push(
            new Paragraph({
                children: [new TextRun({ text: `Exported: ${exportedAt}`, color: "6B7280", size: 20 })],
            })
        );
        children.push(new Paragraph(""));

        messages.forEach((m) => {
            const roleLabel = m?.role === "assistant" ? "Assistant" : "User";
            const ts = m?.ts ? new Date(m.ts).toLocaleString() : (m?.tsText || "");
            const heading = ts ? `${roleLabel} — ${ts}` : roleLabel;

            let raw = String(m?.content || "");
            if (raw.trim().startsWith("<")) raw = stripHtmlToText(raw);
            const text = raw || "(No content)";

            children.push(new Paragraph({ text: heading, heading: HeadingLevel.HEADING_2 }));

            // Preserve line breaks in DOCX by splitting into separate paragraphs
            String(text).split(/\r?\n/).forEach((line) => {
                children.push(new Paragraph(line));
            });

            children.push(new Paragraph(""));
        });

        const doc = new Document({ sections: [{ properties: {}, children }] });
        const blob = await Packer.toBlob(doc);
        downloadBlob(blob, `${safeFileName(title)}.docx`);
    }


    function escapeMd(s) {
        return String(s || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
    }

    function tableToMarkdown(tableEl, maxRows = 25) {
        const rows = Array.from(tableEl.querySelectorAll("tr"));
        if (!rows.length) return "";

        const matrix = rows.map((tr) =>
            Array.from(tr.children).map((cell) => escapeMd(cell.innerText || cell.textContent))
        );

        const header = matrix[0];
        const colCount = header.length || Math.max(...matrix.map((r) => r.length));
        const norm = (r) => {
            const out = r.slice(0, colCount);
            while (out.length < colCount) out.push("");
            return out;
        };

        const head = norm(header);
        const sep = new Array(colCount).fill("---");
        const body = matrix.slice(1, 1 + maxRows).map(norm);

        const line = (arr) => `| ${arr.join(" | ")} |`;

        return [line(head), line(sep), ...body.map(line)].join("\n");
    }



    function exportActiveChatJson() {
        const chat = getActiveChat();
        if (!chat) return;

        const blob = new Blob([JSON.stringify(chat, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${(chat.title || "chat").replace(/[^\w\-]+/g, "_")}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        closeHeaderDrawer();
    }

    function initHeaderUI() {
        initModelDropdown();
        initResourcesDrawer();
    }

    function initModelDropdown() {
        const toggle = document.getElementById("modelToggle");
        const menu = document.getElementById("modelMenu");
        const label = document.getElementById("activeModelLabel");
        if (!toggle || !menu || !label) return;

        function open() {
            menu.classList.remove("modelMenu--hidden");
            menu.setAttribute("aria-hidden", "false");
        }
        function close() {
            menu.classList.add("modelMenu--hidden");
            menu.setAttribute("aria-hidden", "true");
        }
        function isOpen() {
            return !menu.classList.contains("modelMenu--hidden");
        }

        toggle.addEventListener("click", (e) => {
            // allow clicking items without immediately toggling twice
            if (e.target.closest(".modelMenu__item")) return;
            isOpen() ? close() : open();
        });

        menu.querySelectorAll("[data-model]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const name = btn.getAttribute("data-model") || "Assistant";
                label.textContent = name;
                close();

                // optional: store selection
                localStorage.setItem("axpert_model_name", name);
            });
        });

        document.addEventListener("click", (e) => {
            if (!toggle.contains(e.target)) close();
        });

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") close();
        });

        // restore
        const saved = localStorage.getItem("axpert_model_name");
        if (saved) label.textContent = saved;
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, String.fromCharCode(38) + 'amp;')
            .replace(/</g, String.fromCharCode(38) + 'lt;')
            .replace(/>/g, String.fromCharCode(38) + 'gt;')
            .replace(/"/g, String.fromCharCode(38) + 'quot;')
            .replace(/'/g, String.fromCharCode(38) + '#39;');
    }

    function normalizeText(s) {
        return String(s || "")
            .replace(/\u00A0/g, " ")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    function detectRoleFromDom(messageEl) {
        // Your DOM shows assistant avatar is an <img>, user avatar is text. [file:183]
        const avatar = messageEl.querySelector(".message__avatar, .messageavatar");
        const hasImg = !!avatar?.querySelector("img");
        return hasImg ? "assistant" : "user";
    }

    function escapeMd(s) {
        return String(s || "")
            .replace(/\|/g, "\\|")
            .replace(/\r?\n/g, " ")
            .trim();
    }

    function tableToMarkdown(tableEl, maxRows = 25) {
        const rows = Array.from(tableEl.querySelectorAll("tr"));
        if (!rows.length) return "";

        const matrix = rows.map((tr) =>
            Array.from(tr.children).map((cell) => escapeMd(cell.innerText || cell.textContent))
        );

        const header = matrix[0] || [];
        const colCount = header.length || Math.max(0, ...matrix.map((r) => r.length));

        const norm = (r) => {
            const out = (r || []).slice(0, colCount);
            while (out.length < colCount) out.push("");
            return out;
        };

        const head = norm(header);
        const sep = new Array(colCount).fill("---");
        const body = matrix.slice(1, 1 + maxRows).map(norm);

        const line = (arr) => `| ${arr.join(" | ")} |`;
        return [line(head), line(sep), ...body.map(line)].join("\n");
    }

    function escapeMd(s) {
        return String(s || "")
            .replace(/\|/g, "\\|")
            .replace(/\r?\n/g, " ")
            .trim();
    }

    function tableToMarkdown(tableEl, maxRows = 25) {
        const rows = Array.from(tableEl.querySelectorAll("tr"));
        if (!rows.length) return "";

        const matrix = rows.map((tr) =>
            Array.from(tr.children).map((cell) => escapeMd(cell.innerText || cell.textContent))
        );

        const header = matrix[0] || [];
        const colCount = header.length || Math.max(0, ...matrix.map((r) => r.length));

        const norm = (r) => {
            const out = (r || []).slice(0, colCount);
            while (out.length < colCount) out.push("");
            return out;
        };

        const head = norm(header);
        const sep = new Array(colCount).fill("---");
        const body = matrix.slice(1, 1 + maxRows).map(norm);

        const line = (arr) => `| ${arr.join(" | ")} |`;
        return [line(head), line(sep), ...body.map(line)].join("\n");
    }


    function answerCardToMarkdown(cardEl) {
        const out = [];
        const title =
            cardEl.querySelector(".answerCard__label, .answerCardlabel")?.innerText || "";
        if (title.trim()) out.push(`### ${normalizeText(title)}`);

        cardEl.querySelectorAll("h3").forEach(h => {
            const t = normalizeText(h.innerText || "");
            if (t) out.push(`#### ${t}`);
        });

        cardEl.querySelectorAll("p").forEach(p => {
            const t = normalizeText(p.innerText || "");
            if (t) out.push(t);
        });

        return out.join("\n\n");
    }


    function extractMessageTextFromDom(messageEl) {
        const wrap =
            messageEl.querySelector(".message__content") ||
            messageEl.querySelector(".messagecontent");
        if (!wrap) return "";

        const clone = wrap.cloneNode(true);

        // Remove timestamps/meta
        clone.querySelectorAll(".message__meta, .messagemeta").forEach((n) => n.remove());

        const parts = [];

        // Export rendered dataset tables as markdown tables
        const tableCards = Array.from(clone.querySelectorAll("article.tableCard"));
        if (tableCards.length) {
            tableCards.forEach((card) => {
                const title = normalizeText(
                    card.querySelector(".tableCardheader")?.innerText || "Data preview"
                );
                parts.push(`### ${title}`);

                const table = card.querySelector("table");
                if (table) parts.push(tableToMarkdown(table, 25));
                else parts.push(normalizeText(card.innerText || ""));
            });

            // Include any additional cards that appear in the same message
            Array.from(
                clone.querySelectorAll("article.insightsCard, article.answerCard, article.tableNotesCard, .messageChart")
            ).forEach((el) => {
                const t = normalizeText(el.innerText || "");
                if (t) parts.push(t);
                if (el.matches("article.answerCard")) {
                    const md = answerCardToMarkdown(el);
                    if (md) parts.push(md);
                    return;
                }
            });

            return normalizeText(parts.join("\n\n"));
        }

        // Non-table message: keep line breaks
        return normalizeText(clone.innerText || clone.textContent || "");
    }



    function getExportableThread() {
        const chat = getActiveChat();
        const title = chat?.title || "Chat";
        const exportedAt = new Date().toLocaleString();

        // 1) Primary: saved messages (normal chat flow uses pushMessage -> chat.messages) [file:183]
        if (chat?.messages?.length) {
            const msgs = chat.messages
                .map((m) => {
                    let raw = String(m?.content || "");
                    if (raw.trim().startsWith("<")) raw = stripHtmlToText(raw);
                    return {
                        role: m?.role === "assistant" ? "assistant" : "user",
                        ts: m?.ts,
                        tsText: m?.ts ? new Date(m.ts).toLocaleString() : "",
                        content: normalizeText(raw),
                    };
                })
                .filter((m) => m.content);

            if (msgs.length) return { title, exportedAt, messages: msgs };
        }

        // 2) Fallback: scrape rendered UI (this is your current case: chat.messages is 0) [file:183]
        const nodes = Array.from(document.querySelectorAll('#messages .message')); const messages = nodes
            .map((n) => {
                const role = detectRoleFromDom(n);
                const tsText = normalizeText(
                    n.querySelector(".message__meta, .messagemeta")?.textContent || ""
                );
                const content = extractMessageTextFromDom(n);
                return { role, content, markdown: true, tsText };
            })
            .filter((m) => m.content);

        return { title, exportedAt, messages };
    }



    function initResourcesDrawer() {
        const drawer = document.getElementById("resourcesDrawer");
        if (!drawer) return;

        const btnLinks = document.querySelector('.headerBtn[title="Links"]');
        const btnImages = document.querySelector('.headerBtn[title="Images"]');
        const btnVideos = document.querySelector('.headerBtn[title="Videos"]');

        const tabs = Array.from(drawer.querySelectorAll(".drawerTab[data-tab]"));
        const panels = Array.from(drawer.querySelectorAll(".drawerPanel[data-panel]"));

        function setTab(tabId) {
            tabs.forEach((t) => {
                const active = t.dataset.tab === tabId;
                t.classList.toggle("is-active", active);
                t.setAttribute("aria-selected", active ? "true" : "false");
            });
            panels.forEach((p) => {
                p.hidden = p.dataset.panel !== tabId;
            });
        }

        function open(tabId) {
            hydrateResources();      // refresh content each time you open
            setTab(tabId);

            drawer.classList.remove("drawer--hidden");
            drawer.setAttribute("aria-hidden", "false");
        }

        function close() {
            drawer.classList.add("drawer--hidden");
            drawer.setAttribute("aria-hidden", "true");
        }

        function hydrateResources() {
            const chat = getActiveChat();
            const res = collectChatResources(chat);

            const linksPanel = drawer.querySelector('[data-panel="links"]');
            const imagesPanel = drawer.querySelector('[data-panel="images"]');
            const videosPanel = drawer.querySelector('[data-panel="videos"]');

            linksPanel.innerHTML = renderLinksList(res.links);
            imagesPanel.innerHTML = renderImagesGrid(res.images);
            videosPanel.innerHTML = renderLinksList(res.videos);
        }

        // open drawer at specific tab
        btnLinks?.addEventListener("click", () => open("links"));
        btnImages?.addEventListener("click", () => open("images"));
        btnVideos?.addEventListener("click", () => open("videos"));

        // tab switching inside drawer
        tabs.forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));

        // close actions
        drawer.addEventListener("click", (e) => {
            const t = e.target;
            if (t && t.dataset && t.dataset.close) close();
        });

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") close();
        });
    }

    /* --- helpers reused from earlier approach --- */

    function collectChatResources(chat) {
        const out = { links: new Set(), images: new Set(), videos: new Set() };
        if (!chat || !Array.isArray(chat.messages)) return { links: [], images: [], videos: [] };

        for (const m of chat.messages) {
            const text = typeof m.content === "string" ? m.content : "";
            for (const u of extractUrls(text)) {
                if (isVideoUrl(u)) out.videos.add(u);
                else if (isImageUrl(u)) out.images.add(u);
                else out.links.add(u);
            }
        }

        return { links: [...out.links], images: [...out.images], videos: [...out.videos] };
    }

    function extractUrls(text) {
        const urls = new Set();
        const plain = /(https?:\/\/[^\s)<>"]+)/gi;
        for (const m of text.matchAll(plain)) urls.add(m[1]);
        const mdImg = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/gi;
        for (const m of text.matchAll(mdImg)) urls.add(m[1]);
        const href = /href=["'](https?:\/\/[^"']+)["']/gi;
        for (const m of text.matchAll(href)) urls.add(m[1]);
        const src = /src=["'](https?:\/\/[^"']+)["']/gi;
        for (const m of text.matchAll(src)) urls.add(m[1]);
        return [...urls];
    }

    function isImageUrl(u) { return /\.(png|jpg|jpeg|gif|webp|svg)(\?|#|$)/i.test(u); }
    function isVideoUrl(u) { return /(youtube\.com\/watch|youtu\.be\/|vimeo\.com\/)/i.test(u) || /\.(mp4|webm|mov)(\?|#|$)/i.test(u); }

    function renderLinksList(list) {
        if (!list.length) return `<div class="drawerEmpty">Nothing found yet.</div>`;
        return `<div class="drawerList">${list.map((u) => `<a class="drawerLink" href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`).join("")
            }</div>`;
    }

    function renderImagesGrid(list) {
        if (!list.length) return `<div class="drawerEmpty">No images found in this chat.</div>`;
        return `<div class="drawerGrid">${list.map((u) => `<a class="drawerImg" href="${u}" target="_blank" rel="noopener noreferrer"><img src="${u}" alt=""></a>`).join("")
            }</div>`;
    }

    /* --- VECTOR DATABASE & RAG UTILITIES --- */

    // 1. Calculate Cosine Similarity between two vectors
    function cosineSimilarity(vecA, vecB) {
        let dotProduct = 0, normA = 0, normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    async function getEmbeddings(texts) {
        const cfg = getAxiConfig();

        // Direct browser route (OpenAI / OpenRouter only)
        const provider = cfg.provider;
        if (provider === "openai" || provider === "openrouter") {
            const baseUrl = provider === "openrouter"
                ? "https://openrouter.ai/api/v1"
                : "https://api.openai.com/v1";
            const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.apiKey}` };
            if (provider === "openrouter") {
                headers["HTTP-Referer"] = window.location.origin;
                headers["X-Title"] = "Axpert AXI";
            }
            const res = await _axiFetch(`${baseUrl}/embeddings`, {
                method: "POST", headers,
                body: JSON.stringify({ model: "text-embedding-3-small", input: texts })
            });
            if (!res.ok) {
                let detail = `HTTP ${res.status}`;
                try {
                    const errBody = await res.json();
                    detail = errBody?.error?.message || errBody?.error || detail;
                } catch (_) { }
                throw new Error(`Embeddings request failed (${res.status}): ${detail}`);
            }
            const data = await res.json();
            return data.data.map(d => d.embedding);
        }

        // Gemini / Anthropic without MCP — skip gracefully, do not throw
        console.info(`[VectorCache] Embeddings not supported for "${provider}" without MCP — vector search disabled.`);
        return [];
    }

    // Keep the old name as an alias so any external callers don't break
    const getOpenAIEmbeddings = getEmbeddings;

    // Global store for our In-Memory Vector DB
    window.VectorStore = [];

    // ── IndexedDB Cache for VectorStore ──────────────────────────
    // Persists embeddings across page refreshes so we never re-pay
    // for the same dataset. Keyed by a hash of the row data.
    // Max 3 datasets are kept; the oldest is evicted when full.

    const _VEC_DB_NAME = "axi_vector_cache";
    const _VEC_STORE_NAME = "stores";
    const _VEC_MAX_CACHED = 3; // how many distinct datasets to keep

    /** Open (or create) the IndexedDB, returns a Promise<IDBDatabase> */
    function _vecDBOpen() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(_VEC_DB_NAME, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(_VEC_STORE_NAME)) {
                    // keyPath is the dataset hash; timestamp lets us evict oldest
                    db.createObjectStore(_VEC_STORE_NAME, { keyPath: "hash" });
                }
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    /** Read a cached VectorStore entry by hash. Returns the entry or null. */
    async function _vecCacheGet(hash) {
        try {
            const db = await _vecDBOpen();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(_VEC_STORE_NAME, "readonly");
                const req = tx.objectStore(_VEC_STORE_NAME).get(hash);
                req.onsuccess = (e) => resolve(e.target.result || null);
                req.onerror = (e) => reject(e.target.error);
            });
        } catch (err) {
            console.warn("[VectorCache] Read failed — will re-embed:", err);
            return null;
        }
    }

    /** Write a VectorStore entry, evicting the oldest if we exceed the cap. */
    async function _vecCacheSet(hash, storeEntries) {
        try {
            const db = await _vecDBOpen();

            // Fetch all existing keys + timestamps so we can evict if needed
            const allEntries = await new Promise((resolve, reject) => {
                const tx = db.transaction(_VEC_STORE_NAME, "readonly");
                const req = tx.objectStore(_VEC_STORE_NAME).getAll();
                req.onsuccess = (e) => resolve(e.target.result || []);
                req.onerror = (e) => reject(e.target.error);
            });

            // Evict oldest entries until we're under the cap
            const toEvict = allEntries
                .filter(e => e.hash !== hash)           // don't count the one we're about to write
                .sort((a, b) => a.timestamp - b.timestamp) // oldest first
                .slice(0, Math.max(0, allEntries.length - _VEC_MAX_CACHED + 1));

            await new Promise((resolve, reject) => {
                const tx = db.transaction(_VEC_STORE_NAME, "readwrite");
                const store = tx.objectStore(_VEC_STORE_NAME);
                toEvict.forEach(e => store.delete(e.hash));
                store.put({ hash, timestamp: Date.now(), entries: storeEntries });
                tx.oncomplete = resolve;
                tx.onerror = (e) => reject(e.target.error);
            });

            console.log(`[VectorCache] Saved ${storeEntries.length} vectors under key "${hash.slice(0, 12)}…"`);
        } catch (err) {
            // Cache write failing is non-fatal — search still works from memory
            console.warn("[VectorCache] Write failed (non-fatal):", err);
        }
    }

    /**
     * Fast, stable hash of a row array.
     * Uses row count + first/last row content + total char length
     * so different datasets produce different keys.
     */
    function _datasetHash(rows) {
        if (!rows || rows.length === 0) return "empty";
        const sample = [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]]
            .map(r => JSON.stringify(r)).join("|");
        const totalChars = rows.reduce((acc, r) => acc + JSON.stringify(r).length, 0);
        // Simple djb2-style numeric hash → hex string
        let h = 5381;
        const str = `${rows.length}::${totalChars}::${sample}`;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) + h) ^ str.charCodeAt(i);
            h = h >>> 0; // keep unsigned 32-bit
        }
        return `v1_${rows.length}_${h.toString(16)}`;
    }

    // ── Main build function (now cache-aware) ────────────────────

    async function buildVectorIndexForDataset(rows) {
        window.VectorStore = [];
        if (!rows || rows.length === 0) return;

        const hash = _datasetHash(rows);

        // ── Cache hit: load from IndexedDB, skip all API calls ──
        const cached = await _vecCacheGet(hash);
        if (cached && Array.isArray(cached.entries) && cached.entries.length > 0) {
            window.VectorStore = cached.entries;
            console.log(`[VectorCache] Loaded ${window.VectorStore.length} vectors from cache (key: "${hash.slice(0, 12)}…"). No API call needed.`);
            return;
        }

        console.log(`[VectorCache] No cache found — embedding ${rows.length} rows…`);
        const cfg = getAxiConfig().provider;
        if (cfg !== "openai" && cfg !== "openrouter") {
            console.info(`[VectorCache] Skipping — embeddings not supported for "${cfg}" without MCP. Vector search disabled.`);
            return;
        }
        const batchSize = 500;

        for (let i = 0; i < rows.length; i += batchSize) {
            const batch = rows.slice(i, i + batchSize);

            // Convert each row object into a highly readable string for the embedding model
            // Example: "status: Active, amount: 5000, company: ABB India"
            const allTexts = batch.map(row => {
                return Object.entries(row)
                    .filter(([k, v]) => v !== null && v !== '') // Ignore empty cells
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(', ');
            });

            // Guard: skip rows that produced an empty string — the embeddings API
            // rejects empty inputs with a 400 error (input cannot be an empty string).
            const validPairs = batch
                .map((row, idx) => ({ row, text: allTexts[idx] }))
                .filter(pair => pair.text.trim() !== '');

            if (validPairs.length === 0) continue; // entire batch was blank rows

            const texts = validPairs.map(p => p.text);

            // Get vectors for this batch
            const embeddings = await getOpenAIEmbeddings(texts);

            // Store them with the original row data
            validPairs.forEach(({ row, text }, idx) => {
                window.VectorStore.push({
                    originalRow: row,
                    textString: text,
                    vector: embeddings[idx]
                });
            });
        }

        console.log(`Vector DB Indexed ${window.VectorStore.length} rows successfully.`);

        // Persist to IndexedDB so the next page load is instant
        await _vecCacheSet(hash, window.VectorStore);
    }

    window.buildVectorIndexForDataset = buildVectorIndexForDataset;

    /**
     * Call this in the browser console to see how many tokens vectorization has saved.
     *   window.getVectorTokenStats()
     *
     * To reset the counters:
     *   localStorage.removeItem("axi_vector_token_stats")
     */
    window.getVectorTokenStats = function () {
        const s = JSON.parse(localStorage.getItem("axi_vector_token_stats") || "null");
        if (!s || s.queriesFiltered === 0) {
            console.log("[VectorDB] No filtered queries yet.");
            return;
        }
        const avgSaving = Math.round(s.totalSaved / s.queriesFiltered);
        const pct = s.totalFull > 0 ? Math.round((s.totalSaved / s.totalFull) * 100) : 0;
        console.table({
            "Queries filtered by vector search": s.queriesFiltered,
            "Total tokens WITHOUT vectorization": s.totalFull.toLocaleString(),
            "Total tokens WITH vectorization": s.totalFiltered.toLocaleString(),
            "Total tokens saved": s.totalSaved.toLocaleString(),
            "Average saving per query": avgSaving.toLocaleString() + " tokens",
            "Overall reduction": pct + "%"
        });
        if (s.lastQuery) console.log("Last query detail:", s.lastQuery);
    };

    async function searchVectorDB(userQuery, topK = 40) {
        if (!window.VectorStore || window.VectorStore.length === 0) {
            return null; // DB not indexed yet
        }

        // 1. Convert the user's question into a vector
        const [queryVector] = await getOpenAIEmbeddings([userQuery]);

        // 2. Score every row in our dataset against the query
        const scoredRows = window.VectorStore.map(item => {
            return {
                row: item.originalRow,
                score: cosineSimilarity(queryVector, item.vector)
            };
        });

        // --- THE FIX: ADD A THRESHOLD ---
        // 3. Define a Minimum Similarity Threshold. 
        // Note: 'text-embedding-3-small' usually returns scores between 0.2 (unrelated) and 0.8 (perfect match).
        // Start with 0.40 and adjust up or down based on your testing.
        const SIMILARITY_THRESHOLD = 0.40;

        // 4. Filter out rows that don't meet the minimum relevance cutoff
        const relevantRows = scoredRows.filter(item => item.score >= SIMILARITY_THRESHOLD);

        // 5. Sort the surviving rows by highest score (closest meaning)
        relevantRows.sort((a, b) => b.score - a.score);

        // 6. Return only the Top K. 
        // If only 5 records met the threshold, this will safely return just those 5.
        return relevantRows.slice(0, topK).map(item => item.row);
    }

    // ─── KEYBOARD SHORTCUTS ──────────────────────────────────────────────────────
    document.addEventListener('keydown', function (e) {
        const isMac = navigator.platform.toUpperCase().includes('MAC');
        const ctrlOrCmd = isMac ? e.metaKey : e.ctrlKey;

        // Ctrl+Enter / Cmd+Enter → Send message
        if (ctrlOrCmd && e.key === 'Enter') {
            e.preventDefault();
            const composer = document.getElementById('composer');
            if (composer && !state.busy) {
                composer.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            }
            return;
        }

        // Ctrl+K / Cmd+K → Start a new chat
        if (ctrlOrCmd && e.key === 'k') {
            e.preventDefault();
            newChat();
            // Focus the prompt so user can start typing immediately
            setTimeout(() => document.getElementById('prompt')?.focus(), 50);
            return;
        }

        // Ctrl+/ / Cmd+/ → Open system prompt editor
        if (ctrlOrCmd && e.key === '/') {
            e.preventDefault();
            const modal = document.getElementById('systemPromptModal');
            const editor = document.getElementById('systemPromptEditor');
            if (modal) {
                if (modal.open) {
                    modal.close();
                } else {
                    if (editor) editor.value = window.getActiveSystemPrompt?.() ?? '';
                    modal.showModal();
                }
            }
            return;
        }

        // Escape → Close any open modal / history popover
        if (e.key === 'Escape') {
            closeHistory?.();
            return;
        }
    });
    // ─────────────────────────────────────────────────────────────────────────────

    // ─── TOKEN SAVINGS BADGE ─────────────────────────────────────────────────────
    function formatTokenCount(n) {
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
        if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
        return String(n);
    }

    function updateTokenBadge() {
        const badge = document.getElementById('axiTokenBadge');
        const badgeTxt = document.getElementById('axiTokenBadgeText');
        if (!badge || !badgeTxt) return;

        try {
            const stats = JSON.parse(
                localStorage.getItem('axivectortokenstats') ||
                '{"queriesFiltered":0,"totalSaved":0}'
            );
            const saved = stats.totalSaved ?? 0;
            const queries = stats.queriesFiltered ?? 0;

            if (saved <= 0) {
                badge.style.display = 'none';
                return;
            }

            badge.style.display = 'flex';
            badgeTxt.textContent = `⚡ ${formatTokenCount(saved)} tokens saved (${queries} queries)`;

            // Pulse animation on update
            badge.animate(
                [{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }],
                { duration: 350, easing: 'ease-out' }
            );
        } catch (e) {
            badge.style.display = 'none';
        }
    }

    // Patch: call updateTokenBadge every time vector search saves tokens.
    // Hook into the existing localStorage write inside callOpenAI's vector block.
    const _origSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function (key, value) {
        _origSetItem(key, value);
        if (key === 'axivectortokenstats') updateTokenBadge();
    };

    // Show on load if there are already saved stats from a previous session
    document.addEventListener('DOMContentLoaded', updateTokenBadge);
    // ─────────────────────────────────────────────────────────────────────────────

    // ─── EDIT & REGENERATE ───────────────────────────────────────────────────────
    function makeMessageEditable(bubbleEl, originalContent) {
        if (!bubbleEl) return;

        // Edit button — appears on hover
        const editBtn = document.createElement('button');
        editBtn.className = 'axi-edit-btn';
        editBtn.title = 'Edit message';
        editBtn.style.cssText = `
    position:absolute; top:8px; right:8px; z-index:5;
    display:flex; align-items:center; gap:4px;
    padding:4px 9px; border-radius:7px;
    border:1.5px solid rgba(0,0,0,0.08);
    background:rgba(255,255,255,0.85);
    backdrop-filter:blur(4px);
    color:#6B7280; font-size:11px; font-weight:500;
    cursor:pointer; opacity:0;
    transition:opacity 0.18s, background 0.15s;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  `;
        editBtn.innerHTML = `
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
    Edit
  `;

        bubbleEl.style.position = 'relative';
        bubbleEl.addEventListener('mouseenter', () => editBtn.style.opacity = '1');
        bubbleEl.addEventListener('mouseleave', () => editBtn.style.opacity = '0');

        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openInlineEditor(bubbleEl, originalContent, editBtn);
        });

        bubbleEl.appendChild(editBtn);
    }

    function openInlineEditor(bubbleEl, originalContent, editBtn) {
        // Already editing
        if (bubbleEl.querySelector('.axi-inline-editor')) return;

        // Hide existing text content
        const existingText = bubbleEl.querySelector('p, .message-text, div:not(.axi-edit-btn)');
        const originalHTML = bubbleEl.innerHTML;

        // Build inline editor
        bubbleEl.innerHTML = '';

        const textarea = document.createElement('textarea');
        textarea.className = 'axi-inline-editor';
        textarea.value = originalContent;
        textarea.style.cssText = `
    width:100%; min-height:72px; max-height:240px;
    padding:10px 12px; border-radius:8px;
    border:1.5px solid #3B82F6; outline:none;
    font-size:14px; font-family:inherit; line-height:1.6;
    color:#1a1a2e; background:#fff;
    resize:vertical; box-sizing:border-box;
    box-shadow:0 0 0 3px rgba(59,130,246,0.12);
  `;

        const actions = document.createElement('div');
        actions.style.cssText = `
    display:flex; gap:8px; margin-top:8px; justify-content:flex-end;
  `;

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = `
    padding:6px 14px; border-radius:7px;
    border:1.5px solid #E2E8F0; background:#F8FAFC;
    color:#374151; font-size:12px; font-weight:500; cursor:pointer;
  `;

        const sendBtn = document.createElement('button');
        sendBtn.textContent = 'Regenerate ↵';
        sendBtn.style.cssText = `
    padding:6px 14px; border-radius:7px;
    border:none; background:#2563EB;
    color:#fff; font-size:12px; font-weight:600; cursor:pointer;
    transition:background 0.15s;
  `;
        sendBtn.onmouseover = () => sendBtn.style.background = '#1D4ED8';
        sendBtn.onmouseout = () => sendBtn.style.background = '#2563EB';

        // Cancel — restore original
        cancelBtn.addEventListener('click', () => {
            bubbleEl.innerHTML = originalHTML;
            // Re-attach the edit button listener
            const newEditBtn = bubbleEl.querySelector('.axi-edit-btn');
            if (newEditBtn) {
                bubbleEl.addEventListener('mouseenter', () => newEditBtn.style.opacity = '1');
                bubbleEl.addEventListener('mouseleave', () => newEditBtn.style.opacity = '0');
                newEditBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openInlineEditor(bubbleEl, originalContent, newEditBtn);
                });
            }
        });

        // Regenerate — edit chat history and re-send
        sendBtn.addEventListener('click', () => {
            const newText = textarea.value.trim();
            if (!newText) return;
            regenerateFromEdit(bubbleEl, newText);
        });

        // Ctrl+Enter submits
        textarea.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                sendBtn.click();
            }
            if (e.key === 'Escape') cancelBtn.click();
        });

        actions.appendChild(cancelBtn);
        actions.appendChild(sendBtn);
        bubbleEl.appendChild(textarea);
        bubbleEl.appendChild(actions);
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }

    function regenerateFromEdit(bubbleEl, newText) {
        // Find the message node (parent of bubble)
        const messageNode = bubbleEl.closest('.message--user') ||
            bubbleEl.closest('[class*="message--user"]');
        if (!messageNode) return;

        // ✅ REPLACE WITH THIS
        const thread = document.getElementById('messages');
        if (!thread) return;
        const allMessages = [...thread.querySelectorAll('[class*="message--"]')];
        const msgIndex = allMessages.indexOf(messageNode);

        // Update chat history — trim to this point
        const chat = getActiveChat();
        if (!chat) return;

        // Find which chat message this corresponds to (user messages only)
        const userMsgsBefore = allMessages.slice(0, msgIndex + 1)
            .filter(n => n.classList.toString().includes('user'));
        const userMsgIndex = userMsgsBefore.length - 1;

        // Count user messages to find position in chat.messages array
        let userCount = -1;
        let chatMsgIndex = -1;
        for (let i = 0; i < chat.messages.length; i++) {
            if (chat.messages[i].role === 'user') userCount++;
            if (userCount === userMsgIndex) { chatMsgIndex = i; break; }
        }

        if (chatMsgIndex === -1) return;

        // CORRECT — remove FROM this message onward, let handleSend re-add it fresh
        chat.messages.splice(chatMsgIndex); // removes this message + everything after
        chat.updatedAt = Date.now();
        saveChats();

        renderThread();

        setTimeout(() => {
            const prompt = document.getElementById('prompt');
            if (prompt) {
                prompt.value = newText;
                prompt.dispatchEvent(new Event('input', { bubbles: true }));
                if (typeof syncComposerButtons === 'function') syncComposerButtons();
                if (typeof handleSend === 'function') handleSend();
            }
        }, 80);
    }
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * AXI ENHANCEMENTS v2.0 — Drop-in module
     * Add AFTER your existing scripts: <script src="axi-enhancements.js"></script>
     */
    (function AXIEnhancements() {
        'use strict';

        const EXT = {
            promptHistory: [], promptIndex: -1,
            speechSynth: window.speechSynthesis || null,
            searchOpen: false, lastTtsUtterance: null,
            feedbackStore: {}, initialized: false, ddActive: false
        };

        function $(sel, root) { return (root || document).querySelector(sel); }
        function $$(sel, root) { return [...(root || document).querySelectorAll(sel)]; }
        function uid() { return Math.random().toString(36).slice(2, 9); }

        function getDataContext() {
            try {
                const chat = (typeof getActiveChat === 'function') ? getActiveChat() : null;
                const hasRows = !!(chat?.datasetRows?.length > 0 || window.pendingDatabaseData?.data?.length > 0);
                const hasFile = !!(chat?.fileName || chat?.fileContext);
                const hasBin = !!(window.ACTIVEDATABINCONTEXT);
                const fileName = chat?.datasetFileName || chat?.fileName || window.pendingDatabaseData?.name
                    || (hasBin ? window.ACTIVEDATABINCONTEXT?.name : null) || null;
                const rowCount = chat?.datasetRows?.length || window.pendingDatabaseData?.data?.length || 0;
                return { hasRows, hasFile, hasBin, fileName, rowCount };
            } catch { return { hasRows: false, hasFile: false, hasBin: false, rowCount: 0 }; }
        }

        // ── TOAST ─────────────────────────────────────────────────────────────────────
        let toastContainer;
        function ensureToastContainer() {
            if (toastContainer && document.contains(toastContainer)) return toastContainer;
            toastContainer = document.createElement('div');
            toastContainer.id = 'axiExtToasts';
            toastContainer.className = 'axiext-toast-wrap';
            document.body.appendChild(toastContainer);
            return toastContainer;
        }
        function toast(message, type = 'info', duration = 3000) {
            const wrap = ensureToastContainer();
            const el = document.createElement('div');
            el.className = `axiext-toast axiext-toast--${type}`;
            const icons = {
                info: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
                success: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
                error: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
                warning: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>'
            };
            el.innerHTML = `<span class="axiext-toast-icon">${icons[type] || icons.info}</span><span>${message}</span>`;
            wrap.appendChild(el);
            requestAnimationFrame(() => el.classList.add('axiext-toast--visible'));
            const remove = () => { el.classList.remove('axiext-toast--visible'); el.classList.add('axiext-toast--out'); setTimeout(() => el.remove(), 300); };
            setTimeout(remove, duration);
            el.addEventListener('click', remove);
            return remove;
        }

        // Expose globally so dashboard.html script blocks can call window.axiToast(...)
        // without depending on the closure scope of this IIFE.
        window.axiToast = toast;

        // ── 1. MESSAGE ACTION BAR ─────────────────────────────────────────────────────
        function injectMessageActions(msgNode) {
            if (!msgNode || msgNode.dataset.axiActionsInjected) return;
            if (!msgNode.classList.contains('message--assistant')) return;
            msgNode.dataset.axiActionsInjected = '1';
            const msgId = uid();
            msgNode.dataset.axiMsgId = msgId;
            const bubble = msgNode.querySelector('.message__bubble, .messagebubble, .bubble');
            if (!bubble) return;
            const bar = document.createElement('div');
            bar.className = 'axiext-actions';

            bar.appendChild(makeActionBtn('Copy', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>', async (btn) => {
                try {
                    await navigator.clipboard.writeText(bubble.innerText || bubble.textContent || '');
                    btn.classList.add('axiext-btn--done'); btn.title = 'Copied!';
                    toast('Copied to clipboard', 'success', 1800);
                    setTimeout(() => { btn.classList.remove('axiext-btn--done'); btn.title = 'Copy'; }, 2000);
                } catch { toast('Copy failed', 'error'); }
            }));

            const upBtn = makeActionBtn('Good response', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>', (btn) => {
                const cur = EXT.feedbackStore[msgId];
                if (cur === 'up') { EXT.feedbackStore[msgId] = null; btn.classList.remove('axiext-btn--active'); return; }
                EXT.feedbackStore[msgId] = 'up'; btn.classList.add('axiext-btn--active');
                bar.querySelector('[data-feedback="down"]')?.classList.remove('axiext-btn--active');
                toast('Thanks for the feedback!', 'success', 2000);
            });
            upBtn.dataset.feedback = 'up'; bar.appendChild(upBtn);

            const downBtn = makeActionBtn('Poor response', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>', (btn) => {
                const cur = EXT.feedbackStore[msgId];
                if (cur === 'down') { EXT.feedbackStore[msgId] = null; btn.classList.remove('axiext-btn--active'); return; }
                EXT.feedbackStore[msgId] = 'down'; btn.classList.add('axiext-btn--active');
                bar.querySelector('[data-feedback="up"]')?.classList.remove('axiext-btn--active');
                showFeedbackFollowUp(msgNode, bar, msgId);
            });
            downBtn.dataset.feedback = 'down'; bar.appendChild(downBtn);

            bar.appendChild(makeActionBtn('Regenerate', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.88"/></svg>', () => {
                const allMsgs = $$('.message', $('#messages'));
                const idx = allMsgs.indexOf(msgNode);
                if (idx <= 0) return;
                const preceding = allMsgs.slice(0, idx).reverse().find(n => n.classList.contains('message--user'));
                if (!preceding) return;
                const bubbleText = preceding.querySelector('.message__bubble, .messagebubble')?.innerText?.trim();
                if (!bubbleText) return;
                const prompt = $('#prompt');
                if (prompt) { prompt.value = bubbleText; prompt.dispatchEvent(new Event('input', { bubbles: true })); }
                allMsgs.slice(idx - 1).forEach(n => n.remove());
                try {
                    const chat = getActiveChat();
                    if (chat?.messages) {
                        const userCount = allMsgs.slice(0, idx).filter(n => n.classList.contains('message--user')).length;
                        let uc = 0;
                        for (let i = 0; i < chat.messages.length; i++) {
                            if (chat.messages[i].role === 'user') uc++;
                            if (uc === userCount) { chat.messages.splice(i); break; }
                        }
                        if (typeof saveChats === 'function') saveChats();
                    }
                } catch { }
                setTimeout(() => { if (typeof handleSend === 'function') handleSend(); }, 80);
                toast('Regenerating response…', 'info', 2000);
            }));

            if (EXT.speechSynth) {
                bar.appendChild(makeActionBtn('Read aloud', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>', (btn) => {
                    if (EXT.lastTtsUtterance) { EXT.speechSynth.cancel(); EXT.lastTtsUtterance = null; btn.classList.remove('axiext-btn--active'); return; }
                    const text = bubble.innerText || bubble.textContent || '';
                    const utterance = new SpeechSynthesisUtterance(text.slice(0, 5000));
                    utterance.onend = () => { EXT.lastTtsUtterance = null; btn.classList.remove('axiext-btn--active'); };
                    EXT.lastTtsUtterance = utterance; btn.classList.add('axiext-btn--active');
                    EXT.speechSynth.speak(utterance);
                }));
            }

            bubble.parentElement.appendChild(bar);

            // If renderReportActions already stored markdown on this bubble, inject now
            if (bubble._axiMarkdown) {
                _injectReportBtns(bar, bubble, bubble._axiMarkdown);
            }

            // Smart List button — only shown when the bubble contains a table or list
            if (typeof axiHasTabularContent === 'function' && axiHasTabularContent(bubble)) {
                var slSep = document.createElement('div');
                slSep.className = 'axi-rpt-sep';
                slSep.style.cssText = 'width:1px;height:14px;background:#e5e7eb;margin:0 2px;flex-shrink:0;align-self:center;';
                bar.appendChild(slSep);
                var slBtn = makeActionBtn(
                    'Show in Smart List',
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="9" x2="9" y2="21"/></svg>',
                    function (btn) {
                        var text = bubble._axiMarkdown || bubble.innerText || bubble.textContent || '';
                        if (text && typeof axiShowInSmartList === 'function') axiShowInSmartList(text, btn);
                    }
                );
                slBtn.classList.add('axi-smartlist-btn');
                bar.appendChild(slBtn);
            }
        }

        function makeActionBtn(title, svgHTML, onClick) {
            const btn = document.createElement('button');
            btn.className = 'axiext-action-btn'; btn.type = 'button'; btn.title = title; btn.innerHTML = svgHTML;
            btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(btn); });
            return btn;
        }

        // ── 1b. USER MESSAGE ACTIONS (edit · copy · delete) ──────────────────────────
        function injectUserMessageActions(msgNode) {
            if (!msgNode || msgNode.dataset.axiUserActionsInjected) return;
            msgNode.dataset.axiUserActionsInjected = '1';
            const bubble = msgNode.querySelector('.message__bubble, .messagebubble, .bubble');
            if (!bubble) return;

            // Show timestamp in meta element title
            try {
                const chat = typeof getActiveChat === 'function' ? getActiveChat() : null;
                if (chat) {
                    const allUser = [...document.querySelectorAll('.message--user')];
                    const idx = allUser.indexOf(msgNode);
                    const msg = (chat.messages || []).filter(m => m.role === 'user')[idx];
                    if (msg?.ts) {
                        const meta = msgNode.querySelector('.message__meta, .messagemeta');
                        if (meta) meta.title = new Date(msg.ts).toLocaleString();
                    }
                }
            } catch (_) { }

            // Floating action bar
            const bar = document.createElement('div');
            bar.className = 'axiext-user-actions';

            // Copy
            bar.appendChild(makeActionBtn('Copy message',
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
                async (btn) => {
                    try {
                        await navigator.clipboard.writeText(bubble.innerText || bubble.textContent || '');
                        btn.classList.add('axiext-btn--done');
                        toast('Copied', 'success', 1500);
                        setTimeout(() => btn.classList.remove('axiext-btn--done'), 1800);
                    } catch { toast('Copy failed', 'error'); }
                }
            ));

            // Edit (wire into existing openInlineEditor)
            const editBtn = makeActionBtn('Edit & resend',
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
                () => {
                    const orig = bubble.innerText?.trim() || bubble.textContent?.trim() || '';
                    if (typeof openInlineEditor === 'function') openInlineEditor(bubble, orig, editBtn);
                }
            );
            bar.appendChild(editBtn);

            // Delete (removes this message + its immediate assistant reply)
            bar.appendChild(makeActionBtn('Delete message',
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
                () => {
                    const thread = document.getElementById('messages');
                    if (!thread) return;
                    const allMsgs = [...thread.querySelectorAll('[class*="message--"]')];
                    const msgIdx = allMsgs.indexOf(msgNode);
                    const toRemove = [msgNode];
                    if (allMsgs[msgIdx + 1]?.classList?.contains('message--assistant')) toRemove.push(allMsgs[msgIdx + 1]);
                    try {
                        const chat = typeof getActiveChat === 'function' ? getActiveChat() : null;
                        if (chat?.messages) {
                            const usersBefore = allMsgs.slice(0, msgIdx + 1).filter(n => n.classList.contains('message--user')).length;
                            let uc = 0, start = -1;
                            for (let i = 0; i < chat.messages.length; i++) {
                                if (chat.messages[i].role === 'user') uc++;
                                if (uc === usersBefore) { start = i; break; }
                            }
                            if (start !== -1) {
                                const count = (toRemove.length === 2 && chat.messages[start + 1]?.role === 'assistant') ? 2 : 1;
                                chat.messages.splice(start, count);
                                chat.updatedAt = Date.now();
                                if (typeof saveChats === 'function') saveChats();
                            }
                        }
                    } catch (_) { }
                    toRemove.forEach(n => {
                        const pinnedId = n.dataset?.axiMsgId;
                        if (pinnedId && typeof window._axiRemovePin === 'function') {
                            window._axiRemovePin(pinnedId);
                        }
                        n.remove();
                    });
                    toast('Message deleted', 'info', 1800);
                }
            ));

            bubble.parentElement?.appendChild(bar);
        }

        function showFeedbackFollowUp(msgNode, bar, msgId) {
            const existing = bar.parentElement.querySelector('.axiext-feedback-row');
            if (existing) { existing.remove(); return; }
            const row = document.createElement('div');
            row.className = 'axiext-feedback-row';
            row.innerHTML = `<span class="axiext-feedback-label">What was the issue?</span>
      <button class="axiext-feedback-chip" data-reason="inaccurate">Inaccurate</button>
      <button class="axiext-feedback-chip" data-reason="incomplete">Incomplete</button>
      <button class="axiext-feedback-chip" data-reason="confusing">Hard to understand</button>
      <button class="axiext-feedback-chip" data-reason="wrong_format">Wrong format</button>`;
            row.querySelectorAll('.axiext-feedback-chip').forEach(chip => {
                chip.addEventListener('click', () => {
                    EXT.feedbackStore[msgId + '_reason'] = chip.dataset.reason;
                    row.innerHTML = '<span class="axiext-feedback-label" style="color:#22c55e">✓ Feedback recorded. Thank you!</span>';
                    setTimeout(() => row.remove(), 2500);
                });
            });
            bar.parentElement.appendChild(row);
        }

        // ── 2. SUGGESTIONS ────────────────────────────────────────────────────────────

        /** Detect if the active context looks like payroll data */
        function isPayrollContext() {
            const payrollSignals = /payroll|payslip|salary|ytd|lop|wday|mday|deduction|pf|esi|basic.*pay|net.*pay|earnings|allowance|incentive|provident|insurance|leave.*bal/i;
            // Check bin datasource names
            const sources = window.ACTIVEDATABINCONTEXT?.datasources || [];
            if (sources.some(s => payrollSignals.test(s.name || s.caption || ''))) return true;
            // Check bin name
            if (payrollSignals.test(window.ACTIVEDATABINCONTEXT?.name || '')) return true;
            // Check column names from active rows
            const rows = window.pendingDatabaseData?.data || [];
            if (rows.length > 0) {
                const cols = Object.keys(rows[0] || {}).join(' ');
                if (payrollSignals.test(cols)) return true;
            }
            // Check active chat dataset
            try {
                const chat = (typeof getActiveChat === 'function') ? getActiveChat() : null;
                const chatCols = Object.keys((chat?.datasetRows?.[0]) || {}).join(' ');
                if (payrollSignals.test(chatCols)) return true;
                if (payrollSignals.test(chat?.datasetFileName || '')) return true;
            } catch (_) { }
            return false;
        }

        function buildSuggestions() {
            const ctx = getDataContext();
            const isPayroll = isPayrollContext();
            const name = ctx.fileName || (ctx.hasBin ? 'this Data Bin' : 'the dataset');

            // ── Active rows loaded (from file or DB fetch) ───────────────────────────
            if (ctx.hasRows) {
                if (isPayroll) {
                    return [
                        `What is the net salary breakdown for each month?`,
                        `Show total earnings vs total deductions as a chart`,
                        `What are the PF and ESI contributions this year?`,
                        `Which month had the highest deductions?`,
                        `Summarize the YTD salary statement`,
                        `Show a month-wise bar chart of net salary`
                    ];
                }
                return [
                    `Summarize ${name} — key stats and highlights`,
                    `Show the most important trends as charts`,
                    `What are the top 5 records by value?`,
                    `Are there any anomalies or outliers?`,
                    `Generate a detailed analysis report`,
                    `Which columns have missing or inconsistent data?`
                ];
            }

            // ── Document loaded ──────────────────────────────────────────────────────
            if (ctx.hasFile) {
                const docName = ctx.fileName || 'this document';
                return [
                    `Summarize the key points in ${docName}`,
                    `What are the main findings or conclusions?`,
                    `List any action items or decisions mentioned`,
                    `What risks or concerns are raised?`,
                    `Extract all numbers or figures mentioned`,
                    `Create a brief table of contents`
                ];
            }

            // ── Data Bin active but data not yet fetched into rows ───────────────────
            if (ctx.hasBin) {
                if (isPayroll) {
                    return [
                        `Generate a full payroll analysis report`,
                        `Show monthly earnings and deductions as charts`,
                        `What is the net salary trend across months?`,
                        `Break down deductions: PF, ESI, and others`,
                        `How does gross pay compare to net pay each month?`,
                        `Summarize the leave balance and LOP details`
                    ];
                }
                return [
                    `Give me an overview of all data in ${name}`,
                    `What are the key metrics across all sources?`,
                    `Show a summary dashboard with charts`,
                    `Find patterns or correlations in the data`,
                    `Compare figures across the different sources`,
                    `Generate a full analysis report`
                ];
            }

            // ── No context — only show things the AI can genuinely do right now ──────
            return [
                `What types of analysis can you perform?`,
                `What kinds of charts and visuals can you create?`,
                `How does the Data Bin feature work?`,
                `What data formats can you analyze?`,
                `Can you analyze payroll and salary data?`,
                `Walk me through how to get started`
            ];
        }

        // ── 3. DRAG & DROP ────────────────────────────────────────────────────────────
        function hookDragDrop() {
            const overlay = document.createElement('div');
            overlay.id = 'axiExtDropOverlay'; overlay.className = 'axiext-drop-overlay';
            overlay.innerHTML = `<div class="axiext-drop-inner">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      <p>Drop your file to analyze</p>
      <span>CSV · XLSX · PDF · DOCX · TXT · JSON</span>
    </div>`;
            document.body.appendChild(overlay);
            let dragCounter = 0;
            // AFTER
            document.addEventListener('dragenter', (e) => {
                if (!e.dataTransfer?.types?.includes('Files')) return;
                const dataBinPage = document.getElementById('dataBinPage');
                const uploadModal = document.getElementById('uploadModal');
                if ((dataBinPage && !dataBinPage.hidden) || (uploadModal && uploadModal.open)) return; // ✅ DataBin is active — stay out of the way
                dragCounter++;
                overlay.classList.add('axiext-drop-overlay--active');
            });
            document.addEventListener('dragleave', () => { if (--dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('axiext-drop-overlay--active'); } });
            document.addEventListener('dragover', (e) => e.preventDefault());
            document.addEventListener('drop', async (e) => {
                e.preventDefault(); dragCounter = 0; overlay.classList.remove('axiext-drop-overlay--active');
                const dataBinPage = document.getElementById('dataBinPage');
                const uploadModal = document.getElementById('uploadModal');
                if ((dataBinPage && !dataBinPage.hidden) || (uploadModal && uploadModal.open)) return; // ✅ DataBin handles its own drop
                const files = Array.from(e.dataTransfer?.files || []); if (!files.length) return;
                const fileInput = $('#fileInput'); if (!fileInput) { toast('File input not found', 'error'); return; }
                const allowed = ['.csv', '.xlsx', '.xls', '.txt', '.pdf', '.docx', '.json'];
                const valid = files.filter(f => allowed.some(ext => f.name.toLowerCase().endsWith(ext)));
                const rejected = files.length - valid.length;
                if (rejected) toast(`${rejected} file(s) skipped (unsupported format)`, 'warning', 3000);
                if (!valid.length) return;
                const dt = new DataTransfer(); valid.forEach(f => dt.items.add(f));
                fileInput.files = dt.files; fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                toast(`📎 ${valid[0].name} ready — click Send to analyze`, 'info', 4000);
            });
        }

        // ── 4. PROMPT HISTORY ─────────────────────────────────────────────────────────
        function hookPromptInput() {
            const prompt = $('#prompt'); if (!prompt) return;
            prompt.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowUp' && prompt.value.trim() === '') {
                    e.preventDefault(); if (!EXT.promptHistory.length) return;
                    EXT.promptIndex = Math.min(EXT.promptIndex + 1, EXT.promptHistory.length - 1);
                    prompt.value = EXT.promptHistory[EXT.promptIndex]; prompt.dispatchEvent(new Event('input', { bubbles: true }));
                    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
                } else if (e.key === 'ArrowDown' && EXT.promptIndex > -1) {
                    e.preventDefault(); EXT.promptIndex--;
                    prompt.value = EXT.promptIndex < 0 ? '' : EXT.promptHistory[EXT.promptIndex];
                    prompt.dispatchEvent(new Event('input', { bubbles: true }));
                } else if (e.key === 'Escape' && prompt.value.trim()) {
                    e.preventDefault(); prompt.value = ''; prompt.dispatchEvent(new Event('input', { bubbles: true })); EXT.promptIndex = -1;
                }
            });
            updatePlaceholder(prompt);
            setInterval(() => updatePlaceholder(prompt), 6000);
        }

        function updatePlaceholder(prompt) {
            if (document.activeElement === prompt) return;
            const ctx = getDataContext();
            const isPayroll = isPayrollContext();
            const placeholders = ctx.hasRows
                ? (isPayroll
                    ? [`Ask about salaries, deductions, or trends…`, `Try: "Show net salary by month as a chart"`, `Ask about PF, ESI, or leave balance…`, `Generate a payroll report…`]
                    : [`Ask anything about ${ctx.fileName || 'your data'}…`, `Create a chart…`, `Find patterns or outliers…`, `Generate a report…`])
                : ctx.hasFile
                    ? [`Ask about ${ctx.fileName || 'this document'}…`, `Summarize this…`, `Extract key points…`]
                    : ctx.hasBin
                        ? (isPayroll
                            ? [`Ask about your payroll data…`, `Try: "Show earnings vs deductions"`, `Generate a salary report…`]
                            : [`Ask anything about ${ctx.fileName || 'your Data Bin'}…`, `Generate a report…`, `Ask for charts or analysis…`])
                        : [`Ask anything — connect a Data Bin to get started…`, `What can AXI help you with today?`, `Ask about payroll, construction data, and more…`];
            prompt.placeholder = placeholders[Math.floor(Math.random() * placeholders.length)];
        }

        // ── 5. WELCOME SCREEN ─────────────────────────────────────────────────────────
        /*function renderWelcomeScreen() {
            const messagesEl = $('#messages'); if (!messagesEl) return;
            if ($('#axiExtWelcome')) return;
            if ($$('.message', messagesEl).length > 0) return;
            const welcome = document.createElement('div');
            welcome.id = 'axiExtWelcome'; welcome.className = 'axiext-welcome';
            welcome.innerHTML = `<div class="axiext-welcome-inner">
          <div class="axiext-welcome-hero">
            <div class="axiext-welcome-logo"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></div>
            <h1 class="axiext-welcome-title">AXI <span>Insights</span></h1>
            <p class="axiext-welcome-sub">Your AI data analyst. Connect your data, ask anything.</p>
          </div>
          <div class="axiext-feature-grid">
            <button class="axiext-feature-card" data-action="upload">
              <div class="axiext-feature-icon axiext-feature-icon--blue"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>
              <h3>Add to Data Bin</h3><p>Upload CSV, Excel, PDF or Word files into a Data Bin for AI analysis</p>
            </button>
            <button class="axiext-feature-card" data-action="databin">
              <div class="axiext-feature-icon axiext-feature-icon--purple"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg></div>
              <h3>Create Data Bin</h3><p>Group datasources and files together for powerful multi-source analysis</p>
            </button>
            <button class="axiext-feature-card" data-action="charts">
              <div class="axiext-feature-icon axiext-feature-icon--green"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/></svg></div>
              <h3>Generate Charts</h3><p>Ask for bar, line, pie, scatter charts — rendered interactively</p>
            </button>
          </div>
          <div class="axiext-welcome-shortcut">Press <kbd>?</kbd> to see all keyboard shortcuts</div>
        </div>`;
            welcome.querySelector('[data-action="upload"]')?.addEventListener('click', () => $('#fileInput')?.click());
            welcome.querySelector('[data-action="databin"]')?.addEventListener('click', () => $('#openDataPin')?.click() || toast('Click the Data Bin button in the toolbar', 'info', 3000));
            welcome.querySelector('[data-action="charts"]')?.addEventListener('click', () => { const p = $('#prompt'); if (p) { p.value = 'Create charts for my data'; p.focus(); p.dispatchEvent(new Event('input', { bubbles: true })); } });
            messagesEl.insertBefore(welcome, messagesEl.firstChild);
        }*/

        // ── 6. KEYBOARD SHORTCUTS ─────────────────────────────────────────────────────
        function buildShortcutsModal() {
            const existing = $('#axiExtShortcutsModal'); if (existing) { existing.remove(); return; }
            const modal = document.createElement('div');
            modal.id = 'axiExtShortcutsModal'; modal.className = 'axiext-modal-overlay';
            modal.innerHTML = `<div class="axiext-modal">
      <div class="axiext-modal-header"><h2>Keyboard Shortcuts</h2><button class="axiext-modal-close" title="Close">✕</button></div>
      <div class="axiext-shortcuts-grid">
        ${[['Ctrl + Enter', 'Send message'], ['↑ Arrow', 'Recall last message (when input empty)'], ['↓ Arrow', 'Navigate prompt history forward'], ['Escape', 'Clear input'], ['Ctrl + K', 'New chat'], ['Ctrl + /', 'Edit system prompt'], ['Ctrl + F', 'Search conversations'], ['?', 'Show this panel'], ['Ctrl + Shift + C', 'Copy last AI response']].map(([k, d]) => `<div class="axiext-shortcut-row"><kbd>${k}</kbd><span>${d}</span></div>`).join('')}
      </div>
    </div>`;
            modal.querySelector('.axiext-modal-close').addEventListener('click', () => modal.remove());
            modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
            document.body.appendChild(modal);
            requestAnimationFrame(() => modal.classList.add('axiext-modal-overlay--visible'));
        }

        // ── 7. DATA CONTEXT BANNER ────────────────────────────────────────────────────
        function updateContextBanner() {
            const composerWrap = $('.composerWrap'); if (!composerWrap) return;
            let banner = $('#axiExtContextBanner');
            const ctx = getDataContext();
            if (!ctx.hasRows && !ctx.hasFile && !ctx.hasBin) { banner?.remove(); return; }
            if (!banner) {
                banner = document.createElement('div');
                banner.id = 'axiExtContextBanner'; banner.className = 'axiext-context-banner';
                composerWrap.insertBefore(banner, composerWrap.firstChild);
            }
            const rows = ctx.rowCount > 0 ? ` · ${ctx.rowCount.toLocaleString()} rows` : '';
            const name = ctx.fileName || (ctx.hasBin ? 'Data Bin' : 'File');
            banner.innerHTML = `<div class="axiext-context-banner-inner" style="display: flex; align-items: center; gap: 0.5rem;">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">${ctx.hasRows ? '<path d="M3 3h18v18H3z"/><path d="M3 9h18M9 21V9"/>' : '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'}</svg>
      <span class="axiext-banner-name">${name}</span>
      <span class="axiext-banner-meta">${rows ? rows.slice(3) + ' rows loaded' : 'loaded'}</span>
      <button class="axiext-banner-clear" title="Clear data context" onclick="if(typeof clearDatasetState==='function')clearDatasetState();window.pendingDatabaseData=null;window.ACTIVEDATABINCONTEXT=null;window.ACTIVEDATABINAIPAYLOAD=null;this.closest('#axiExtContextBanner').remove();">✕</button>
    </div>`;
        }

        // ── 8. KEYBOARD SHORTCUTS HOOK ────────────────────────────────────────────────
        function hookKeyboardShortcuts() {
            document.addEventListener('keydown', (e) => {
                const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
                if (!inInput && e.key === '?' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); buildShortcutsModal(); return; }
                if ((e.ctrlKey || e.metaKey) && e.key === 'f' && !inInput) { e.preventDefault(); toggleChatSearch(); return; }
                if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'c') {
                    const lastAI = $$('.message--assistant').pop();
                    const bubble = lastAI?.querySelector('.message__bubble, .messagebubble');
                    if (bubble) navigator.clipboard.writeText(bubble.innerText || bubble.textContent || '').then(() => toast('Last AI response copied', 'success', 2000)).catch(() => { });
                }
                if ((e.ctrlKey || e.metaKey) && e.key === 'k' && !inInput) {
                    e.preventDefault(); if (typeof newChat === 'function') { newChat(); toast('New chat started', 'info', 1500); }
                }
            });
        }

        // ── 9. CHAT SEARCH ────────────────────────────────────────────────────────────
        function toggleChatSearch() {
            const existing = $('#axiExtSearchPanel'); if (existing) { existing.remove(); EXT.searchOpen = false; return; }
            const panel = document.createElement('div');
            panel.id = 'axiExtSearchPanel'; panel.className = 'axiext-search-panel';
            panel.innerHTML = `<div class="axiext-search-inner">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input type="text" id="axiExtSearchInput" placeholder="Search messages…" autocomplete="off" spellcheck="false">
      <span id="axiExtSearchCount" class="axiext-search-count"></span>
      <button id="axiExtSearchPrev" class="axiext-search-nav" title="Previous">↑</button>
      <button id="axiExtSearchNext" class="axiext-search-nav" title="Next">↓</button>
      <button id="axiExtSearchClose" class="axiext-search-close">✕</button>
    </div>`;
            const header = $('.chatHeader') || document.body;
            header.parentElement.insertBefore(panel, header.nextSibling);
            EXT.searchOpen = true;
            $('#axiExtSearchInput')?.focus();
            let matches = [], matchIdx = -1;
            const clearHL = () => $$('.axiext-search-highlight').forEach(el => { const p = el.parentNode; if (p) p.replaceChild(document.createTextNode(el.textContent), el); });
            const runSearch = (q) => {
                clearHL(); matches = [];
                if (!q.trim()) { $('#axiExtSearchCount').textContent = ''; return; }
                const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
                $$('.message__bubble,.messagebubble').forEach(bubble => {
                    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT); const textNodes = []; let node;
                    while ((node = walker.nextNode())) textNodes.push(node);
                    textNodes.forEach(tn => {
                        if (!regex.test(tn.textContent)) return;
                        const frag = document.createDocumentFragment();
                        tn.textContent.split(regex).forEach(part => {
                            if (regex.test(part)) { const mark = document.createElement('mark'); mark.className = 'axiext-search-highlight'; mark.textContent = part; frag.appendChild(mark); matches.push(mark); }
                            else frag.appendChild(document.createTextNode(part));
                            regex.lastIndex = 0;
                        });
                        tn.parentNode.replaceChild(frag, tn);
                    });
                });
                $('#axiExtSearchCount').textContent = matches.length ? `${matches.length} result${matches.length === 1 ? '' : 's'}` : 'No results';
                if (matches.length) { matchIdx = 0; scrollToMatch(0); }
            };
            const scrollToMatch = (i) => { $$('.axiext-search-highlight--current').forEach(el => el.classList.remove('axiext-search-highlight--current')); if (matches[i]) { matches[i].classList.add('axiext-search-highlight--current'); matches[i].scrollIntoView({ behavior: 'smooth', block: 'center' }); } };
            $('#axiExtSearchInput')?.addEventListener('input', () => runSearch($('#axiExtSearchInput').value));
            $('#axiExtSearchNext')?.addEventListener('click', () => { if (!matches.length) return; matchIdx = (matchIdx + 1) % matches.length; scrollToMatch(matchIdx); });
            $('#axiExtSearchPrev')?.addEventListener('click', () => { if (!matches.length) return; matchIdx = (matchIdx - 1 + matches.length) % matches.length; scrollToMatch(matchIdx); });
            $('#axiExtSearchClose')?.addEventListener('click', () => { clearHL(); panel.remove(); EXT.searchOpen = false; });
            panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { clearHL(); panel.remove(); EXT.searchOpen = false; } if (e.key === 'Enter') { if (!matches.length) return; matchIdx = (matchIdx + 1) % matches.length; scrollToMatch(matchIdx); } });
        }

        // ── 10. MUTATION OBSERVER ─────────────────────────────────────────────────────
        function hookMessageObserver() {
            const messagesEl = $('#messages'); if (!messagesEl) return;
            const processNode = (node) => {
                if (node.nodeType !== 1) return;
                if (node.classList?.contains('message--assistant')) {
                    const obs = new MutationObserver(() => { if (!node.classList.contains('axi-streaming-msg')) { obs.disconnect(); injectMessageActions(node); updateContextBanner(); removeSuggestionsIfMessages(); removeWelcomeIfMessages(); } });
                    obs.observe(node, { attributes: true, attributeFilter: ['class'] });
                    if (!node.classList.contains('axi-streaming-msg')) injectMessageActions(node);
                }
                if (node.classList?.contains('message--user')) {
                    setTimeout(() => injectUserMessageActions(node), 60);
                }
                if (node.classList?.contains('message--user') || node.classList?.contains('message--assistant')) { removeSuggestionsIfMessages(); removeWelcomeIfMessages(); }
            };
            new MutationObserver((mutations) => mutations.forEach(m => m.addedNodes.forEach(processNode))).observe(messagesEl, { childList: true, subtree: false });
            $$('.message--assistant', messagesEl).forEach(node => { if (!node.classList.contains('axi-streaming-msg')) injectMessageActions(node); });
            $$('.message--user', messagesEl).forEach(node => injectUserMessageActions(node));
        }

        function removeSuggestionsIfMessages() { if ($$('.message--user,.message--assistant', $('#messages')).length > 0) $('#axiExtSuggestions')?.remove(); }
        function removeWelcomeIfMessages() { if ($$('.message--user,.message--assistant', $('#messages')).length > 0) $('#axiExtWelcome')?.remove(); }

        // ── COMPOSER CAPTURE ──────────────────────────────────────────────────────────
        function hookComposer() {
            const composer = $('#composer'), prompt = $('#prompt'); if (!composer || !prompt) return;
            composer.addEventListener('submit', () => { const v = prompt.value.trim(); if (v) { EXT.promptHistory.unshift(v); if (EXT.promptHistory.length > 50) EXT.promptHistory.pop(); EXT.promptIndex = -1; } setTimeout(() => { updateContextBanner(); }, 200); }, true);
            $('#send')?.addEventListener('click', () => { const v = prompt.value.trim(); if (v) { EXT.promptHistory.unshift(v); if (EXT.promptHistory.length > 50) EXT.promptHistory.pop(); EXT.promptIndex = -1; } }, true);
            // Char count is handled by axiCharCount in dashboard.html — no duplicate needed
        }

        // ── SMART SCROLL ──────────────────────────────────────────────────────────────
        function enhanceScrollBehavior() {
            const messages = $('#messages'); if (!messages) return;
            let userScrolledUp = false;
            messages.addEventListener('scroll', () => { userScrolledUp = (messages.scrollHeight - messages.scrollTop - messages.clientHeight) > 120; });
            const orig = window.scrollToBottom;
            if (orig) window.scrollToBottom = function (force = false) { if (!userScrolledUp || force) orig(force); };
        }

        // ── INIT ──────────────────────────────────────────────────────────────────────
        function init() {
            if (EXT.initialized) return;
            EXT.initialized = true;
            hookMessageObserver(); hookPromptInput(); hookDragDrop(); hookKeyboardShortcuts(); hookComposer(); enhanceScrollBehavior();
            setTimeout(() => { updateContextBanner(); }, 400);
            setInterval(() => { updateContextBanner(); }, 3000);
            console.info('[AXI Enhancements] v2.0 loaded ✅');
        }

        if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', () => setTimeout(init, 700)); }
        else { setTimeout(init, 700); }
    })();


    // ═══════════════════════════════════════════════════════════════════════════════
    // AXI SMART FEATURES v2.0 — Compact Insights Dropdown
    //  Inserted as a single ⚡ button next to the Data Bin selector.
    //  Panel contains: KPI grid · Health · Anomaly badge · Quick-action buttons
    //  In-message: Smart Insight Pills · Pin Message
    // ═══════════════════════════════════════════════════════════════════════════════
    (function AXISmartFeatures() {
        'use strict';

        /* ── tiny DOM helpers ──────────────────────────────────────────────────── */
        const $ = (s, r) => (r || document).querySelector(s);
        const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
        const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        /* ── SVG Icon Library ────────────────────────────────────────────────── */
        /* ── SVG Icon Library (colourful) ───────────────────────────────────── */
        const IC = {
            // ── Insight Pill icons ─────────────────────────────────────────────
            currency: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
            up: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
            down: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>`,
            users: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
            calendar: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
            // ── Action tile icons (colourful 16px) ─────────────────────────────
            barChart: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/></svg>`,
            trendUp: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
            search: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
            list: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0891b2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
            report: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
            compare: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e11d48" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21H17"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></svg>`,
            ranked: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0284c7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
            dist: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 16c.5-2 1.5-6 4-6s3 3 5 3 3-4 3-6"/></svg>`,
            // ── Column schema type icons ───────────────────────────────────────
            numeric: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>`,
            text: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
            date: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
            bool: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
            // ── Status badges ──────────────────────────────────────────────────
            checkCircle: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
            alertTri: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
            xCircle: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
            circle: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/></svg>`,
            // ── Insights btn zap ───────────────────────────────────────────────
            zap: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
            // ── Empty state folder ─────────────────────────────────────────────
            folder: `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
        };

        /* ═══════════════════════════════════════════════════════════════════════
           STYLES
        ═══════════════════════════════════════════════════════════════════════ */
        function injectStyles() {
            if ($('#axiSFStyles')) return;
            const el = document.createElement('style');
            el.id = 'axiSFStyles';
            el.textContent = `
/* ── trigger button ─────────────────────────────────────── */
#axiInsightsBtn {
  display:inline-flex; align-items:center; gap:6px;
  padding:0 13px; height:48px; border-radius:14px;
  border:1.5px solid #e0e4ef; background:#fff;
  color:#374151; font-size:13.5px; font-weight:600;
  cursor:pointer; white-space:nowrap; flex-shrink:0;
  transition:all .18s; box-shadow:0 1px 4px rgba(0,0,0,.06);
  position:relative; font-family:inherit;
}
#axiInsightsBtn:hover {
  border-color:#93c5fd; background:#eff6ff; color:#1d4ed8;
  box-shadow:0 2px 8px rgba(59,130,246,.18);
}
#axiInsightsBtn.axi-btn-active {
  border-color:#3b82f6; background:#eff6ff; color:#1d4ed8;
}
#axiInsightsBtn .axi-btn-icon { font-size:14px; line-height:1; }
#axiInsightsBtn .axi-btn-chevron {
  width:12px; height:12px; flex-shrink:0; opacity:.6;
  transition:transform .18s;
}
#axiInsightsBtn.axi-btn-active .axi-btn-chevron { transform:rotate(180deg); }

/* badge on button */
#axiInsightsBadge {
  position:absolute; top:-5px; right:-5px;
  min-width:16px; height:16px; padding:0 4px;
  border-radius:8px; background:#ef4444;
  color:#fff; font-size:9px; font-weight:700;
  display:none; align-items:center; justify-content:center;
  border:2px solid #fff; line-height:1;
}
#axiInsightsBadge.visible { display:flex; }

/* ── floating panel ──────────────────────────────────────── */
#axiInsightsPanel {
  position:absolute;
  bottom:calc(100% + 10px); left:0;
  width:340px; z-index:9999;
  background:#fff; border-radius:14px;
  border:1.5px solid #e4e9f5;
  box-shadow:0 8px 32px rgba(0,0,0,.14), 0 2px 8px rgba(0,0,0,.06);
  overflow:hidden;
  animation:axiPanelIn .18s cubic-bezier(.22,.68,0,1.2) both;
  transform-origin:bottom left;
}
@keyframes axiPanelIn {
  from { opacity:0; transform:scale(.94) translateY(6px); }
  to   { opacity:1; transform:scale(1)  translateY(0);   }
}

/* panel header */
.axi-panel-header {
  display:flex; align-items:center; justify-content:space-between;
  padding:10px 14px 8px;
  border-bottom:1px solid #f0f2f8;
}
.axi-panel-title {
  font-size:12px; font-weight:700; color:#1e293b;
  display:flex; align-items:center; gap:6px;
  text-transform:uppercase; letter-spacing:.05em;
}
.axi-panel-close {
  width:22px; height:22px; border-radius:6px;
  border:none; background:transparent; color:#94a3b8;
  cursor:pointer; font-size:15px; line-height:1;
  display:flex; align-items:center; justify-content:center;
  transition:all .15s;
}
.axi-panel-close:hover { background:#f1f5f9; color:#374151; }

/* ── KPI grid ────────────────────────────────────────────── */
.axi-kpi-grid {
  display:grid; grid-template-columns:1fr 1fr;
  gap:1px; background:#edf0f8; margin:0;
}
.axi-kpi-cell {
  display:flex; flex-direction:column; gap:3px;
  padding:11px 14px; background:#f8fafc;
  transition:background .15s; cursor:default;
}
.axi-kpi-cell:hover { background:#f0f4ff; }
.axi-kpi-cell:first-child { border-radius:0; }
.axi-kpi-lbl {
  font-size:9.5px; font-weight:600; color:#8a96b0;
  text-transform:uppercase; letter-spacing:.04em;
}
.axi-kpi-val {
  font-size:15px; font-weight:800; line-height:1;
  font-variant-numeric:tabular-nums;
}
.axi-kpi-val.c-blue   { color:#2563eb; }
.axi-kpi-val.c-green  { color:#059669; }
.axi-kpi-val.c-red    { color:#dc2626; }
.axi-kpi-val.c-purple { color:#7c3aed; }

/* ── status row ──────────────────────────────────────────── */
.axi-status-row {
  display:flex; align-items:center; gap:7px;
  padding:8px 14px;
  border-bottom:1px solid #f0f2f8;
  flex-wrap:wrap;
}
.axi-sbadge {
  display:inline-flex; align-items:center; gap:5px;
  padding:4px 10px; border-radius:20px;
  font-size:11px; font-weight:600;
  cursor:pointer; transition:all .15s; white-space:nowrap;
}
.axi-sbadge:hover { transform:scale(1.04); }
.axi-sbadge--anomaly {
  background:#fff7ed; border:1.5px solid #fdba74; color:#c2410c;
}
.axi-sbadge--good { background:#f0fdf4; border:1.5px solid #86efac; color:#15803d; }
.axi-sbadge--warn { background:#fefce8; border:1.5px solid #fde047; color:#a16207; }
.axi-sbadge--bad  { background:#fef2f2; border:1.5px solid #fca5a5; color:#dc2626; }

/* ── quick actions ───────────────────────────────────────── */
.axi-actions-section {
  padding:8px 10px 10px;
}
.axi-actions-label {
  font-size:9.5px; font-weight:700; color:#9aa3b8;
  text-transform:uppercase; letter-spacing:.05em;
  padding:0 4px 6px;
}
.axi-actions-grid {
  display:grid; grid-template-columns:repeat(3,1fr); gap:5px;
}
.axi-action-tile {
  display:flex; flex-direction:column; align-items:center;
  gap:5px; padding:10px 4px 9px; border-radius:10px;
  border:1.5px solid #e8ecf5; background:#f8fafc;
  cursor:pointer; transition:all .15s;
  font-size:11px; font-weight:500; color:#374151;
  text-align:center; line-height:1.2; font-family:inherit;
}
/* Per-tile colour tints on hover */
.axi-action-tile:nth-child(1):hover { border-color:#bfdbfe; background:#eff6ff; color:#1d4ed8; transform:translateY(-1px); box-shadow:0 3px 8px rgba(37,99,235,.15); }
.axi-action-tile:nth-child(2):hover { border-color:#a7f3d0; background:#ecfdf5; color:#065f46; transform:translateY(-1px); box-shadow:0 3px 8px rgba(5,150,105,.15); }
.axi-action-tile:nth-child(3):hover { border-color:#ddd6fe; background:#f5f3ff; color:#5b21b6; transform:translateY(-1px); box-shadow:0 3px 8px rgba(109,40,217,.15); }
.axi-action-tile:nth-child(4):hover { border-color:#fed7aa; background:#fff7ed; color:#9a3412; transform:translateY(-1px); box-shadow:0 3px 8px rgba(234,88,12,.15); }
.axi-action-tile:nth-child(5):hover { border-color:#fecdd3; background:#fff1f2; color:#9f1239; transform:translateY(-1px); box-shadow:0 3px 8px rgba(225,29,72,.15); }
.axi-action-tile:nth-child(6):hover { border-color:#bae6fd; background:#f0f9ff; color:#075985; transform:translateY(-1px); box-shadow:0 3px 8px rgba(2,132,199,.15); }
.axi-action-tile:active { transform:translateY(0) !important; box-shadow:none !important; }
.axi-action-icon { display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-bottom:1px; }

/* ── "no data" empty state ───────────────────────────────── */
.axi-empty-state {
  padding:24px 14px; text-align:center;
  color:#94a3b8; font-size:12.5px; line-height:1.6;
}
.axi-empty-icon { display:flex; align-items:center; justify-content:center; margin-bottom:10px; opacity:.45; color:#94a3b8; }

/* ── insight pills (in messages) ─────────────────────────── */
.axi-insight-pills {
  display:flex; flex-wrap:wrap; gap:6px; margin:8px 0 6px;
}
.axi-insight-pill {
  display:inline-flex; align-items:center; gap:5px;
  padding:4px 11px; border-radius:20px;
  background:linear-gradient(135deg,#eff6ff,#f0fdf4);
  border:1.5px solid #bfdbfe; color:#1e40af;
  font-size:11.5px; font-weight:600;
  animation:axiPillIn .25s ease both;
}
@keyframes axiPillIn {
  from { opacity:0; transform:translateY(4px); }
  to   { opacity:1; transform:translateY(0);   }
}
.axi-pill-icon { display:inline-flex; align-items:center; flex-shrink:0; opacity:.9; }

/* ── pinned zone (in messages) ───────────────────────────── */
.axi-pinned-zone {
  margin:6px 12px 10px; border-radius:12px; overflow:hidden;
  border:1.5px solid #dbeafe; background:#f8faff;
  box-shadow:0 2px 10px rgba(59,130,246,.09);
  animation:axiPanelIn .2s ease both;
}
.axi-pinned-hdr {
  display:flex; align-items:center; justify-content:space-between;
  padding:6px 12px; background:#eff6ff; border-bottom:1px solid #dbeafe;
}
.axi-pinned-title {
  display:flex; align-items:center; gap:6px;
  font-size:10.5px; font-weight:700; color:#2563eb;
  text-transform:uppercase; letter-spacing:.04em;
}
.axi-pinned-entry {
  padding:9px 14px; font-size:12.5px; color:#374151;
  line-height:1.5; max-height:90px; overflow-y:auto;
  border-top:1px solid #dbeafe;
}
.axi-pinned-entry:first-of-type { border-top:none; }
.axi-pinned-clear {
  display:flex; align-items:center; justify-content:center;
  width:22px; height:22px; border-radius:6px; border:none;
  background:transparent; color:#93c5fd; cursor:pointer;
  font-size:14px; transition:all .15s;
}
.axi-pinned-clear:hover { background:#dbeafe; color:#2563eb; }
.axi-pin-active svg { stroke:#2563eb !important; }

/* ── user message action bar ─────────────────────────────── */
.axiext-user-actions {
  display:flex; gap:4px; justify-content:flex-end;
  margin-top:5px; opacity:0;
  transition:opacity .15s;
}
.message--user:hover .axiext-user-actions { opacity:1; }
.axiext-user-actions .axiext-action-btn {
  width:26px; height:26px; border-radius:7px;
  border:1.5px solid #e8ecf5; background:#f8fafc;
  color:#64748b; display:grid; place-items:center;
  cursor:pointer; transition:all .15s; padding:0;
}
.axiext-user-actions .axiext-action-btn:hover {
  border-color:#93c5fd; background:#eff6ff; color:#1d4ed8;
}
.axiext-user-actions .axiext-action-btn svg {
  width:13px; height:13px; stroke-width:2;
}

/* ═══ TABS — scoped to beat Axpert button resets ════════════ */
#axiInsightsPanel .axi-panel-tabs {
  display:flex !important;
  border-bottom:1.5px solid #edf0f8 !important;
  background:#fafbfe !important;
  padding:0 4px !important;
  gap:0 !important; margin:0 !important;
}
#axiInsightsPanel .axi-panel-tab {
  all:unset !important;
  display:inline-flex !important; align-items:center !important; gap:5px !important;
  padding:8px 13px !important;
  font-size:11.5px !important; font-weight:600 !important;
  cursor:pointer !important; color:#94a3b8 !important;
  background:transparent !important; border:none !important;
  border-bottom:2px solid transparent !important;
  margin-bottom:-1.5px !important; white-space:nowrap !important;
  font-family:inherit !important; line-height:1.4 !important;
  letter-spacing:.01em !important;
  transition:color .15s, border-bottom-color .15s !important;
  box-shadow:none !important; border-radius:0 !important; outline:none !important;
}
#axiInsightsPanel .axi-panel-tab:hover {
  color:#374151 !important; background:transparent !important;
}
#axiInsightsPanel .axi-panel-tab.active {
  color:#2563eb !important;
  border-bottom-color:#2563eb !important;
  background:transparent !important;
}
#axiInsightsPanel .axi-panel-tab svg {
  width:11px !important; height:11px !important;
  flex-shrink:0 !important; opacity:.7 !important; stroke:currentColor !important;
}
#axiInsightsPanel .axi-panel-tab.active svg { opacity:1 !important; }

/* ═══ COLUMN SCHEMA TAB ═════════════════════════════════════ */
.axi-schema-summary {
  display:flex; align-items:center; gap:6px;
  padding:8px 14px; font-size:10.5px; font-weight:600; color:#64748b;
  border-bottom:1px solid #f0f2f8; background:#f8fafc;
}
.axi-schema-summary svg { opacity:.6; flex-shrink:0; }
.axi-schema-list {
  padding:4px 6px 10px; max-height:228px; overflow-y:auto;
}
.axi-schema-list::-webkit-scrollbar { width:3px; }
.axi-schema-list::-webkit-scrollbar-track { background:transparent; }
.axi-schema-list::-webkit-scrollbar-thumb { background:#d1d5db; border-radius:4px; }
.axi-schema-row {
  display:flex !important; align-items:center !important; gap:8px !important;
  padding:6px 8px !important; border-radius:8px !important;
  cursor:pointer !important; transition:background .13s !important;
}
.axi-schema-row:hover { background:#f0f4ff !important; }
.axi-schema-row:hover .axi-schema-col { color:#2563eb !important; }
.axi-schema-type {
  font-size:14px; flex:0 0 22px; text-align:center; line-height:1;
}
.axi-schema-col {
  flex:1 !important; font-size:11.5px !important; font-weight:500 !important;
  color:#374151 !important; white-space:nowrap !important;
  overflow:hidden !important; text-overflow:ellipsis !important;
  transition:color .13s !important; text-transform:capitalize !important;
}
.axi-schema-meta {
  display:flex !important; align-items:center !important;
  gap:6px !important; flex-shrink:0 !important;
}
.axi-schema-bar-wrap {
  width:40px !important; height:5px !important;
  border-radius:3px !important; background:#e5e7eb !important;
  overflow:hidden !important;
}
.axi-schema-bar-fill {
  height:100% !important; border-radius:3px !important;
  transition:width .3s ease !important;
}
.axi-schema-bar-fill.ok   { background:#4ade80 !important; }
.axi-schema-bar-fill.warn { background:#facc15 !important; }
.axi-schema-bar-fill.bad  { background:#f87171 !important; }
.axi-schema-pct {
  font-size:9.5px !important; font-weight:700 !important;
  min-width:28px !important; text-align:right !important; white-space:nowrap !important;
}
.axi-schema-pct.ok   { color:#94a3b8 !important; }
.axi-schema-pct.warn { color:#d97706 !important; }
.axi-schema-pct.bad  { color:#dc2626 !important; }
.axi-schema-empty {
  padding:20px 14px; text-align:center; color:#94a3b8; font-size:12.5px;
}

/* ═══ KPI TREND ARROWS ══════════════════════════════════════ */
.axi-kpi-trend {
  display:flex; align-items:center; gap:3px;
  margin-top:3px; font-size:10.5px; font-weight:700; line-height:1;
}
.axi-kpi-trend.up   { color:#16a34a; }
.axi-kpi-trend.dn   { color:#dc2626; }
.axi-kpi-trend.flat { color:#94a3b8; }
.axi-kpi-trend-icon { font-size:11px; line-height:1; }
.axi-kpi-trend-pct  { font-size:10px; opacity:.85; }

/* ═══ ENHANCED INSIGHT PILLS ════════════════════════════════ */
.axi-insight-pills {
  display:flex; flex-wrap:wrap; gap:6px; margin:10px 0 4px;
}
.axi-insight-pill {
  display:inline-flex; align-items:center; gap:6px;
  padding:5px 13px; border-radius:20px;
  font-size:11.5px; font-weight:600; cursor:pointer;
  animation:axiPillIn .3s cubic-bezier(.22,.68,0,1.2) both;
  transition:transform .13s ease, box-shadow .13s ease;
  user-select:none; white-space:nowrap;
}
.axi-insight-pill:hover { transform:translateY(-2px); box-shadow:0 4px 14px rgba(0,0,0,.12); }
.axi-insight-pill:active { transform:translateY(0); }
.axi-insight-pill.type-currency {
  background:linear-gradient(135deg,#eff6ff,#f0fdf4);
  border:1.5px solid #bfdbfe; color:#1e40af;
}
.axi-insight-pill.type-up {
  background:linear-gradient(135deg,#f0fdf4,#ecfdf5);
  border:1.5px solid #86efac; color:#15803d;
}
.axi-insight-pill.type-down {
  background:linear-gradient(135deg,#fef2f2,#fff7ed);
  border:1.5px solid #fca5a5; color:#b91c1c;
}
.axi-insight-pill.type-count {
  background:linear-gradient(135deg,#faf5ff,#f5f3ff);
  border:1.5px solid #c4b5fd; color:#6d28d9;
}
.axi-insight-pill.type-date {
  background:linear-gradient(135deg,#fffbeb,#fef9c3);
  border:1.5px solid #fde047; color:#854d0e;
}
.axi-insight-pill.type-neutral {
  background:linear-gradient(135deg,#f8fafc,#f1f5f9);
  border:1.5px solid #e2e8f0; color:#475569;
}
@keyframes axiPillIn {
  from { opacity:0; transform:scale(.88) translateY(5px); }
  to   { opacity:1; transform:scale(1) translateY(0); }
}
.axi-pill-icon { display:inline-flex; align-items:center; flex-shrink:0; opacity:.9; }

/* ═══ FOLLOW-UP CHIPS ═══════════════════════════════════════ */
.axi-followup-chips {
  display:flex; flex-wrap:wrap; gap:5px; margin:6px 0 4px;
}
.axi-followup-chip {
  display:inline-flex; align-items:center; gap:5px;
  padding:5px 13px; border-radius:20px;
  font-size:11.5px; font-weight:500;
  border:1.5px dashed #c7d2fe; background:#fafbff; color:#4f46e5;
  cursor:pointer; transition:all .15s;
  animation:axiPillIn .25s ease both; font-family:inherit;
}
.axi-followup-chip:hover {
  background:#eef2ff; border-color:#818cf8; border-style:solid;
  transform:translateY(-1px); box-shadow:0 3px 10px rgba(79,70,229,.15);
}
.axi-followup-chip:active { transform:translateY(0); }
.axi-followup-chip-icon { display:inline-flex; align-items:center; flex-shrink:0; opacity:.75; }

/* ═══ FEEDBACK ROW POLISH ═══════════════════════════════════ */
.axiext-feedback-row {
  display:flex; flex-wrap:wrap; align-items:center; gap:6px;
  margin-top:8px; padding:10px 14px;
  background:#f8fafc; border-radius:10px; border:1.5px solid #e8ecf5;
  animation:axiFeedbackIn .2s ease both;
}
@keyframes axiFeedbackIn {
  from { opacity:0; transform:translateY(4px); }
  to   { opacity:1; transform:translateY(0); }
}
.axiext-feedback-label {
  font-size:11.5px; font-weight:600; color:#374151;
  flex-basis:100%; margin-bottom:2px;
}
.axiext-feedback-chip {
  padding:4px 12px; border-radius:20px; font-size:11px; font-weight:600;
  border:1.5px solid #e2e8f0; background:#fff; color:#52545a;
  cursor:pointer; transition:all .15s; font-family:inherit;
}
.axiext-feedback-chip:hover { border-color:#fca5a5; background:#fef2f2; color:#b91c1c; }
.axiext-btn--active svg { stroke:#2563eb !important; }
.axiext-btn--active { background:#eff6ff !important; border-color:#93c5fd !important; color:#1d4ed8 !important; }


        `

                ;
            document.head.appendChild(el);
        }

        /* ═══════════════════════════════════════════════════════════════════════
           DATA UTILITIES
        ═══════════════════════════════════════════════════════════════════════ */
        const PAYROLL_RE = /payroll|payslip|salary|ytd|lop|wday|mday|deduct|pf\b|esi\b|basic.?pay|net.?pay|earning|allowance|incentive|provident|leave.?bal/i;

        function getRows() {
            return (window.pendingDatabaseData?.data?.length ? window.pendingDatabaseData.data : null)
                || (window.ACTIVEDATABINCONTEXT?.combinedDatabaseRows?.length
                    ? window.ACTIVEDATABINCONTEXT.combinedDatabaseRows : null)
                || null;
        }

        function hasBin() { return !!window.ACTIVEDATABINCONTEXT; }

        function isPayroll(rows) {
            if (!rows?.length) {
                // check bin/datasource names even without rows
                const binName = window.ACTIVEDATABINCONTEXT?.name || '';
                const srcNames = (window.ACTIVEDATABINCONTEXT?.datasources || []).map(d => d.name || d.caption || '').join(' ');
                return PAYROLL_RE.test(binName + ' ' + srcNames);
            }
            const colSig = Object.keys(rows[0] || {}).join(' ');
            const ctx = [colSig, window.ACTIVEDATABINCONTEXT?.name || '', window.pendingDatabaseData?.name || ''].join(' ');
            return PAYROLL_RE.test(ctx);
        }

        function numVal(v) { return parseFloat(String(v ?? '').replace(/,/g, '')); }

        function findCol(rows, re) {
            if (!rows?.length) return null;
            return Object.keys(rows[0]).find(c => re.test(c.trim())) || null;
        }

        function colSum(rows, col) {
            if (!col || !rows?.length) return null;
            let s = 0, n = 0;
            for (const r of rows) { const v = numVal(r[col]); if (!isNaN(v)) { s += v; n++; } }
            return n ? s : null;
        }
        function colAvg(rows, col) {
            if (!col || !rows?.length) return null;
            let s = 0, n = 0;
            for (const r of rows) { const v = numVal(r[col]); if (!isNaN(v)) { s += v; n++; } }
            return n ? s / n : null;
        }

        function colTrend(rows, col) {
            if (!col || !rows || rows.length < 6) return null;
            const mid = Math.floor(rows.length / 2);
            const getAvg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
            const first = rows.slice(0, mid).map(r => numVal(r[col])).filter(v => !isNaN(v));
            const last = rows.slice(mid).map(r => numVal(r[col])).filter(v => !isNaN(v));
            const avgFirst = getAvg(first);
            const avgLast = getAvg(last);
            if (avgFirst === null || avgLast === null || avgFirst === 0) return null;
            const diff = avgLast - avgFirst;
            const pct = (Math.abs(diff) / Math.abs(avgFirst)) * 100;
            if (pct < 1) return { dir: 'flat', pct: '—' };
            return { dir: diff > 0 ? 'up' : 'dn', pct: pct.toFixed(1) };
        }

        function buildSchemaRows(rows) {
            if (!rows?.length) return '<div class="axi-schema-empty">No row data loaded</div>';
            const cols = Object.keys(rows[0]).filter(c => !c.startsWith('__'));
            const total = rows.length;

            const summaryHTML = `
          <div class="axi-schema-summary">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="3" y1="9" x2="21" y2="9"/>
              <line x1="3" y1="15" x2="21" y2="15"/>
              <line x1="9" y1="3" x2="9" y2="21"/>
            </svg>
            ${cols.length} columns &nbsp;·&nbsp; ${total.toLocaleString()} rows &nbsp;·&nbsp; click any row to analyze
          </div>`;

            const rowsHTML = cols.map(col => {
                const vals = rows.map(r => r[col]);
                const nullCount = vals.filter(v =>
                    v === null || v === undefined ||
                    String(v).trim() === '' ||
                    /^null$/i.test(String(v))
                ).length;
                const nullPct = Math.round((nullCount / total) * 100);
                const fillPct = 100 - nullPct;
                const severity = nullPct > 20 ? 'bad' : nullPct > 5 ? 'warn' : 'ok';

                // Type detection
                const nonNull = vals.find(v => v !== null && v !== undefined && String(v).trim() !== '');
                const sv = String(nonNull ?? '');
                let typeIcon, typeTitle;
                if (nonNull !== '' && nonNull !== null && !isNaN(numVal(nonNull))) {
                    typeIcon = IC.numeric; typeTitle = 'Numeric';
                } else if (/^\d{4}-\d{2}-\d{2}/.test(sv) || /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(sv)) {
                    typeIcon = IC.date; typeTitle = 'Date';
                } else if (/^(yes|no|true|false|y|n|active|inactive|enabled|disabled)$/i.test(sv)) {
                    typeIcon = IC.bool; typeTitle = 'Boolean';
                } else {
                    typeIcon = IC.text; typeTitle = 'Text';
                }

                const displayName = _fmtColName(col).slice(0, 32);
                const pctLabel = nullPct === 0 ? '✓' : nullPct + '%';

                return `
              <div class="axi-schema-row"
                   title="${esc(typeTitle)} · ${nullPct}% missing · Click to analyze"
                   onclick="(function(){
                     var p=document.getElementById('prompt');
                     if(!p)return;
                     p.value='Analyze the &quot;${col.replace(/"/g, '')}&quot; column in detail — show distribution, top values, and any anomalies';
                     p.dispatchEvent(new Event('input',{bubbles:true}));
                     p.focus();
                   })()">
                <span class="axi-schema-type" title="${typeTitle}">${typeIcon}</span>
                <span class="axi-schema-col">${esc(displayName)}</span>
                <span class="axi-schema-meta">
                  <span class="axi-schema-bar-wrap" title="${fillPct}% complete">
                    <span class="axi-schema-bar-fill ${severity}" style="width:${fillPct}%"></span>
                  </span>
                  <span class="axi-schema-pct ${severity}">${pctLabel}</span>
                </span>
              </div>`;
            }).join('');

            return summaryHTML + `<div class="axi-schema-list">${rowsHTML}</div>`;
        }

        /**
         * Format a raw column name into a readable display label.
         * Handles: snake_case, camelCase, UPPER_CASE, and
         * common payroll abbreviations (mdays→M Days, lop→LOP, pf→PF…)
         */
        function _fmtColName(col) {
            // Known abbreviations to preserve/expand
            const ABBR = {
                mdays: 'M Days', wdays: 'W Days', lop: 'LOP', pf: 'PF', esi: 'ESI',
                ytd: 'YTD', ctc: 'CTC', hra: 'HRA', tds: 'TDS', pt: 'PT',
                id: 'ID', empid: 'Emp ID', dob: 'DOB', doj: 'DOJ',
            };
            const lower = col.toLowerCase().replace(/[_\-\s]+/g, '');
            if (ABBR[lower]) return ABBR[lower];

            return col
                // snake_case / kebab-case → spaces
                .replace(/[_\-]+/g, ' ')
                // camelCase → spaces  (addordeduct → still lowercase, handled below)
                .replace(/([a-z])([A-Z])/g, '$1 $2')
                // Capitalise every word
                .replace(/\b\w/g, c => c.toUpperCase())
                .trim();
        }

        function buildFollowUpChips(text) {
            const chips = [];
            if (/summary|overview|total|breakdown/i.test(text))
                chips.push({ icon: IC.barChart, label: 'Visualize as chart', prompt: 'Create a chart for the key metrics mentioned' });
            if (/trend|month|year|quarter|period|over time/i.test(text))
                chips.push({ icon: IC.trendUp, label: 'Show trend over time', prompt: 'Show this data trend over time as a line chart' });
            if (/anomal|outlier|issue|unusual|problem|zero|missing/i.test(text))
                chips.push({ icon: IC.search, label: 'Dig into anomalies', prompt: 'Analyze the root causes of these anomalies in detail' });
            if (/top|highest|maximum|rank|best|leading/i.test(text))
                chips.push({ icon: IC.ranked, label: 'Show bottom 10 too', prompt: 'Also show the bottom 10 by the same metric for comparison' });
            if (/average|mean|distribution|range|median/i.test(text))
                chips.push({ icon: IC.dist, label: 'Show distribution', prompt: 'Show the data distribution as a histogram or box plot' });
            if (/compare|difference|vs|versus|against/i.test(text))
                chips.push({ icon: IC.compare, label: 'Detailed comparison', prompt: 'Create a detailed side-by-side comparison table with percentage differences' });
            return chips.slice(0, 2);
        }

        function fmtINR(n) {
            if (n === null || isNaN(n)) return '—';
            const a = Math.abs(n);
            if (a >= 1e7) return '₹' + (n / 1e7).toFixed(1) + 'Cr';
            if (a >= 1e5) return '₹' + (n / 1e5).toFixed(1) + 'L';
            if (a >= 1e3) return '₹' + (n / 1e3).toFixed(1) + 'K';
            return '₹' + n.toFixed(0);
        }

        function fmtNum(n) {
            if (n === null || n === undefined || isNaN(n)) return '—';
            const a = Math.abs(n);
            if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
            if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
            if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
            return n % 1 === 0 ? n.toLocaleString() : n.toFixed(2);
        }

        function computeKPIs(rows) {
            if (!rows?.length) return null;
            const payroll = isPayroll(rows);

            if (payroll) {
                const grossCol = findCol(rows, /^(gross[_\s]?(pay|salary|earnings?|amount)?|ctc|total[_\s]?earn|earnings?)$/i);
                const netCol = findCol(rows, /^(net[_\s]?(pay|salary|take[_\s]?home)|take[_\s]?home)$/i);
                const deductCol = findCol(rows, /^(total[_\s]?deduct|deduction|deduct)$/i);
                const basicCol = findCol(rows, /^(basic[_\s]?(pay|salary)?)$/i);
                const netSum = colSum(rows, netCol);
                const grossSum = colSum(rows, grossCol || basicCol);
                let dedSum = colSum(rows, deductCol);
                if (dedSum === null && grossSum !== null && netSum !== null) dedSum = grossSum - netSum;
                return {
                    kpis: [
                        { label: 'Total Earnings', value: fmtINR(grossSum), color: 'c-blue', trend: colTrend(rows, grossCol || basicCol) },
                        { label: 'Avg Net Pay', value: fmtINR(colAvg(rows, netCol)), color: 'c-green', trend: colTrend(rows, netCol) },
                        { label: 'Total Deductions', value: fmtINR(dedSum), color: 'c-red', trend: null },
                        { label: '# Records', value: rows.length.toLocaleString(), color: 'c-purple', trend: null }
                    ]
                };
            }

            // Generic — top 3 numeric columns by magnitude + record count
            const cols = Object.keys(rows[0]).filter(c => !c.startsWith('__'));
            const numCols = [];
            for (const col of cols) {
                const vals = rows.map(r => numVal(r[col])).filter(v => !isNaN(v));
                if (vals.length >= rows.length * 0.4) {
                    numCols.push({ col, sum: vals.reduce((a, b) => a + b, 0) });
                }
            }
            numCols.sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum));
            const COLORS = ['c-blue', 'c-green', 'c-red'];
            const kpis = numCols.slice(0, 3).map(({ col, sum }, i) => ({
                label: col.replace(/[_\-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 22),
                value: fmtNum(sum),
                color: COLORS[i],
                trend: colTrend(rows, col)
            }));
            kpis.push({ label: '# Records', value: rows.length.toLocaleString(), color: 'c-purple', trend: null });
            return { kpis };
        }
        /* ─── Anomaly detection ───────────────────────────────────────────────── */
        function detectAnomalies(rows) {
            if (!rows?.length) return [];
            const anomalies = [], cols = Object.keys(rows[0] || {}).filter(c => !c.startsWith('__'));
            for (const col of cols) {
                const raw = rows.map(r => { const v = numVal(r[col]); return isNaN(v) ? null : v; });
                const missing = raw.filter(v => v === null).length;
                if (missing) anomalies.push({ col, detail: `${missing} missing value${missing > 1 ? 's' : ''} in "${col}"` });
                const nums = raw.filter(v => v !== null);
                if (nums.length < 3) continue;
                const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
                const std = Math.sqrt(nums.reduce((a, v) => a + (v - mean) ** 2, 0) / nums.length);
                if (!std) continue;
                const outs = nums.filter(v => Math.abs(v - mean) > 3 * std).length;
                if (outs) anomalies.push({ col, detail: `${outs} outlier${outs > 1 ? 's' : ''} in "${col}" (>3σ)` });
                if (/salary|pay|earn|gross|net/i.test(col)) {
                    const zeros = nums.filter(v => v === 0).length;
                    if (zeros) anomalies.push({ col, detail: `${zeros} zero${zeros > 1 ? 's' : ''} in pay field "${col}"` });
                }
            }
            return anomalies;
        }

        /* ─── Data health ─────────────────────────────────────────────────────── */
        function computeHealth(rows) {
            if (!rows?.length) return { grade: 'warn', icon: IC.circle, label: 'No data', detail: 'No rows loaded' };
            const cols = Object.keys(rows[0] || {}).filter(c => !c.startsWith('__'));
            const total = rows.length * cols.length;
            let nulls = 0;
            for (const r of rows) for (const c of cols) {
                const v = r[c];
                if (v === null || v === undefined || v === '' || /^null$/i.test(String(v))) nulls++;
            }
            const sig = rows.map(r => cols.slice(0, 3).map(c => String(r[c] ?? '')).join('|'));
            const dupes = sig.length - new Set(sig).size;
            const nullPct = (nulls / total) * 100;
            const issues = [];
            if (nullPct > 5) issues.push(`${nullPct.toFixed(0)}% missing cells`);
            if (dupes > 0) issues.push(`${dupes} duplicate row${dupes > 1 ? 's' : ''}`);
            if (!issues.length) return { grade: 'good', icon: IC.checkCircle, label: 'Data Healthy', detail: `${rows.length} rows · ${cols.length} cols` };
            if (issues.length === 1) return { grade: 'warn', icon: IC.alertTri, label: 'Data Issues', detail: issues[0] };
            return { grade: 'bad', icon: IC.xCircle, label: 'Data Problems', detail: issues.join('; ') };
        }

        /* ═══════════════════════════════════════════════════════════════════════
           SEND PROMPT
        ═══════════════════════════════════════════════════════════════════════ */
        function sendPrompt(text) {
            closePanel();
            const p = $('#prompt'); if (!p) return;
            p.value = text; p.dispatchEvent(new Event('input', { bubbles: true })); p.focus();
            setTimeout(() => {
                const btn = $('#send') || $('[type="submit"]', $('#composer'));
                if (btn) btn.click();
                else if (typeof handleSend === 'function') handleSend();
            }, 90);
        }

        /* ═══════════════════════════════════════════════════════════════════════
           QUICK ACTIONS CONFIG (includes payroll-specific ones)
        ═══════════════════════════════════════════════════════════════════════ */
        function buildActions(payroll) {
            const base = [
                { icon: IC.barChart, label: 'Charts', prompt: 'Create charts for the key metrics in this data' },
                { icon: IC.list, label: 'Summary', prompt: 'Give me a concise executive summary of this dataset with key statistics and highlights' },
                { icon: IC.search, label: 'Anomalies', prompt: 'Identify anomalies, outliers, and unusual patterns in this data and explain what they might indicate' },
                { icon: IC.report, label: 'Report', prompt: 'Generate a comprehensive analysis report with insights, charts, and recommendations' },
            ];
            if (payroll) {
                base.push(
                    { icon: IC.compare, label: 'Compare', prompt: 'Compare this month vs last month — show differences in total earnings, deductions, and net pay with percentage changes' },
                    { icon: IC.trendUp, label: 'Trend', prompt: 'Show the trend of total earnings, net salary, and total deductions across all available months as a line chart' }
                );
            } else {
                base.push(
                    { icon: IC.trendUp, label: 'Trends', prompt: 'Show the key trends and changes over time as a line or area chart' },
                    { icon: IC.ranked, label: 'Top 10', prompt: 'Show the top 10 records by the most significant numeric metric as a ranked bar chart' }
                );
            }
            return base;
        }

        /* ═══════════════════════════════════════════════════════════════════════
           PANEL BUILD & TOGGLE
        ═══════════════════════════════════════════════════════════════════════ */
        let panelOpen = false;

        function buildPanelContent() {
            const rows = getRows();
            const hasData = rows?.length > 0 || hasBin();

            /* ── Empty state ───────────────────────────────────────────────── */
            if (!hasData) {
                return `
              <div class="axi-panel-header">
                <div class="axi-panel-title">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                  Data Insights
                </div>
                <button class="axi-panel-close" id="_axiPanelClose">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
              <div class="axi-empty-state">
              <div class="axi-empty-icon">${IC.folder}</div>
                <div>Load a <strong>Data Bin</strong> or upload a file to see live KPIs, anomaly detection, column explorer, and quick actions here.</div>
              </div>`;
            }

            /* ── Data available ────────────────────────────────────────────── */
            const payroll = isPayroll(rows || []);
            const kpis = rows ? computeKPIs(rows) : null;
            const health = rows ? computeHealth(rows) : null;
            const anomalies = rows ? detectAnomalies(rows) : [];
            const binName = window.ACTIVEDATABINCONTEXT?.name || '';
            const colCount = rows ? Object.keys(rows[0]).filter(c => !c.startsWith('__')).length : 0;
            const panelTitle = payroll ? 'Payroll Insights' : (binName || 'Data') + ' Insights';

            /* ── KPI Grid ─────────────────────────────────────────────────── */
            const kpiHTML = kpis?.kpis?.length ? `
          <div class="axi-kpi-grid">
            ${kpis.kpis.map(k => {
                let trendHTML = '';
                if (k.trend) {
                    const arrow = k.trend.dir === 'up' ? '↑' : k.trend.dir === 'dn' ? '↓' : '→';
                    trendHTML = `
                      <div class="axi-kpi-trend ${k.trend.dir}" title="${k.trend.pct !== '—' ? k.trend.pct + '% vs first half' : 'No significant trend'}">
                        <span class="axi-kpi-trend-icon">${arrow}</span>
                        <span class="axi-kpi-trend-pct">${k.trend.pct !== '—' ? k.trend.pct + '%' : 'flat'}</span>
                      </div>`;
                }
                return `
                  <div class="axi-kpi-cell" title="${esc(k.label)}">
                    <span class="axi-kpi-lbl">${esc(k.label)}</span>
                    <span class="axi-kpi-val ${k.color}">${esc(k.value)}</span>
                    ${trendHTML}
                  </div>`;
            }).join('')}
          </div>` : '';

            /* ── Status badges ─────────────────────────────────────────────── */
            const anomalyBadge = anomalies.length ? `
          <div class="axi-sbadge axi-sbadge--anomaly" id="_axiAnomalyBadge"
               title="${esc(anomalies.slice(0, 3).map(a => a.detail).join(' | '))}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            ⚠️ ${anomalies.length} anomal${anomalies.length === 1 ? 'y' : 'ies'}
          </div>` : '';

            const healthBadge = health ? `
          <div class="axi-sbadge axi-sbadge--${health.grade}" id="_axiHealthBadge" title="${esc(health.detail)}">
            ${health.icon} ${health.label}
          </div>` : '';

            const statusRow = (anomalyBadge || healthBadge) ? `
          <div class="axi-status-row">${anomalyBadge}${healthBadge}</div>` : '';

            /* ── Quick Action Tiles ────────────────────────────────────────── */
            const tiles = buildActions(payroll).map(a => `
          <button class="axi-action-tile" data-prompt="${esc(a.prompt)}" title="${esc(a.prompt)}">
            <span class="axi-action-icon">${a.icon}</span>
            ${esc(a.label)}
          </button>`).join('');

            const actionsHTML = `
          <div class="axi-actions-section">
            <div class="axi-actions-label">Quick Actions</div>
            <div class="axi-actions-grid">${tiles}</div>
          </div>`;

            /* ── Schema tab content ────────────────────────────────────────── */
            const schemaHTML = rows ? buildSchemaRows(rows)
                : '<div class="axi-schema-empty">No row data available</div>';

            /* ── Assemble ─────────────────────────────────────────────────── */
            return `
          <div class="axi-panel-header">
            <div class="axi-panel-title">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
              </svg>
              ${esc(panelTitle)}
            </div>
            <button class="axi-panel-close" id="_axiPanelClose">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
     
          <div class="axi-panel-tabs">
            <button class="axi-panel-tab active" data-tab="insights">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
              </svg>
              Insights
            </button>
            <button class="axi-panel-tab" data-tab="schema">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <line x1="3" y1="9" x2="21" y2="9"/>
                <line x1="3" y1="15" x2="21" y2="15"/>
                <line x1="9" y1="3" x2="9" y2="21"/>
              </svg>
              Columns${colCount ? ` (${colCount})` : ''}
            </button>
          </div>
     
          <div id="_axiInsightsTabContent">
            ${kpiHTML}
            ${statusRow}
            ${actionsHTML}
          </div>
     
          <div id="_axiSchemaTabContent" style="display:none;">
            ${schemaHTML}
          </div>`;
        }



        function closePanel() {
            const panel = $('#axiInsightsPanel');
            if (panel) panel.style.display = 'none';
            const btn = $('#axiInsightsBtn');
            if (btn) btn.classList.remove('axi-btn-active');
            panelOpen = false;
        }

        /* ═══════════════════════════════════════════════════════════════════════
           BUTTON INJECTION
        ═══════════════════════════════════════════════════════════════════════ */
        function injectButton() {
            if ($('#axiInsightsBtn')) return;

            const shell = $('.composerShell');
            const pinsWrapper = $('#savedPinsWrapper');
            if (!shell) return;

            // create wrapper with relative positioning for the floating panel
            const wrap = document.createElement('div');
            wrap.className = 'axi-insights-wrap';
            wrap.style.cssText = 'position:relative; display:inline-flex; align-items:center; flex-shrink:0;';

            const btn = document.createElement('button');
            btn.id = 'axiInsightsBtn';
            btn.type = 'button';
            btn.title = 'Data Insights';
            btn.innerHTML = `
          <span class="axi-btn-icon">${IC.zap}</span>
          Insights
          <svg class="axi-btn-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          <span id="axiInsightsBadge"></span>`;

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                panelOpen ? closePanel() : openPanel();
            });

            wrap.appendChild(btn);

            // Insert after savedPinsWrapper if it exists, else prepend to shell
            if (pinsWrapper && pinsWrapper.parentElement === shell) {
                pinsWrapper.insertAdjacentElement('afterend', wrap);
            } else {
                shell.insertBefore(wrap, shell.firstChild);
            }
        }

        /* update the notification badge on the button */
        function updateBtnBadge() {
            const badge = $('#axiInsightsBadge');
            if (!badge) return;
            const rows = getRows();
            if (!rows?.length) { badge.className = ''; return; }
            const anomalies = detectAnomalies(rows);
            if (anomalies.length) {
                badge.textContent = anomalies.length;
                badge.className = 'visible';
            } else {
                badge.className = '';
            }
        }

        /* refresh open panel when context changes */
        function openPanel() {
            // ── Close DataBin dropdown if open ──
            document.getElementById('savedPinsWrapper')?.classList.remove('open');
            const btn = $('#axiInsightsBtn');
            if (!btn) return;

            let panel = $('#axiInsightsPanel');
            if (!panel) {
                panel = document.createElement('div');
                panel.id = 'axiInsightsPanel';
                const wrapper = btn.closest('.axi-insights-wrap') || btn.parentElement;
                wrapper.style.position = 'relative';
                wrapper.appendChild(panel);
            }

            panel.innerHTML = buildPanelContent();
            panel.style.display = 'block';
            panelOpen = true;
            btn.classList.add('axi-btn-active');
            _wirePanelEvents(panel);
        }

        function _wirePanelEvents(panel) {
            // Close
            $('#_axiPanelClose')?.addEventListener('click', closePanel);

            // Action tiles
            $$('.axi-action-tile', panel).forEach(tile => {
                tile.addEventListener('click', () => sendPrompt(tile.dataset.prompt));
            });

            // Anomaly badge
            const anomBadge = $('#_axiAnomalyBadge');
            if (anomBadge) {
                anomBadge.addEventListener('click', () => {
                    const r = getRows() || [];
                    const detail = detectAnomalies(r).map(a => a.detail).join('; ');
                    sendPrompt(`I scanned the data and found these anomalies: ${detail}. Please analyze and explain what they mean and how to fix them.`);
                });
            }

            // Health badge
            const hBadge = $('#_axiHealthBadge');
            if (hBadge) {
                hBadge.addEventListener('click', () => {
                    const r = getRows() || [];
                    const h = computeHealth(r);
                    sendPrompt(`Run a data quality assessment. Client-side finding: ${h.detail}. Provide a detailed data quality report with actionable fixes.`);
                });
            }

            // Tabs
            $$('.axi-panel-tab', panel).forEach(tab => {
                tab.addEventListener('click', () => {
                    $$('.axi-panel-tab', panel).forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    const insightsContent = $('#_axiInsightsTabContent', panel);
                    const schemaContent = $('#_axiSchemaTabContent', panel);
                    if (insightsContent) insightsContent.style.display = tab.dataset.tab === 'insights' ? '' : 'none';
                    if (schemaContent) schemaContent.style.display = tab.dataset.tab === 'schema' ? '' : 'none';
                });
            });
        }

        function refreshPanelIfOpen() {
            if (!panelOpen) return;
            const panel = $('#axiInsightsPanel');
            if (!panel) return;
            // Remember which tab was active
            const activeTab = panel.querySelector('.axi-panel-tab.active')?.dataset?.tab || 'insights';
            panel.innerHTML = buildPanelContent();
            _wirePanelEvents(panel);
            // Restore active tab if it was schema
            if (activeTab === 'schema') {
                $$('.axi-panel-tab', panel).forEach(t => t.classList.remove('active'));
                panel.querySelector('[data-tab="schema"]')?.classList.add('active');
                const ic = $('#_axiInsightsTabContent', panel);
                const sc = $('#_axiSchemaTabContent', panel);
                if (ic) ic.style.display = 'none';
                if (sc) sc.style.display = '';
            }
        }

        /* ═══════════════════════════════════════════════════════════════════════
           4. SMART INSIGHT PILLS (in AI messages)
        ═══════════════════════════════════════════════════════════════════════ */
        function extractInsights(text) {
            const pills = [], seen = new Set();

            // ── INR amounts with label ─────────────────────────────────────
            const INR = /((?:total|average|avg|net|gross|highest|lowest|max|min|sum of)[\w\s]{0,28}?)(?:is|was|are|:)?\s*(₹[\d,]+(?:\.\d+)?(?:\s*(?:lakh|crore|[LKCr]+))?)/gi;
            let m;
            while ((m = INR.exec(text)) && pills.length < 6) {
                const label = m[1].trim().replace(/\s+/g, ' ');
                const val = m[2], key = val.toLowerCase();
                if (!seen.has(key) && label.length > 1 && label.length < 60) {
                    seen.add(key);
                    pills.push({ icon: IC.currency, text: `${label}: ${val}`, type: 'currency' });
                }
            }

            // ── USD amounts ────────────────────────────────────────────────
            const USD = /((?:total|average|avg|net|gross|highest|lowest|max|min)[\w\s]{0,28}?)(?:is|was|:)?\s*(\$[\d,]+(?:\.\d+)?(?:[KMB])?)/gi;
            while ((m = USD.exec(text)) && pills.length < 6) {
                const label = m[1].trim().replace(/\s+/g, ' ');
                const val = m[2], key = val.toLowerCase();
                if (!seen.has(key) && label.length > 1 && label.length < 60) {
                    seen.add(key);
                    pills.push({ icon: IC.currency, text: `${label}: ${val}`, type: 'currency' });
                }
            }

            // ── Percentage increases ───────────────────────────────────────
            const PCT_UP = /(\d+(?:\.\d+)?%)\s*((?:increase|growth|up|higher|more|improvement|rise|gain)[\w\s]{0,25})/gi;
            while ((m = PCT_UP.exec(text)) && pills.length < 6) {
                const raw = `${m[1]} ${m[2].trim()}`.slice(0, 58);
                if (!seen.has(raw.toLowerCase())) {
                    seen.add(raw.toLowerCase());
                    pills.push({ icon: IC.up, text: raw, type: 'up' });
                }
            }

            // ── Percentage decreases ───────────────────────────────────────
            const PCT_DN = /(\d+(?:\.\d+)?%)\s*((?:decrease|decline|down|lower|less|drop|reduction|fall)[\w\s]{0,25})/gi;
            while ((m = PCT_DN.exec(text)) && pills.length < 6) {
                const raw = `${m[1]} ${m[2].trim()}`.slice(0, 58);
                if (!seen.has(raw.toLowerCase())) {
                    seen.add(raw.toLowerCase());
                    pills.push({ icon: IC.down, text: raw, type: 'down' });
                }
            }

            // ── Headcounts / record counts ─────────────────────────────────
            const CNT = /(\d[\d,]+)\s*(employees?|workers?|staff|records?|rows?|entries|users?|customers?|orders?|transactions?|vendors?|clients?)/gi;
            while ((m = CNT.exec(text)) && pills.length < 6) {
                const raw = `${m[1]} ${m[2]}`;
                if (!seen.has(raw.toLowerCase())) {
                    seen.add(raw.toLowerCase());
                    pills.push({ icon: IC.users, text: raw, type: 'count' });
                }
            }

            // ── Months / Quarters / FY ─────────────────────────────────────
            const DATE_RE = /((?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+\d{4}|q[1-4]\s*(?:fy\s*)?\d{2,4}|fy\s*\d{2,4})/gi;
            while ((m = DATE_RE.exec(text)) && pills.length < 6) {
                const raw = m[1].trim();
                if (!seen.has(raw.toLowerCase())) {
                    seen.add(raw.toLowerCase());
                    pills.push({ icon: IC.calendar, text: raw, type: 'date' });
                }
            }

            return pills.slice(0, 4);
        }

        function injectInsightPills(msgNode) {
            if (msgNode.dataset.axiPillsDone) return;
            msgNode.dataset.axiPillsDone = '1';
            const bubble = msgNode.querySelector('.message__bubble,.messagebubble,.bubble');
            if (!bubble) return;

            const rawText = bubble.innerText || bubble.textContent || '';
            const insights = extractInsights(rawText);
            const followUps = buildFollowUpChips(rawText);

            if (!insights.length && !followUps.length) return;

            // ── Insight Pills ──────────────────────────────────────────────
            if (insights.length) {
                const pillWrap = document.createElement('div');
                pillWrap.className = 'axi-insight-pills';
                insights.forEach((ins, i) => {
                    const pill = document.createElement('div');
                    pill.className = `axi-insight-pill type-${ins.type || 'neutral'}`;
                    pill.style.animationDelay = `${i * 0.07}s`;
                    pill.title = 'Click to explore this insight';
                    pill.innerHTML = `<span class="axi-pill-icon">${ins.icon}</span><span>${esc(ins.text)}</span>`;
                    pill.addEventListener('click', () => {
                        const p = document.getElementById('prompt');
                        if (!p) return;
                        p.value = `Tell me more about: ${ins.text}`;
                        p.dispatchEvent(new Event('input', { bubbles: true }));
                        p.focus();
                    });
                    pillWrap.appendChild(pill);
                });
                bubble.parentElement.insertBefore(pillWrap, bubble.nextSibling);
            }

            // ── Follow-up Chips ────────────────────────────────────────────
            if (followUps.length) {
                const chipWrap = document.createElement('div');
                chipWrap.className = 'axi-followup-chips';
                const pillsEl = bubble.parentElement.querySelector('.axi-insight-pills');
                followUps.forEach((fc, i) => {
                    const chip = document.createElement('button');
                    chip.className = 'axi-followup-chip';
                    chip.type = 'button';
                    chip.style.animationDelay = `${(insights.length + i) * 0.08}s`;
                    chip.innerHTML = `<span class="axi-followup-chip-icon">${fc.icon}</span>${esc(fc.label)}`;
                    chip.addEventListener('click', () => {
                        const p = document.getElementById('prompt');
                        if (!p) return;
                        p.value = fc.prompt;
                        p.dispatchEvent(new Event('input', { bubbles: true }));
                        p.focus();
                        setTimeout(() => {
                            const sendBtn = document.getElementById('send');
                            if (sendBtn) sendBtn.click();
                        }, 80);
                    });
                    chipWrap.appendChild(chip);
                });
                const insertAfter = pillsEl || bubble;
                insertAfter.parentElement.insertBefore(chipWrap, (pillsEl || bubble).nextSibling);
            }
        }

        function injectFollowUpChips(msgNode) {
            if (msgNode.dataset.axiFollowupDone) return;
            msgNode.dataset.axiFollowupDone = '1';
            const bubble = msgNode.querySelector('.message__bubble,.messagebubble,.bubble');
            if (!bubble) return;
            const text = (bubble.innerText || '').toLowerCase();

            const suggestions = [];
            if (/summary|overview|total/i.test(text)) suggestions.push('Break this down by category');
            if (/trend|month|year|quarter/i.test(text)) suggestions.push('Show this as a chart');
            if (/anomal|outlier|issue|problem/i.test(text)) suggestions.push('What caused these anomalies?');
            if (/top|highest|maximum|rank/i.test(text)) suggestions.push('Show the bottom 10 as well');
            if (/average|mean|median/i.test(text)) suggestions.push('Show distribution histogram');
            if (!suggestions.length) return;

            const wrap = document.createElement('div');
            wrap.className = 'axi-followup-chips';
            suggestions.slice(0, 3).forEach(s => {
                const chip = document.createElement('button');
                chip.className = 'axi-followup-chip';
                chip.textContent = s;
                chip.addEventListener('click', () => sendPrompt(s));
                wrap.appendChild(chip);
            });
            bubble.parentElement.insertBefore(wrap, bubble.nextSibling);
        }

        /* ═══════════════════════════════════════════════════════════════════════
           7. PIN MESSAGE
        ═══════════════════════════════════════════════════════════════════════ */
        const PINS = [];

        function injectPinButton(msgNode) {
            if (msgNode.dataset.axiPinDone) return;
            msgNode.dataset.axiPinDone = '1';
            const tryInject = (attempt) => {
                const bar = msgNode.querySelector('.axiext-actions');
                if (!bar && attempt < 10) { setTimeout(() => tryInject(attempt + 1), 150); return; }
                if (!bar) return;
                const pinBtn = document.createElement('button');
                pinBtn.className = 'axiext-action-btn';
                pinBtn.type = 'button';
                pinBtn.title = 'Pin message';
                pinBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
                const msgId = msgNode.dataset.axiMsgId || `msg-${Date.now()}`;
                msgNode.dataset.axiMsgId = msgId;
                pinBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const bubble = msgNode.querySelector('.message__bubble,.messagebubble,.bubble');
                    const text = bubble?.innerText?.trim() || '';
                    const idx = PINS.findIndex(p => p.id === msgId);
                    if (idx > -1) {
                        PINS.splice(idx, 1);
                        pinBtn.classList.remove('axi-pin-active');
                        pinBtn.title = 'Pin message';
                    } else {
                        if (PINS.length >= 3) PINS.shift();
                        PINS.push({ id: msgId, text });
                        pinBtn.classList.add('axi-pin-active');
                        pinBtn.title = 'Unpin message';
                    }
                    renderPinnedZone();
                });
                bar.appendChild(pinBtn);
            };
            tryInject(0);
        }

        function renderPinnedZone() {
            const messagesEl = $('#messages'); if (!messagesEl) return;
            const existing = $('#axiPinnedZone');
            if (!PINS.length) { existing?.remove(); return; }
            let zone = existing;
            if (!zone) {
                zone = document.createElement('div');
                zone.id = 'axiPinnedZone';
                zone.className = 'axi-pinned-zone';
                messagesEl.insertBefore(zone, messagesEl.firstChild);
            }
            zone.innerHTML = `
          <div class="axi-pinned-hdr">
            <div class="axi-pinned-title">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              Pinned${PINS.length > 1 ? ` · ${PINS.length}` : ''}
            </div>
            <button class="axi-pinned-clear" id="_axiClearPins" title="Remove all pins">✕</button>
          </div>
          ${PINS.map(p => `<div class="axi-pinned-entry" data-pin-id="${p.id}" title="Click to jump to message" style="cursor:pointer;">${esc(p.text.slice(0, 500))}${p.text.length > 500 ? '…' : ''}</div>`).join('')}`;
            $('#_axiClearPins')?.addEventListener('click', () => {
                PINS.length = 0;
                $$('.axi-pin-active').forEach(b => { b.classList.remove('axi-pin-active'); b.title = 'Pin message'; });
                zone.remove();
            });
            zone.querySelectorAll('.axi-pinned-entry[data-pin-id]').forEach(entry => {
                entry.addEventListener('click', () => {
                    const target = document.querySelector(`[data-axi-msg-id="${entry.dataset.pinId}"]`);
                    if (!target) return;
                    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    target.style.transition = 'box-shadow 0.4s ease';
                    target.style.boxShadow = '0 0 0 3px rgba(37,99,235,0.35)';
                    setTimeout(() => { target.style.boxShadow = ''; }, 1600);
                });
            });
        }

        // Exposed so the delete-message handler (different IIFE) can remove a pin
        // when its source message is deleted from the chat.
        window._axiRemovePin = function (msgId) {
            const idx = PINS.findIndex(p => p.id === msgId);
            if (idx === -1) return;
            PINS.splice(idx, 1);
            // Clear the active state on the pin button if the node is still in the DOM
            const msgNode = document.querySelector(`[data-axi-msg-id="${msgId}"]`);
            if (msgNode) {
                const btn = msgNode.querySelector('.axi-pin-active');
                if (btn) { btn.classList.remove('axi-pin-active'); btn.title = 'Pin message'; }
            }
            renderPinnedZone();
        };

        /* ═══════════════════════════════════════════════════════════════════════
           MESSAGE OBSERVER
        ═══════════════════════════════════════════════════════════════════════ */
        function hookMessages() {
            const el = $('#messages'); if (!el) return;
            const handle = (node) => {
                if (node.nodeType !== 1 || !node.classList?.contains('message--assistant')) return;
                if (node.classList.contains('axi-streaming-msg')) {
                    const obs = new MutationObserver(() => {
                        if (!node.classList.contains('axi-streaming-msg')) {
                            obs.disconnect();
                            setTimeout(() => { injectInsightPills(node); injectPinButton(node); }, 350);
                        }
                    });
                    obs.observe(node, { attributes: true, attributeFilter: ['class'] });
                } else {
                    setTimeout(() => { injectInsightPills(node); injectPinButton(node); }, 350);
                }
            };
            new MutationObserver(m => m.forEach(r => r.addedNodes.forEach(handle)))
                .observe(el, { childList: true, subtree: false });
            $$('.message--assistant', el).forEach(n => {
                if (!n.classList.contains('axi-streaming-msg')) { injectInsightPills(n); injectPinButton(n); }
            });
        }

        /* ═══════════════════════════════════════════════════════════════════════
           DATA WATCHER
        ═══════════════════════════════════════════════════════════════════════ */
        function watchData() {
            let lastSig = '', debounce = null;
            setInterval(() => {
                const rows = getRows();
                const sig = `${rows?.length || 0}|${window.ACTIVEDATABINCONTEXT?.id || ''}|${window.pendingDatabaseData?.name || ''}`;
                if (sig !== lastSig) { lastSig = sig; clearTimeout(debounce); debounce = setTimeout(() => { updateBtnBadge(); refreshPanelIfOpen(); }, 280); }
            }, 900);
        }

        /* close panel on outside click */
        function hookOutsideClick() {
            document.addEventListener('click', (e) => {
                const panel = $('#axiInsightsPanel'), btn = $('#axiInsightsBtn');
                if (panelOpen && panel && !panel.contains(e.target) && !btn?.contains(e.target)) closePanel();
            }, true);
        }

        /* ═══════════════════════════════════════════════════════════════════════
           INIT
        ═══════════════════════════════════════════════════════════════════════ */
        function init() {
            injectStyles();
            injectButton();
            hookMessages();
            watchData();
            hookOutsideClick();
            setTimeout(updateBtnBadge, 1200);
            console.info('[AXI Smart Features v2.0] ✅  Compact Insights Dropdown loaded');
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(init, 900));
        } else {
            setTimeout(init, 900);
        }
    })();


    /* ───────────────────────────────────────────────────────────────────────────
       FEATURE 5 — PROMPT TEMPLATES
       ─────────────────────────────────────────────────────────────────────────── */
    (function AXIPromptTemplates() {
        'use strict';
        const $ = s => document.querySelector(s);
        const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let panelOpen = false;

        const TEMPLATES = [
            {
                category: 'Analysis', icon: '📊',
                items: [
                    {
                        label: 'Executive Summary', desc: 'Key stats, highlights & business insights',
                        prompt: 'Give me a concise executive summary of this dataset with key statistics, highlights, and actionable business insights'
                    },
                    {
                        label: 'Anomaly Detection', desc: 'Outliers, missing data & unusual patterns',
                        prompt: 'Identify all anomalies, outliers, and unusual patterns in this data. Explain what each might indicate and recommend fixes.'
                    },
                    {
                        label: 'Correlation Analysis', desc: 'Relationships & dependencies between columns',
                        prompt: 'Find and explain the strongest correlations and relationships between columns in this dataset. Visualize the top correlations.'
                    },
                    {
                        label: 'Data Quality Report', desc: 'Missing values, duplicates & issues',
                        prompt: 'Generate a detailed data quality report — missing values, duplicates, inconsistencies, outliers, and specific recommendations to fix them.'
                    },
                ]
            },
            {
                category: 'Charts & Visuals', icon: '📈',
                items: [
                    {
                        label: 'KPI Dashboard', desc: '3–4 charts with the most important metrics',
                        prompt: 'Create an interactive dashboard with 3-4 charts showing the most important KPIs in this data. Include a summary below each chart.'
                    },
                    {
                        label: 'Top 10 Bar Chart', desc: 'Ranked bar chart by key metric',
                        prompt: 'Show the top 10 records by the most significant numeric metric as a ranked horizontal bar chart with values labeled.'
                    },
                    {
                        label: 'Trend Over Time', desc: 'Line / area chart of key changes',
                        prompt: 'Show the key metrics trend over time as a line or area chart. Annotate any significant changes or inflection points.'
                    },
                    {
                        label: 'Distribution Breakdown', desc: 'Histogram, pie, or category chart',
                        prompt: 'Show the distribution of the main categorical and numeric columns as charts. Highlight any skewed or unusual distributions.'
                    },
                ]
            },
            {
                category: 'Reports', icon: '📄',
                items: [
                    {
                        label: 'Full Analysis Report', desc: 'Overview, charts, findings & recommendations',
                        prompt: `Generate a comprehensive analysis report using ONLY the data provided. Write EVERYTHING in plain Markdown. Use these exact section headings:

## Executive Overview
Write 2-3 sentences summarising the dataset, its purpose, and the most important takeaway.

## Key Findings
List 5-8 specific, data-driven findings as bullet points. Include actual numbers from the data.

## Supporting Charts
Place 2-3 charts here. Each chart must be a \`\`\`json code block containing {"chart":{...}}. Do NOT output any bare JSON array or object outside of a code block.

## Anomalies & Risks
Write bullet points about outliers, missing data, or risk patterns. If none, say so explicitly.

## Recommendations
List 3-5 actionable recommendations as bullet points based on the data findings above.

STRICT FORMAT RULES — you MUST follow all of these:
1. Use ## Markdown headers for every section name. Do NOT prefix with "Report" or any other title.
2. Use plain prose or bullet points for all text. NEVER write text as JSON like {"Finding":"..."}.
3. Charts go inside \`\`\`json code blocks ONLY. No bare JSON arrays anywhere in the response.
4. Do not repeat section names or add extra prefixes.`
                    },
                    {
                        label: 'Compare Groups', desc: 'Side-by-side category comparison',
                        prompt: 'Compare and contrast all groups/categories in this data. Show key metric differences with a grouped bar chart and a comparison table.'
                    },
                    {
                        label: 'Predictive Insights', desc: 'Forecasts and what-if analysis',
                        prompt: 'Based on current trends, provide a forecast and predictive insights. What patterns suggest what might happen next?'
                    },
                ]
            },
            {
                category: 'Payroll', icon: '💰',
                items: [
                    {
                        label: 'Payroll Summary', desc: 'Earnings, deductions & net pay breakdown',
                        prompt: 'Generate a complete payroll summary with total earnings, total deductions, average net pay, and a month-wise grouped bar chart.'
                    },
                    {
                        label: 'Earnings vs Deductions', desc: 'Visual comparison with net pay trend',
                        prompt: 'Show total gross earnings vs total deductions as a grouped bar chart, with the net pay trend as an overlaid line.'
                    },
                    {
                        label: 'YTD Salary Statement', desc: 'Year-to-date cumulative analysis',
                        prompt: 'Summarize the year-to-date salary statement with cumulative totals for earnings, deductions and net pay, shown as an area chart by month.'
                    },
                    {
                        label: 'PF & ESI Breakdown', desc: 'Statutory deduction analysis',
                        prompt: 'Analyze PF, ESI, and other statutory deductions in detail. Show the contribution trend and compare against gross pay.'
                    },
                ]
            }
        ];

        function injectStyles() {
            if ($('#axiTplStyles')) return;
            const s = document.createElement('style');
            s.id = 'axiTplStyles';
            s.textContent = `
#axiTplBtn {
  display:inline-flex; align-items:center; gap:6px;
  padding:0 13px; height:48px; border-radius:14px;
  border:1.5px solid #e0e4ef; background:#fff;
  color:#374151; font-size:13.5px; font-weight:600;
  cursor:pointer; white-space:nowrap; flex-shrink:0;
  transition:all .18s; box-shadow:0 1px 4px rgba(0,0,0,.06);
  font-family:inherit; position:relative;
}
#axiTplBtn:hover {
  border-color:#a5b4fc; background:#eef2ff; color:#4338ca;
  box-shadow:0 2px 8px rgba(99,102,241,.18);
}
#axiTplBtn.axi-tpl-active {
  border-color:#818cf8; background:#eef2ff; color:#4338ca;
}
#axiTplBtn .axi-tpl-chevron {
  width:12px; height:12px; opacity:.6; flex-shrink:0;
  transition:transform .18s;
}
#axiTplBtn.axi-tpl-active .axi-tpl-chevron { transform:rotate(180deg); }
 
.axi-tpl-wrap { position:relative; display:inline-flex; align-items:center; flex-shrink:0; }
 
#axiTplPanel {
  position:absolute; bottom:calc(100% + 10px); left:0;
  width:340px; z-index:10000;
  background:#fff; border-radius:16px;
  border:1.5px solid #e4e9f5;
  box-shadow:0 12px 40px rgba(0,0,0,.16), 0 4px 12px rgba(0,0,0,.07);
  overflow:hidden;
  animation:axiTplIn .2s cubic-bezier(.22,.68,0,1.2) both;
  transform-origin:bottom left;
  max-height:490px; overflow-y:auto;
}
#axiTplPanel::-webkit-scrollbar { width:3px; }
#axiTplPanel::-webkit-scrollbar-thumb { background:#d1d5db; border-radius:4px; }
@keyframes axiTplIn {
  from { opacity:0; transform:scale(.93) translateY(8px); }
  to   { opacity:1; transform:scale(1)   translateY(0);   }
}
 
.axi-tpl-hdr {
  display:flex; align-items:center; justify-content:space-between;
  padding:12px 16px 10px; border-bottom:1.5px solid #f0f2f8;
  position:sticky; top:0; background:#fff; z-index:2;
}
.axi-tpl-hdr-title {
  font-size:11.5px; font-weight:700; color:#1e293b;
  text-transform:uppercase; letter-spacing:.05em;
  display:flex; align-items:center; gap:7px;
}
.axi-tpl-hdr-title svg { color:#6366f1; }
.axi-tpl-hdr-close {
  width:24px; height:24px; border-radius:7px; border:none;
  background:transparent; color:#94a3b8; cursor:pointer; font-size:16px;
  display:flex; align-items:center; justify-content:center; transition:all .15s;
}
.axi-tpl-hdr-close:hover { background:#f1f5f9; color:#374151; }
 
.axi-tpl-cat-label {
  padding:10px 16px 3px; font-size:9.5px; font-weight:700;
  color:#9aa3b8; text-transform:uppercase; letter-spacing:.06em;
  display:flex; align-items:center; gap:6px;
}
.axi-tpl-cat-icon { font-size:12px; }
 
.axi-tpl-item {
  display:flex; align-items:center; gap:11px;
  padding:9px 16px; cursor:pointer;
  transition:background .13s; border:none; background:none;
  width:100%; text-align:left; font-family:inherit;
}
.axi-tpl-item:hover { background:#f8fafc; }
.axi-tpl-item:hover .axi-tpl-item-label { color:#4f46e5; }
.axi-tpl-item:hover .axi-tpl-arrow { color:#6366f1; transform:translateX(3px); }
 
.axi-tpl-icon-wrap {
  flex:0 0 32px; height:32px; border-radius:9px;
  background:linear-gradient(135deg,#eef2ff,#f0fdf4);
  border:1px solid #e0e7ff;
  display:flex; align-items:center; justify-content:center; font-size:15px;
}
.axi-tpl-text { flex:1; min-width:0; }
.axi-tpl-item-label { font-size:12.5px; font-weight:600; color:#1e293b; }
.axi-tpl-item-desc  { font-size:10.5px; color:#94a3b8; margin-top:1px; }
.axi-tpl-arrow {
  flex:0 0 14px; color:#c7d2fe; font-size:16px;
  transition:transform .13s, color .13s; font-weight:300;
}
 
.axi-tpl-divider { height:1px; background:#f0f2f8; margin:5px 0; }
        `;
            document.head.appendChild(s);
        }

        function buildHTML() {
            let h = `
          <div class="axi-tpl-hdr">
            <div class="axi-tpl-hdr-title">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <line x1="3" y1="9" x2="21" y2="9"/>
                <line x1="9" y1="21" x2="9" y2="9"/>
              </svg>
              Prompt Templates
            </div>
            <button class="axi-tpl-hdr-close" id="_axiTplClose">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>`;
            TEMPLATES.forEach((cat, ci) => {
                if (ci > 0) h += '<div class="axi-tpl-divider"></div>';
                h += `<div class="axi-tpl-cat-label"><span class="axi-tpl-cat-icon">${cat.icon}</span>${cat.category}</div>`;
                cat.items.forEach(item => {
                    h += `
                  <button class="axi-tpl-item" data-prompt="${esc(item.prompt)}">
                    <div class="axi-tpl-icon-wrap">${cat.icon}</div>
                    <div class="axi-tpl-text">
                      <div class="axi-tpl-item-label">${esc(item.label)}</div>
                      <div class="axi-tpl-item-desc">${esc(item.desc)}</div>
                    </div>
                    <span class="axi-tpl-arrow">›</span>
                  </button>`;
                });
            });
            return h;
        }

        function sendPromptAndClose(text) {
            closePanel();
            const p = document.getElementById('prompt');
            if (!p) return;
            p.value = text;
            p.dispatchEvent(new Event('input', { bubbles: true }));
            p.focus();
            setTimeout(() => {
                const btn = document.getElementById('send');
                if (btn && !btn.disabled) btn.click();
            }, 90);
        }

        function openPanel() {
            const btn = $('#axiTplBtn');
            if (!btn) return;
            let panel = $('#axiTplPanel');
            if (!panel) {
                panel = document.createElement('div');
                panel.id = 'axiTplPanel';
                btn.closest('.axi-tpl-wrap')?.appendChild(panel);
            }
            panel.innerHTML = buildHTML();
            panel.style.display = 'block';
            panelOpen = true;
            btn.classList.add('axi-tpl-active');
            $('#_axiTplClose')?.addEventListener('click', closePanel);
            panel.querySelectorAll('.axi-tpl-item').forEach(item =>
                item.addEventListener('click', () => sendPromptAndClose(item.dataset.prompt))
            );
        }

        function closePanel() {
            const p = $('#axiTplPanel');
            if (p) p.style.display = 'none';
            $('#axiTplBtn')?.classList.remove('axi-tpl-active');
            panelOpen = false;
        }

        function injectButton() {
            if ($('#axiTplBtn')) return;
            const shell = document.querySelector('.composerShell');
            if (!shell) return;

            const wrap = document.createElement('div');
            wrap.className = 'axi-tpl-wrap';

            const btn = document.createElement('button');
            btn.id = 'axiTplBtn';
            btn.type = 'button';
            btn.title = 'Prompt Templates';
            btn.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="3" y1="9" x2="21" y2="9"/>
            <line x1="9" y1="21" x2="9" y2="9"/>
          </svg>
          Templates
          <svg class="axi-tpl-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="6 9 12 15 18 9"/>
          </svg>`;
            btn.addEventListener('click', e => { e.stopPropagation(); panelOpen ? closePanel() : openPanel(); });
            wrap.appendChild(btn);

            // Place after the Insights button wrap, otherwise at the front
            const insightsWrap = document.querySelector('.axi-insights-wrap');
            if (insightsWrap?.parentElement === shell) {
                insightsWrap.insertAdjacentElement('afterend', wrap);
            } else {
                shell.insertBefore(wrap, shell.firstChild);
            }
        }

        // Close on outside click
        document.addEventListener('click', e => {
            const panel = $('#axiTplPanel'), btn = $('#axiTplBtn');
            if (panelOpen && panel && !panel.contains(e.target) && !btn?.contains(e.target)) closePanel();
        }, true);

        function init() {
            injectStyles();
            injectButton();
            console.info('[AXI Prompt Templates v1.0] ✅ loaded');
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1400));
        } else {
            setTimeout(init, 1400);
        }
    })();


    /* ───────────────────────────────────────────────────────────────────────────
       FEATURE 6 — EXPORT CHAT AS MARKDOWN
       ─────────────────────────────────────────────────────────────────────────── */
    (function AXIExportChat() {
        'use strict';
        const $ = s => document.querySelector(s);

        function injectStyles() {
            if ($('#axiExportStyles')) return;
            const s = document.createElement('style');
            s.id = 'axiExportStyles';
            s.textContent = `
#axiExportBtn {
  display:inline-flex; align-items:center; gap:6px;
  padding:0 11px; height:32px; border-radius:8px;
  border:1.5px solid #e0e4ef; background:#fff;
  color:#52545a; font-size:12px; font-weight:500;
  cursor:pointer; transition:all .15s; font-family:inherit;
  white-space:nowrap; box-shadow:0 1px 3px rgba(0,0,0,.04);
  flex-shrink:0;
}
#axiExportBtn:hover {
  border-color:#93c5fd; background:#eff6ff; color:#1d4ed8;
  box-shadow:0 2px 8px rgba(59,130,246,.14);
}
#axiExportBtn:active { transform:scale(.97); }
#axiExportBtn svg { flex-shrink:0; }
        `;
            document.head.appendChild(s);
        }

        function pad2(n) { return String(n).padStart(2, '0'); }

        function exportChatAsMarkdown() {
            const msgs = document.querySelectorAll(
                '#messages .message--user, #messages .message--assistant'
            );
            if (!msgs.length) {
                // Use the toast function if it exists
                try { toast('No messages to export yet', 'warning', 2500); } catch (_) { }
                return;
            }

            const now = new Date();
            const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
            const binName = window.ACTIVEDATABINCONTEXT?.name || '';
            const model = (typeof getAxiConfig === 'function') ? (() => { try { return getAxiConfig().model; } catch (_) { return ''; } })() : '';

            let md = `# AXI AI — Chat Export\n\n`;
            md += `| | |\n|---|---|\n`;
            md += `| **Date** | ${dateStr} |\n`;
            if (binName) md += `| **Data Bin** | ${binName} |\n`;
            if (model) md += `| **Model** | ${model} |\n`;
            md += `| **Messages** | ${msgs.length} |\n\n---\n\n`;

            let msgIndex = 0;
            msgs.forEach(msg => {
                const isUser = msg.classList.contains('message--user');
                const bubble = msg.querySelector('.message__bubble, .messagebubble, .bubble');
                if (!bubble) return;
                const text = (bubble.innerText || bubble.textContent || '').trim();
                if (!text) return;

                msgIndex++;
                if (isUser) {
                    md += `## 🧑 You\n\n${text}\n\n`;
                } else {
                    md += `## 🤖 AXI AI\n\n${text}\n\n`;
                }
                md += `---\n\n`;
            });

            // Download
            const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `axi-chat-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}.md`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1200);

            try { toast(`✅ Chat exported (${msgIndex} messages)`, 'success', 3000); } catch (_) { }
        }

        function injectButton() {
            if ($('#axiExportBtn')) return;

            // Find the chat header — try multiple selector patterns
            const header = $(
                '.chatHeader, .chat__header, [class*="chatHeader"], [class*="chat-header"], .pageHeader'
            );
            if (!header) return;

            const btn = document.createElement('button');
            btn.id = 'axiExportBtn';
            btn.type = 'button';
            btn.title = 'Export chat as Markdown (.md)';
            btn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Export`;
            btn.addEventListener('click', exportChatAsMarkdown);

            // Append to the right side of the header
            header.appendChild(btn);
        }

        // Also expose globally so it can be called from keyboard shortcut etc.
        window.axiExportChat = exportChatAsMarkdown;

        function init() {
            injectStyles();
            injectButton();
            console.info('[AXI Export Chat v1.0] ✅ loaded');
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1000));
        } else {
            setTimeout(init, 1000);
        }
    })();


    /* ═══════════════════════════════════════════════════════════════════════════
       AXI PROVIDER SWITCHER
       Renders a polished dropdown panel from #axiProviderBtn with logos for
       OpenAI, Anthropic, Gemini, and OpenRouter.
       Connection logic is wired to the existing getAxiConfig / _AXI_RUNTIME_*
       variables — clicking a provider just stores the choice for future use.
       The connected state is determined by whether a runtime key exists.
    ═══════════════════════════════════════════════════════════════════════════ */
    (function AXIProviderSwitcher() {
        'use strict';

        const PROVIDERS = [
            {
                id: 'openai',
                name: 'OpenAI',
                desc: 'GPT-4o, GPT-4o mini',
                color: '#10a37f',
                bg: '#f0fdf4',
                border: '#a7f3d0',
                logo: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" fill="currentColor"/></svg>`,
            },
            {
                id: 'gemini',
                name: 'Google Gemini',
                desc: 'Gemini 2.5 Flash, Pro',
                color: '#4285f4',
                bg: '#f0f4ff',
                border: '#bfdbfe',
                logo: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12 14.305 14.305 0 0 0-12 12" fill="currentColor"/></svg>`,
            },
            {
                id: 'openrouter',
                name: 'OpenRouter',
                desc: 'Multi-model gateway',
                color: '#6d28d9',
                bg: '#faf5ff',
                border: '#ddd6fe',
                logo: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8l4 4-4 4"/><path d="M8 12h8"/></svg>`,
            },
        ];

        let panelOpen = false;

        function getActiveProvider() {
            try {
                return (typeof _AXI_RUNTIME_PROVIDER !== 'undefined' && _AXI_RUNTIME_PROVIDER)
                    ? _AXI_RUNTIME_PROVIDER.toLowerCase()
                    : (localStorage.getItem('axi_provider') || 'openai').toLowerCase();
            } catch (_) { return 'openai'; }
        }

        function hasKeyForProvider(id) {
            try {
                if (typeof _AXI_RUNTIME_KEY !== 'undefined' && _AXI_RUNTIME_KEY) {
                    const rp = (typeof _AXI_RUNTIME_PROVIDER !== 'undefined' ? _AXI_RUNTIME_PROVIDER : '').toLowerCase();
                    if (rp === id) return true;
                }
                // Real key present (filled from personal axi_ai_keys AND RBAC config)
                if (window._AXI_PROVIDER_KEYS && window._AXI_PROVIDER_KEYS[id]) return true;
                return false;
            } catch (_) { return false; }
        }

        function buildPanelHTML() {
            const active = getActiveProvider();
            return `
          <div class="axi-provider-hdr">AI Provider</div>
          <div class="axi-provider-list">
            ${PROVIDERS.map(p => {
                const isActive = p.id === active;
                const hasKey = hasKeyForProvider(p.id);
                return `
                  <button class="axi-provider-item${isActive ? ' active' : ''}"
                          data-provider="${p.id}" type="button"
                          title="${p.name}">
                    <span class="axi-pi-icon"
                          style="background:${p.bg};border-color:${p.border};color:${p.color};">
                      ${p.logo}
                    </span>
                    <span class="axi-pi-text">
                      <span class="axi-pi-name">${p.name}</span>
                      <span class="axi-pi-desc">${p.desc}</span>
                    </span>
                    <span class="axi-pi-status ${hasKey ? 'connected' : 'disconnected'}">
                      ${hasKey ? 'Connected' : 'Not set'}
                    </span>
                  </button>`;
            }).join('')}
          </div>`;
        }

        function updateBtn(id) {
            const p = PROVIDERS.find(x => x.id === id) || PROVIDERS[0];
            const logoEl = document.getElementById('axiProviderLogo');
            const nameEl = document.getElementById('axiProviderName');
            if (logoEl) {
                logoEl.innerHTML = p.logo;
                logoEl.style.background = p.bg;
                logoEl.style.color = p.color;
                logoEl.style.borderColor = p.border;
                logoEl.style.border = `1px solid ${p.border}`;
            }
            if (nameEl) nameEl.textContent = p.name;
        }

        let _panelOriginalParent = null; // remember where the panel lives in the DOM

        function openPanel() {
            const btn = document.getElementById('axiProviderBtn');
            const panel = document.getElementById('axiProviderPanel');
            if (!btn || !panel) return;
            panel.innerHTML = buildPanelHTML();

            // Teleport panel to <body> so NO ancestor can clip it
            if (!_panelOriginalParent) _panelOriginalParent = panel.parentElement;
            document.body.appendChild(panel);

            // Position it above the button using viewport coordinates
            const rect = btn.getBoundingClientRect();
            panel.style.position = 'fixed';
            panel.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
            panel.style.top = 'auto';
            /* BUG-22 FIX: clamp left so panel never overflows the viewport */
            const PANEL_W = 300;
            let panelLeft = rect.left;
            if (panelLeft + PANEL_W > window.innerWidth - 8) panelLeft = window.innerWidth - PANEL_W - 8;
            if (panelLeft < 8) panelLeft = 8;
            panel.style.left = panelLeft + 'px';
            panel.style.right = 'auto';
            panel.style.zIndex = '99999';

            panel.style.display = 'block';
            panelOpen = true;
            btn.classList.add('axi-provider-active');

            panel.querySelectorAll('.axi-provider-item').forEach(item => {
                item.addEventListener('click', () => {
                    closePanel();
                    switchToProvider(item.dataset.provider);
                });
            });
        }

        function closePanel() {
            const panel = document.getElementById('axiProviderPanel');
            const btn = document.getElementById('axiProviderBtn');
            if (panel) {
                panel.style.display = 'none';
                panel.style.position = '';
                panel.style.bottom = '';
                panel.style.top = '';
                panel.style.left = '';
                panel.style.right = '';
                panel.style.zIndex = '';
                // Return panel to its original DOM parent
                if (_panelOriginalParent && panel.parentElement !== _panelOriginalParent) {
                    _panelOriginalParent.appendChild(panel);
                }
            }
            if (btn) btn.classList.remove('axi-provider-active');
            panelOpen = false;
        }

        async function switchToProvider(id) {
            const providerMeta = PROVIDERS.find(p => p.id === id);
            if (!providerMeta) return;

            // Already on this provider — do nothing
            if (getActiveProvider() === id && typeof _AXI_RUNTIME_KEY !== 'undefined' && _AXI_RUNTIME_KEY) {
                if (typeof toast === 'function') toast(`Already using ${providerMeta.name}`, 'info', 2000);
                return;
            }

            try {
                if (typeof window.fetchADSData !== 'function') throw new Error('fetchADSData not available');

                if (typeof window.showLoader === 'function') window.showLoader(`Checking ${providerMeta.name} key…`);

                const rows = await window.fetchADSData("axi_ai_keys");
                // Clear immediately — keys must never reach AI context
                window.pendingDatabaseData = null;
                window.CURRENTADSDATA = null;
                window.CURRENTADSNAME = null;

                if (typeof window.hideLoader === 'function') window.hideLoader();

                const currentUsername = (typeof parent !== 'undefined' && parent.mainUserName)
                    ? parent.mainUserName
                    : (typeof mainUserName !== 'undefined' ? mainUserName : '');

                const userRows = currentUsername
                    ? (rows || []).filter(r => (r.username || r.USERNAME || '').trim() === currentUsername.trim())
                    : (rows || []);

                // Refresh cache for all providers in this DB result
                userRows.forEach(r => {
                    const prov = (r.provider || r.PROVIDER || '').trim().toLowerCase();
                    const k = (r.api_key || r.apikey || r.key || r.API_KEY || '').trim();
                    if (prov && k) _AXI_PROVIDER_KEY_CACHE[prov] = true;
                });

                const providerRows = userRows.filter(r =>
                    (r.provider || r.PROVIDER || '').trim().toLowerCase() === id &&
                    (r.api_key || r.apikey || r.key || r.API_KEY || '').trim()
                );

                if (providerRows.length > 0) {
                    // Key exists — pick most recent and switch immediately
                    const sorted = [...providerRows].sort((a, b) =>
                        new Date(b.last_used || b.updated_at || b.created_at || 0) -
                        new Date(a.last_used || a.updated_at || a.created_at || 0)
                    );
                    const row = sorted[0];
                    _AXI_RUNTIME_KEY = (row.api_key || row.apikey || row.key || '').trim();
                    if (window._AXI_PROVIDER_KEYS && _AXI_RUNTIME_KEY) window._AXI_PROVIDER_KEYS[id] = _AXI_RUNTIME_KEY;
                    _AXI_RUNTIME_PROVIDER = id;
                    _AXI_RUNTIME_MODEL = (row.model || row.MODEL || AXI_DEFAULT_MODELS[id] || '').trim();
                    // Auto-migrate retired model names (e.g. gemini-1.5-flash, fully shut down
                    // and now returning 404 from the API) to the current default for the provider.
                    if (_AXI_RUNTIME_MODEL && typeof AXI_RETIRED_MODELS !== 'undefined' && AXI_RETIRED_MODELS.has(_AXI_RUNTIME_MODEL)) {
                        console.info('[AXI] Migrating retired model "' + _AXI_RUNTIME_MODEL + '" → "' + (AXI_DEFAULT_MODELS[id] || '') + '"');
                        _AXI_RUNTIME_MODEL = AXI_DEFAULT_MODELS[id] || '';
                    }

                    updateBtn(id);
                    if (typeof _updateModelBadge === 'function') _updateModelBadge();
                    if (typeof toast === 'function') toast(`Switched to ${providerMeta.name}`, 'success', 2500);
                } else if (window._AXI_PROVIDER_KEYS && window._AXI_PROVIDER_KEYS[id]) {
                    // No personal row, but a real key for this provider exists in the
                    // shared map (e.g. RBAC-assigned) — switch using it so the badge
                    // and the actual key never disagree.
                    _AXI_RUNTIME_KEY = window._AXI_PROVIDER_KEYS[id];
                    _AXI_RUNTIME_PROVIDER = id;
                    _AXI_RUNTIME_MODEL = AXI_DEFAULT_MODELS[id] || '';
                    updateBtn(id);
                    if (typeof _updateModelBadge === 'function') _updateModelBadge();
                    if (typeof toast === 'function') toast(`Switched to ${providerMeta.name}`, 'success', 2500);
                } else {
                    // No key for this provider — open the provider key modal
                    if (typeof window.axiOpenProviderKeyModal === 'function') {
                        window.axiOpenProviderKeyModal(id);
                    }
                    if (typeof toast === 'function')
                        toast(`No ${providerMeta.name} key found — enter your key to connect`, 'info', 4000);
                }
            } catch (err) {
                if (typeof window.hideLoader === 'function') window.hideLoader();
                console.error('[AXI switchToProvider]', err);
                if (typeof toast === 'function') toast(`Failed to switch provider: ${err.message}`, 'error', 4000);
            }
        }

        // Expose so index.html can call it after a successful connect
        window.axiSwitchProviderUpdateBtn = updateBtn;

        function init() {
            // Hide provider switcher entirely for employee users — they cannot switch providers
            if (window._axiIsClientEmployee) {
                const wrap = document.getElementById('axiProviderWrap');
                if (wrap) wrap.style.display = 'none';
                console.info('[AXI Provider Switcher] hidden for employee user');
                return;
            }

            const btn = document.getElementById('axiProviderBtn');
            if (!btn) return;

            // Set correct provider on boot
            updateBtn(getActiveProvider());

            btn.addEventListener('click', e => {
                e.stopPropagation();
                panelOpen ? closePanel() : openPanel();
            });

            document.addEventListener('click', e => {
                const wrap = document.getElementById('axiProviderWrap');
                const panel = document.getElementById('axiProviderPanel');
                if (panelOpen && wrap && !wrap.contains(e.target) && !panel?.contains(e.target)) closePanel();
            }, true);

            console.info('[AXI Provider Switcher v1.0] ✅ loaded');
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1200));
        } else {
            setTimeout(init, 1200);
        }
    })();