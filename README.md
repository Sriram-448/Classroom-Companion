# Classroom Companion

Classroom Companion is an AI-powered assistant designed to manage school classes, assignments, and student/teacher interactions through a Telegram Bot and web portals.

---

## 1. Quick Start & Setup

### Installation & Run
1. Open your terminal and navigate to the project directory:
   ```bash
   cd C:\Users\rayid\OneDrive\Desktop\classroom-companion
   ```
2. Activate the virtual environment:
   * **PowerShell:**
     ```powershell
     .\venv\Scripts\Activate.ps1
     ```
   * **Command Prompt:**
     ```cmd
     venv\Scripts\activate
     ```

### Running the Backend
Start the FastAPI server:
```bash
python backend/main.py
```

### Running the Frontend
In a **new terminal window**, navigate to the project root and run Python's built-in web server:
```bash
cd C:\Users\rayid\OneDrive\Desktop\classroom-companion
python -m http.server 5500
```

---

## 2. Test Accounts & Runbook

The application is seeded with the following short-login credentials:

- **Coordinator: Principal Mehta** (URL: `?user=mehta`) - Oversees school classrooms, manages class directories, issues invite codes, and audits registrations.
- **Teacher: MANOJ M** (URL: `?user=manoj`) - Creates assignments, tracks completions, and provides grading comments.
- **Teacher: Ms. Sharma** (URL: `?user=sharma`) - Creates and manages assignments for Grade 8 / Class 9.
- **Student: Maddy** (URL: `?user=maddy`) - Reviews homework, sends updates to the Telegram bot, and reads feedback comments.
- **Student: Rahul Verma** (URL: `?user=rahul`) - Views personalized lists of active and overdue tasks.
- **Student: Srrr** (URL: `?user=Srrr`) - Newly registered student linked to Class 6 via Telegram.

### Accessing the Web portals:
Ensure the backend server is running on port `3001` and frontend files are served on port `5500`:
*   **Admin Console**: [http://localhost:5500/frontend/coordinator/index.html?user=mehta](http://localhost:5500/frontend/coordinator/index.html?user=mehta)
*   **Teacher Console**: [http://localhost:5500/frontend/teacher/index.html?user=manoj](http://localhost:5500/frontend/teacher/index.html?user=manoj)
*   **Student Console**: [http://localhost:5500/frontend/student/index.html?user=maddy](http://localhost:5500/frontend/student/index.html?user=maddy)

---

## 3. Core Architecture & Design
Please refer to the detailed domain designs, state machines, and access boundaries documented in:
 [backend/REASONING.md](./backend/REASONING.md)

---

## 4. Runbook: Step-by-Step Demo Flow
To test the entire system end-to-end:
1.  **Delete Existing Student**: Go to the **Admin Portal** (`?user=mehta`), locate **Maddy** in the registry, and click **Delete** to clean her record.
2.  **Generate Invite Link**: On the Admin portal, select **Class 10-maths** and click **Generate Invite Link**.
3.  **Onboard Maddy**: Open the bot (`@your_bot_username`) on Telegram, type `/start`, and paste the generated invite code. She is now registered.
4.  **Create Assignment**: Go to the **Teacher Dashboard** (`?user=manoj`), select Class 10-maths, and type: *"Create essay on climate change due next Friday"*. Click **Create & Distribute**. The bot will immediately notify Maddy on Telegram.
5.  **Submit Work**: In Telegram, reply: *"I have finished the climate change essay"*. The bot will parse the completion and update the status in the DB.
6.  **Grading**: Refresh the Teacher Dashboard, open the assignment, type feedback comments under Maddy's row, and click **Accept & Complete**. Maddy will receive a message from the bot with her grade feedback.

---

## 5. Known Limitations
*   **Authentication**: Real-world apps use session cookies or JWT tokens. This demo parses the `x-user-id` header/parameter for simplicity and developer inspection.
*   **Concurrency**: Uses a local SQLite driver which locks the database file on concurrent writes. Standard relational servers like PostgreSQL are recommended for multi-tenant production.
