# AXI AI – Analytics Chat Dashboard

> A conversational AI analytics assistant built for the **Axpert ERP platform** at **Agile Labs**.
>
> 🔗 **[View Live Demo →](https://agileqa.agilecloud.biz/qaaxpert11.4base/aspx/mainnew.aspx)** *(requires valid Axpert credentials)*

---

## 📸 Screenshots

### Home Screen

![Home Page](./screenshots/home-page.jpg)

*Clean welcome screen with the AI composer, AI provider selector, Data Bin picker, Templates, and prompt editor all accessible from the bottom control bar.*

---

### AI Provider Selection

![Provider Dropdown](./screenshots/provider-dropdown.jpg)

*Switch between connected AI providers — OpenAI, Google Gemini, and OpenRouter — directly from the chat interface.*

---

### Chat Response & Actions

![Response Features](./screenshots/response-features.jpg)

*AI responses include record count chips, quick action buttons (Visualize as chart, Show trend over time), export tools, and contextual follow-up suggestion chips.*

---

### Prompt Templates

![Prompt Templates](./screenshots/prompt-templates.jpg)

*Built-in analysis templates (Executive Summary, Anomaly Detection, Correlation Analysis, Data Quality Report) plus user-saved custom templates for one-click prompting.*

---

### Edit System Prompt

![Edit Prompt](./screenshots/edit-prompt-dropdown.jpg)

*Fully customizable system prompt — tune how AXI thinks, responds, and what rules it follows. Saved per user.*

---

### Data Bin — Add Datasource

![Datasource Page](./screenshots/datasource-page.jpg)

*Step 1 of the Data Bin flow: search and select one or more live Axpert datasources to include as AI context.*

---

### Data Bin — File Upload

![File Upload](./screenshots/file-upload-page.jpg)

*Step 2: drag-and-drop file uploads alongside datasources. Supports CSV, XLSX, XLS, TXT, PDF, DOCX, and JSON.*

---

### Data Bin — Dropdown

![Data Bin Dropdown](./screenshots/databin-dropdown.jpg)

*Quickly switch between saved Data Bins from the composer bar. Each bin shows its datasource and file count.*

---

### Data Bin — Control Center (Admin)

![Data Bin Control Center](./screenshots/databin-control-center.jpg)

*Admin view for managing all saved Data Bins — create, edit, delete, and assign bins to user groups.*

---

### Access Assignments (Admin)

![Assignments](./screenshots/assignments.jpg)

*Assign a Data Bin and AI provider key to a specific user group — so users in that group get pre-configured access without needing to set up their own keys.*

---

## 📄 Sample PDF Export

AXI AI can export any response as a polished, multi-page **PDF report**. Below is an example of a report generated from a multi-datasource analysis across employee compensation, user accounts, task management, and performance metrics.

> **What the report covers:**
> - **ADS_canditate** — 11 employee records analysed for compensation patterns; identified that Employee ASI-0002 holds the highest total compensation of 59,000.
> - **ads_test_perf2** — 1,140 user account records; found ~87.7% active users, with a notable portion lacking user group assignments.
> - **AXI_AI_test** — 30 task/notification records; flagged a backlog of pending PEG Form approvals initiated by a single user.
> - **barchart** — 7 performance metric records; EMP-0001 stands out with a value of 47 vs. a baseline of 1 across others.
> - Includes **5 auto-generated charts** visualising the key findings across all datasets.

*The full exported report (4 pages, with charts) is included in this repo as [`analytics-example.pdf`](./analytics-example.pdf).*

---

## ✨ Features

### 💬 Conversational AI

- Natural language chat interface with **streaming responses** and typewriter effect
- Contextual **follow-up suggestion chips** auto-generated after every response
- Multi-turn conversation memory within a session

### 📊 Visual Analytics

- AI responses that include **live charts** rendered with Chart.js and Highcharts
- Smart conversion of tabular AI output into structured, scannable list views
- Full HTML dashboard previews embedded directly inside the chat

### 📁 Data Bin

- Drag-and-drop file uploads to attach data context to your conversation
- Supports **CSV, XLSX, XLS, TXT, PDF, DOCX, and JSON**
- Attach live **Axpert datasources** alongside uploaded files
- Save and reload named Data Bins for repeatable analysis workflows

### 🎛️ Prompt Templates

- Built-in templates: Executive Summary, Anomaly Detection, Correlation Analysis, Data Quality Report, and more
- Save and reuse your own custom templates

### 📄 Export Tools

- Export any AI response as a **polished multi-page PDF report** with branding and auto-generated charts
- Copy responses as **Markdown** for use in documents or notes

### 🔐 Admin & Access Control

- Assign Data Bins and AI provider keys to specific **user groups**
- Users in managed groups get pre-configured access without needing their own API keys
- Full admin panel with Data Bin management and access assignment views

### 🎨 UI & Experience

- Clean, responsive interface with a bottom control bar and sidebar navigation
- Syntax-highlighted code blocks with one-click copy
- Callout-style formatting for key insights, warnings, and tips in AI responses
- Mobile-friendly layout

---

## 🧱 Built With

<p align="left">
  <img src="https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white" alt="HTML5" />
  <img src="https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white" alt="CSS3" />
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=000" alt="JavaScript" />
  <img src="https://img.shields.io/badge/Chart.js-FF6384?style=for-the-badge&logo=chartdotjs&logoColor=white" alt="Chart.js" />
  <img src="https://img.shields.io/badge/Highcharts-7CB5EC?style=for-the-badge" alt="Highcharts" />
  <img src="https://img.shields.io/badge/PapaParse-334155?style=for-the-badge" alt="PapaParse" />
  <img src="https://img.shields.io/badge/SheetJS-0F766E?style=for-the-badge" alt="SheetJS" />
  <img src="https://img.shields.io/badge/PDF.js-EF4444?style=for-the-badge" alt="PDF.js" />
  <img src="https://img.shields.io/badge/Mammoth-7C3AED?style=for-the-badge" alt="Mammoth" />
  <img src="https://img.shields.io/badge/jsPDF-F59E0B?style=for-the-badge" alt="jsPDF" />
  <img src="https://img.shields.io/badge/html2canvas-6366F1?style=for-the-badge" alt="html2canvas" />
  <img src="https://img.shields.io/badge/Axpert%20ERP-2563EB?style=for-the-badge" alt="Axpert ERP" />
</p>

---

## 🔗 Live Demo

The app is live inside the Agile Labs Axpert instance.

👉 **[https://agileqa.agilecloud.biz/qaaxpert11.4base/aspx/mainnew.aspx](https://agileqa.agilecloud.biz/qaaxpert11.4base/aspx/mainnew.aspx)**

Sign in with valid Axpert credentials to access AXI AI from the application menu.

---

## 🙌 Author

Designed & developed by **Arjun** at **Agile Labs**.

*This repository is a public showcase. Source code is proprietary to Agile Labs.*
