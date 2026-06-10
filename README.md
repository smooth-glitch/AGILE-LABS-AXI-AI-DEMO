# 🤖 AXI AI – Analytics Chat Dashboard

> **⚠️ Axpert-Only Application** — AXI AI is purpose-built for the **Axpert low-code ERP platform**. It will not function as a standalone web application. All AI key management, datasource access, user authentication, RBAC, and data bin persistence depend on Axpert's internal APIs (`AxSetValue`, `AxSubmitData`, `fetchADSData`), table structs (`tstruct`), and the direct SQL datasource layer (`axdirectsql`). **A configured and running Axpert ERP instance is a hard requirement.**

A modern, responsive **AI analytics dashboard** embedded inside Axpert, combining conversational AI with rich charts, live datasource analysis, file-based data onboarding, and export tools — delivered as a polished enterprise-style chat experience.

***

## ✨ Highlights

- 💬 AI chat interface with **streaming responses**, typewriter rendering, and contextual follow-up suggestion chips.
- 📊 Built-in charting and analytics using **Chart.js** and **Highcharts** for data-rich responses.
- 📁 **Data Bin** workflow for drag-and-drop uploads with support for **CSV, XLSX, XLS, TXT, PDF, DOCX, and JSON** files.
- 🔌 **Live Axpert Datasource integration** — attach live ADS (Application Data Sources) from your Axpert instance directly into the AI context.
- 🧠 Smart table conversion that turns AI-generated tabular responses into structured list views inside Axpert.
- 📄 Export actions for **PDF reports** and **Markdown copy/export** directly from AI-generated responses.
- 🔐 **RBAC support** — admin-assigned AI provider keys are injected at runtime per user group via the `axiairbacconfig` datasource.
- 🎨 Clean responsive interface with sidebar navigation, polished message bubbles, design tokens, toasts, modals, and mobile support.
- 🔒 Enterprise-friendly iframe safeguards, safe link handling, local chat persistence, and resilient DOM update logic.

***

## ⚠️ Axpert Dependency — Required Reading

AXI AI runs **exclusively inside an Axpert ERP iframe**. It is not a generic web app and cannot run as a standalone tool outside of Axpert. Here's what it depends on:

### Platform APIs
The dashboard calls these Axpert JavaScript globals at runtime — they are only available inside an Axpert-rendered page:

| API | Purpose |
|-----|---------|
| `AxSetValue` | Write field values to a tstruct for save operations |
| `AxSubmitData` | Submit/save a tstruct record to the Axpert database |
| `fetchADSData(sqlname)` | Fetch rows from an Axpert Direct SQL datasource |
| `parent.mainUserName` | Read the currently logged-in Axpert username |

### Required Tstructs (Table Structs)
Two Axpert tstructs must be created and configured in your Axpert instance before the app can function:

| Tstruct Name | Purpose |
|---|---|
| `axiaiapikeydtl` | Stores AI provider API keys per user (provider, model, apikey, isactive, username) |
| `axaidatasourcesdetails` | Stores saved Data Bin configurations (binname, binid, datasourcedetails, documentdetails) |
| `axiairbacconfig` | Stores RBAC-assigned provider keys by user group (axusergroups, axusername, binname, provider, providerkey) |

### Required Direct SQL Datasources (ADS)
The following `axdirectsql` entries must be inserted into your Axpert database. SQL insert statements for all of them are provided in `INSERT-STATEMENTS-FOR-DATASOURCES.txt`.

| SQL Name | Purpose |
|---|---|
| `axiaikeys` | Retrieves the stored API key for the current user from `axiaiapikeydtl` |
| `axiaibin` | Retrieves saved Data Bin configurations from `axaidatasourcesdetails` |
| `axiairbacconfig` | Retrieves RBAC-assigned keys by user group |
| `axiaiusergroups` | Lists all available user groups (used in RBAC admin config) |
| `axiaiusernameusergroups` | Lists usernames within a selected user group |
| `axiaigetadslist` | Lists all available ADS sources the current user can access, for Data Bin datasource selection |

> All insert statements are provided in `INSERT-STATEMENTS-FOR-DATASOURCES.txt`. Execute them against your Axpert PostgreSQL database as the `admin` user before deploying the dashboard.

***

## 🧱 Tech Stack

<p align="center">
  <img src="https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white" alt="HTML5"/>
  <img src="https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white" alt="CSS3"/>
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=000" alt="JavaScript"/>
  <img src="https://img.shields.io/badge/Chart.js-FF6384?style=for-the-badge&logo=chartdotjs&logoColor=white" alt="Chart.js"/>
  <img src="https://img.shields.io/badge/Highcharts-7CB5EC?style=for-the-badge&logo=highcharts&logoColor=white" alt="Highcharts"/>
  <img src="https://img.shields.io/badge/PapaParse-334155?style=for-the-badge" alt="PapaParse"/>
  <img src="https://img.shields.io/badge/SheetJS-0F766E?style=for-the-badge" alt="SheetJS"/>
  <img src="https://img.shields.io/badge/PDF.js-EF4444?style=for-the-badge" alt="PDF.js"/>
  <img src="https://img.shields.io/badge/Mammoth-7C3AED?style=for-the-badge" alt="Mammoth"/>
  <img src="https://img.shields.io/badge/jsPDF-F59E0B?style=for-the-badge" alt="jsPDF"/>
  <img src="https://img.shields.io/badge/html2canvas-6366F1?style=for-the-badge" alt="html2canvas"/>
  <img src="https://img.shields.io/badge/Axpert-Low--Code%20ERP-2563EB?style=for-the-badge" alt="Axpert"/>
