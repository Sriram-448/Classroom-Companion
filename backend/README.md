# Classroom Companion Backend

Classroom Companion is an AI-powered assistant designed to manage school classes, assignments, and student/teacher interactions through a Telegram Bot and web portals.

---

## 1. Quick Start & Setup

### Prerequisites
*   Node.js (v18 or higher recommended)
*   npm (installed with Node)

### Installation
1.  Navigate to the backend directory:
    ```bash
    cd C:\Users\rayid\OneDrive\Desktop\classroom-companion\backend
    ```
2.  Install all dependencies:
    ```bash
    npm install
    ```

### Configuration (`.env`)
Create a `.env` file in the root of the backend folder containing:
```env
TELEGRAM_BOT_TOKEN=8878433273:AAGjPvtJwLOqPm4odM88Vzl5fsX9kgOsktY
BOT_USERNAME=09gen_bot
GEMINI_API_KEY=your_gemini_api_key
PORT=3001
NODE_ENV=development
DB_PATH=./data/classroom.db
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:5500,http://localhost:5500,null
```

### Seeding the Database
To reset and seed the database with initial demo data, run:
```bash
npm run seed
```

### Running the App
Start the development server with hot-reloading:
```bash
npm run dev
```

---

## 2. Test Accounts & Runbook

The application is seeded with the following short-login credentials:

| Role | Name | URL Parameter | Purpose |
| :--- | :--- | :--- | :--- |
| **Coordinator** | Principal Mehta | `?user=mehta` | View class link rates, manage classes, invite teachers, delete students. |
| **Teacher** | MANOJ M | `?user=manoj` | Create assignments, review submissions, grade feedback. |
| **Teacher** | Ms. Sharma | `?user=sharma` | Create assignments, manage Grade 8 / Class 9. |
| **Student** | Maddy | `?user=maddy` | Check active homework, submit tasks, read feedback. |
| **Student** | Rahul Verma | `?user=rahul` | View checklist of active/overdue tasks. |

### Accessing the Web portals:
Ensure the server is running on port `3001` and navigate to:
*   **Admin Console**: [http://localhost:3001/coordinator/index.html?user=mehta](http://localhost:3001/coordinator/index.html?user=mehta)
*   **Teacher Console**: [http://localhost:3001/teacher/index.html?user=manoj](http://localhost:3001/teacher/index.html?user=manoj)
*   **Student Console**: [http://localhost:3001/student/index.html?user=maddy](http://localhost:3001/student/index.html?user=maddy)

---

## 3. Core Architecture & Design
Please refer to the detailed domain designs, state machines, and access boundaries documented in:
👉 [REASONING.md](./REASONING.md)

---

## 4. Runbook: Step-by-Step Demo Flow
To test the entire system end-to-end:
1.  **Delete Existing Student**: Go to the **Admin Portal** (`?user=mehta`), locate **Maddy** in the registry, and click **Delete** to clean her record.
2.  **Generate Invite Link**: On the Admin portal, select **Class 10-maths** and click **Generate Invite Link**.
3.  **Onboard Maddy**: Open the bot (`@09gen_bot`) on Telegram, type `/start`, and paste the generated invite code. She is now registered.
4.  **Create Assignment**: Go to the **Teacher Dashboard** (`?user=manoj`), select Class 10-maths, and type: *"Create essay on climate change due next Friday"*. Click **Create & Distribute**. The bot will immediately notify Maddy on Telegram.
5.  **Submit Work**: In Telegram, reply: *"I have finished the climate change essay"*. The bot will parse the completion and update the status in the DB.
6.  **Grading**: Refresh the Teacher Dashboard, open the assignment, type feedback comments under Maddy's row, and click **Accept & Complete**. Maddy will receive a message from the bot with her grade feedback.

---

## 5. Known Limitations
*   **Authentication**: Real-world apps use session cookies or JWT tokens. This demo parses the `x-user-id` header/parameter for simplicity and developer inspection.
*   **Concurrency**: Uses a local SQLite driver (`sql.js`) which locks the database file on concurrent writes. Standard relational servers like PostgreSQL are recommended for multi-tenant production.
