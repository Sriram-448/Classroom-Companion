# Classroom Companion

Classroom Companion is an AI-powered assistant designed to manage school classes, assignments, and student/teacher interactions through a Telegram Bot and web portals.

---

## 1. Quick Start & Setup

### Installation
1. Clone the repository and navigate to the project directory.
2. Navigate to the backend directory:
   ```bash
   cd backend
   ```
3. Install all dependencies:
   ```bash
   pip install -r ../requirements.txt
   ```
   *(Or if using the legacy Node.js server, run `npm install`)*

### Configuration (`.env`)
Create a `.env` file in the `backend/` folder containing:
```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
BOT_USERNAME=your_bot_username
GEMINI_API_KEY=your_gemini_api_key
PORT=3001
NODE_ENV=development
DB_PATH=./data/classroom.db
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:5500,http://localhost:5500,null
```

### Seeding the Database
To reset and seed the database with initial demo data, run the seed script:
```bash
python scripts/seed.py
```

### Running the App
Start the FastAPI server:
```bash
python main.py
```

---

## 2. Test Accounts & Runbook

The application is seeded with the following short-login credentials:

- **Coordinator: Principal Mehta** (URL: `?user=mehta`) - Oversees school classrooms, manages class directories, issues invite codes, and audits registrations.
- **Teacher: MANOJ M** (URL: `?user=manoj`) - Creates assignments, tracks completions, and provides grading comments.
- **Teacher: Ms. Sharma** (URL: `?user=sharma`) - Creates and manages assignments for Grade 8 / Class 9.
- **Student: Maddy** (URL: `?user=maddy`) - Reviews homework, sends updates to the Telegram bot, and reads feedback comments.
- **Student: Rahul Verma** (URL: `?user=rahul`) - Views personalized lists of active and overdue tasks.

### Accessing the Web portals:
Ensure the backend server is running on port `3001` and frontend files are served on port `3000`:
*   **Admin Console**: [http://localhost:3000/coordinator/index.html?user=mehta](http://localhost:3000/coordinator/index.html?user=mehta)
*   **Teacher Console**: [http://localhost:3000/teacher/index.html?user=manoj](http://localhost:3000/teacher/index.html?user=manoj)
*   **Student Console**: [http://localhost:3000/student/index.html?user=maddy](http://localhost:3000/student/index.html?user=maddy)

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
