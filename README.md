# 🤖 AXI AI – Analytics Chat Dashboard

A modern, responsive **AI analytics dashboard** built with **HTML**, **CSS**, and **Vanilla JavaScript**, designed for the **Axpert low-code platform**. [1][2] It combines conversational AI, rich charts, file-based data onboarding, and export tools into a polished enterprise-style chat experience. [3][4]

***

## ✨ Highlights

- 💬 AI chat interface with **streaming responses**, typewriter rendering, and contextual follow-up suggestion chips. [4]
- 📊 Built-in charting and analytics using **Chart.js** and **Highcharts** for data-rich responses. [3]
- 📁 **Data Bin** workflow for drag-and-drop uploads with support for **CSV, XLSX, XLS, TXT, PDF, DOCX, and JSON** files. [3]
- 🧠 Smart table conversion that turns AI-generated tabular responses into structured list views inside Axpert. [4][1]
- 📄 Export actions for **PDF reports** and **Markdown copy/export** directly from AI-generated responses. [4]
- 🎨 Clean responsive interface with sidebar navigation, polished message bubbles, design tokens, toasts, modals, and mobile support. [3]
- 🔒 Enterprise-friendly iframe safeguards, safe link handling, local chat persistence, and resilient DOM update logic. [4]

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

  <img src="https://img.shields.io/badge/Axpert-Low--Code%20Platform-2563EB?style=for-the-badge" alt="Axpert"/>
  <img src="https://img.shields.io/badge/LocalStorage-475569?style=for-the-badge" alt="LocalStorage"/>
</p>

***

## 🚀 Getting Started

### ✅ Run locally

1. **Clone the repo**
```bash
git clone https://github.com/<your-username>/<your-repo>.git
cd <your-repo>
```

2. **Configure platform/API access**

Create or update the runtime config your Axpert environment expects for provider keys, app endpoints, and platform integration values. The app reads runtime configuration for AI provider selection and embedded execution inside Axpert. [4][3]

```js
// Example placeholder config
window.APP_CONFIG = {
  AI_PROVIDER: "openai-or-other-provider",
  API_KEY: "YOUR_API_KEY",
  AXPERT_BASE_URL: "YOUR_AXPERT_INSTANCE_URL"
};
```

3. **Start a local server**
- VS Code: **Live Server**
- or:
```bash
python -m http.server 5500
```

4. **Open in browser**
- [http://127.0.0.1:5500/dashboard.html](http://127.0.0.1:5500/dashboard.html)

***

## 🎛️ Features

### 💬 AI Chat Experience
- Streaming AI responses with a typewriter effect for a more natural assistant feel. [4]
- Suggested follow-up chips generated from the latest response and current data context. [4]
- Conversation history persistence with local storage and assistant/user message separation. [4]

### 📁 Data Bin Workflow
- Attach structured and document-based context to the chat using drag-and-drop uploads. [3]
- Supports **CSV, XLSX, XLS, TXT, PDF, DOCX, and JSON** with validation, upload status, and limits. [3]
- Multi-step Data Bin flow with optional datasource selection, file management, naming, and save logic. [3]

### 📊 Visual Analytics
- Render charts directly inside responses using **Chart.js** and **Highcharts**. [3]
- Convert AI responses into structured smart lists for tabular exploration in Axpert. [4][1]
- Display full HTML dashboard output inside embedded preview cards when the response returns a full HTML document. [4]

### 📄 Export & Productivity
- Export AI responses as polished PDF reports using **jsPDF** and **html2canvas**. [4]
- Copy Markdown output directly from generated responses for reuse in docs or reports. [4]
- Guard outbound links inside embedded iframes to avoid breaking the host shell experience. [4]

***

## 🧩 Project Structure

```bash
.
├── dashboard.html   # Main UI shell, layout, styles, library imports
├── script.js        # Chat logic, rendering, smart list, exports, integrations
└── assets/          # Images, icons, or platform-linked resources (if applicable)
```

***

## 🛠️ Customization

- **UI & branding**
  - Update colors, typography, shadows, and spacing through the CSS variables and component styles in `dashboard.html`. [3]
- **Chat behavior**
  - Adjust message streaming, suggestion generation, export actions, and smart list behavior in `script.js`. [4]
- **Platform integration**
  - Replace or extend the Axpert-specific runtime hooks, datasource flows, and provider configuration for your own environment. [4][3]

***

## 📌 Roadmap

- 🔐 Add stronger environment-based config separation for local, staging, and production deployments.
- 📈 Expand visual analytics with more chart presets, drill-downs, and KPI cards.
- 🧠 Improve AI output actions with richer report templates and structured summaries.
- ☁️ Add broader backend connector support for more enterprise datasets and workflow integrations.
- 📱 Further refine mobile UX for long-form analytical conversations and dashboard previews.

***

## 🙌 Author

Designed & developed by **Arjun**.
