# 🌅 HORIZON

🔗 **Live website:** [Open HORIZON](https://horizon-5x5o.onrender.com)

A calm and organized productivity workspace for personal and team projects.

HORIZON brings projects, tasks, calendars, and team conversations together in one place. Plan work with task lists, subtasks, deadlines, and dependencies; coordinate through shared workspaces and messaging; and track progress with helpful reminders and insights.

## ✨ Features

- 👤 Account registration and sign-in
- 🏠 Personal and shared team workspaces
- 👥 Workspace roles for owners, admins, members, and viewers
- 📁 Projects with task lists
- ✅ Tasks with priorities, statuses, and due dates
- 🔗 Subtasks and task dependencies
- ⏳ Downstream task impact when work is delayed
- 🗑️ Recently deleted tasks with restore
- 📅 Calendar view and workspace events
- 💬 Team messaging with real-time updates
- ⚙️ Configurable automation templates
- 📊 Project and task progress insights
- 🔔 Notifications
- 📎 Task file attachments
- 📥 CSV task import and export
- 🎨 Responsive cream, beige, and warm-brown design
- 🌙 Light, dark, and scheduled theme options

## 🛠️ Technologies Used

- **Python** — Backend programming
- **Flask** — Web application framework
- **SQLAlchemy** — Database models and queries
- **SQLite** — Simple local database option
- **MySQL** — Database option for a hosted setup
- **HTML** — Webpage structure
- **CSS** — Styling and responsive layouts
- **JavaScript** — Browser interactions
- **Flask-SocketIO** — Real-time messaging support
- **APScheduler** — Included for scheduled automation development
- **pytest** — Application tests
- **Git and GitHub** — Version control and source hosting

## 🎯 Purpose

HORIZON is designed to make planning and coordinating work feel clearer. It brings personal tasks and team projects into a focused workspace, helping people see what needs attention and what is moving forward.

## 🚀 How to Run

You need Python 3.10 or newer.

1. Open the HORIZON project folder in a terminal.
2. Create and activate a virtual environment:

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   ```

   On Windows PowerShell, activate it with:

   ```powershell
   .venv\Scripts\Activate.ps1
   ```

3. Install the project packages:

   ```bash
   python -m pip install -r requirements.txt
   ```

4. Create a `.env` file from `.env.example` and set a secure `SECRET_KEY`.
5. Start HORIZON:

   ```bash
   python app.py
   ```

6. Open http://127.0.0.1:5000 in your browser.

SQLite is the default for local development. MySQL, email verification, and Google Calendar credentials require additional configuration. Google Calendar sign-in and scheduled automation execution need further setup.

## 📂 Project Structure

```text
HORIZON/
├── app.py
├── config.py
├── extensions.py
├── models.py
├── services.py
├── requirements.txt
├── .env.example
├── README.md
├── templates/
│   └── index.html
├── static/
│   ├── css/
│   │   └── style.css
│   └── js/
│       └── app.js
└── tests/
    └── test_app.py
```

## 🔌 Integrations

- **Google Calendar:** OAuth credentials and calendar synchronization setup are required.
- **Email verification:** SMTP settings are required to send verification links.
- **Scheduled automations:** Templates can be configured; a scheduler or worker must be set up to run them automatically.