</p>

***

## 🚀 Deployment (Inside Axpert)

AXI AI is deployed by registering `dashboard.html` as an embedded HTML component inside your Axpert application. There is no standalone server to run.

### Step 1 — Set up the database objects

Execute all INSERT statements from `INSERT-STATEMENTS-FOR-DATASOURCES.txt` against your Axpert PostgreSQL database. This creates the six required `axdirectsql` datasources.

### Step 2 — Create the required tstructs

In your Axpert admin console, create the following tstructs with the fields listed above:

- `axiaiapikeydtl` — API key storage per user
- `axaidatasourcesdetails` — Data Bin persistence
- `axiairbacconfig` — RBAC key assignment (optional, for org-managed keys)

### Step 3 — Register the HTML component in Axpert

Upload or reference `dashboard.html` and `script.js` inside Axpert's HTML component registry. Ensure the component has access to the Axpert JS globals (`AxSetValue`, `AxSubmitData`, `fetchADSData`) and runs within the Axpert iframe shell.

### Step 4 — Connect an AI provider

On first load, users see the **AXI Connect** modal. They enter their API key for one of the supported providers. The key is saved to `axiaiapikeydtl` via `AxSetValue` + `AxSubmitData` and loaded from `axiaikeys` on subsequent visits. Admins can pre-assign keys by user group using `axiairbacconfig`.

### Supported AI Providers

| Provider | Models |
|---|---|
| **OpenAI** | `gpt-4o-mini` (default), any OpenAI-compatible model |
| **Google Gemini** | `gemini-2.5-flash` (default) |
| **OpenRouter** | `openai/gpt-4o-mini` (default), any OpenRouter model |

> **Anthropic/Claude** is not supported in this version due to browser CORS restrictions on the Anthropic API.

***

## 🎛️ Features

### 💬 AI Chat Experience
- Streaming AI responses with a typewriter effect for a natural assistant feel.
- Suggested follow-up chips generated from the latest response and current data context.
- Conversation history persistence with localStorage and assistant/user message separation.
- Full multi-turn conversation memory with context-window management (last 20 messages, 12,000 char truncation per message).

### 📁 Data Bin Workflow
- Attach structured and document-based context to the chat using drag-and-drop uploads.
- Supports **CSV, XLSX, XLS, TXT, PDF, DOCX, and JSON** with validation, upload status, and limits.
- Multi-step Data Bin flow with optional live **Axpert ADS datasource** selection, file management, naming, and save logic.
- Saved bins persist in the `axaidatasourcesdetails` tstruct and are reloaded via the `axiaibin` ADS.
- TOON (Token-Optimised Object Notation) chunking keeps large datasets within the AI's context window.

### 📊 Visual Analytics
- Render charts directly inside responses using **Chart.js** and **Highcharts**.
- Convert AI responses into structured smart lists for tabular exploration in Axpert.
- Display full HTML dashboard output inside embedded preview cards when the response returns a complete HTML document.
- Inline KPI cards, anomaly detection, and column explorer powered by loaded datasource data.

### 🔐 Security & Access Control
- **RBAC integration** — admin-configured provider keys are injected at runtime per user group; users in managed groups never need to enter their own key.
- API keys are loaded into memory only — never written to `localStorage` for the runtime key path. The key is gone when the tab closes.
- A native `iframe` fetch bypass is used to call AI provider APIs directly, routing around Axpert's internal request interceptors.
- All outbound links inside the Axpert iframe are intercepted and opened in new tabs to prevent host-frame navigation errors.

### 📄 Export & Productivity
- Export AI responses as polished PDF reports using **jsPDF** and **html2canvas**.
- Copy Markdown output directly from generated responses for reuse in docs or reports.

***

## 🧩 Project Structure

```bash
.
├── dashboard.html                        # Main UI shell, layout, styles, library imports
├── script.js                             # Chat logic, rendering, smart list, exports, Axpert integrations
└── INSERT-STATEMENTS-FOR-DATASOURCES.txt # SQL inserts for all required Axpert ADS datasources
```

***

## 🛠️ Customization

- **UI & branding** — Update colors, typography, shadows, and spacing through the CSS variables and component styles in `dashboard.html`.
- **Chat behavior** — Adjust message streaming, suggestion generation, export actions, and smart list behavior in `script.js`.
- **AI provider defaults** — Edit `AXIDEFAULTMODELS` in `script.js` to change the default model per provider.
- **Tstruct names** — The tstruct name for API key storage defaults to `axk`. Update `AXIKEYSTSTRUCT` at the top of `script.js` if your tstruct is named differently.
- **Datasource names** — All ADS SQL names (e.g., `axiaikeys`, `axiaibin`) must exactly match the `sqlname` values in `axdirectsql`. Update the constants in `script.js` if you rename them.

***

## 📌 Roadmap

- 🔐 Stronger environment-based config separation for staging and production Axpert deployments.
- 📈 Expanded visual analytics with more chart presets, drill-downs, and KPI cards.
- 🧠 Richer report templates and structured output formats for AI responses.
- ☁️ Broader backend connector support for more Axpert datasource types and workflow integrations.
- 📱 Further refined mobile UX for long-form analytical conversations and dashboard previews.
- 🤖 Anthropic/Claude support once browser-safe proxy routing is available.

***

## 🙌 Author

Designed & developed by **Arjun**.
