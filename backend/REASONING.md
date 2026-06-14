# Classroom Companion — Design & Reasoning Notes

This document provides the core domain logic, architectural decisions, security boundaries, and engineering trade-offs implemented in the **Classroom Companion** system.

---

## 1. Domain Model
The database relates schools, classes, users, and assignments using a relational SQLite schema:

*   **School**: The root tenant. All data is scoped under a school.
*   **Class**: Belongs to a school. Maps many students and many teachers.
*   **User**:
    *   `Role: student` — Enrolled in classes, receives assignments, submits work.
    *   `Role: teacher` — Manages assignments, issues feedback.
    *   `Role: coordinator` — System administrator. Oversees class/school health.
*   **Assignment**: Created by teachers for a specific class section.
*   **StudentAssignment**: The junction table tracking individual progress for each student on a given assignment. Holds the progress status, submission texts, and file attachments.
*   **Feedback**: Feedback comments and revision requests posted by teachers.
*   **Reminder**: Log of reminders dispatched to students to prevent spam.

---

## 2. Access Model (Security Boundaries)
Access rules are enforced server-side via Express middleware:

1.  **Coordinator (Admin)**: Has full visibility over the school. Can audit enrollment, view Telegram link rates, create classes, generate teacher invite links, and delete students.
2.  **Teacher**: Restricted to their assigned classes. Can create assignments and grade submissions. They *cannot* view dashboards or data from other classes or schools.
3.  **Student**: Restricted strictly to their own profile. They can only query their own assignments, submissions, and feedback.
4.  **Client-Side Redirection**: Frontends check HTTP response status. A `403 Forbidden` response from the backend automatically triggers a full-screen **Access Denied** view to prevent UI leakage.

---

## 3. State Model (Assignment Lifecycle)
Student assignments transition through a strict state machine to prevent illegal progress jumps:

```
        assigned (Initial)
           │
           ├──➔ acknowledged ("got it")
           │       │
           │       ├──➔ in_progress ("working on it")
           │               │
           │               ├──➔ blocked ("I'm stuck") ──➔ in_progress
           │               │
           │               └──➔ submitted (homework uploaded)
           │                       │
           │                       ├──➔ needs_revision (requested by teacher) ──➔ submitted
           │                       │
           │                       └──➔ completed (graded/approved by teacher)
```
*   **Same-State Updates**: Messages that don't trigger state changes (e.g. sending a general comment while remaining `assigned`) are written as updates without validation failures.
*   **Terminal State**: Once an assignment is `completed`, progress updates are locked.

---

## 4. Identity Model & Telegram Onboarding
To securely link web profiles to Telegram handles without credentials:
1.  **Invite Code Generation**: The Teacher/Coordinator generates an invite code (e.g. `STU-GEN01` or `TEA-XYZ78`) tied to a school and class ID.
2.  **Deep Linking**: The system generates a deep link: `https://t.me/09gen_bot?start=STU-GEN01`.
3.  **Binding**: When the user opens the bot and sends the code, the bot retrieves the pending code and updates the user record with the student's Telegram `chat_id` and handle.

---

## 5. Reminder Policy
Reminders are automated via `node-cron` and adhere to these guidelines:
*   **Context-Aware**: Reminders are generated dynamically by the AI to match the student's specific status (e.g. different messages for a student who is `blocked` vs one who has been `silent`).
*   **Spam Prevention**: The system limits reminder frequencies and logs every dispatch to ensure students are not repeatedly nudged in a short timeframe.

---

## 6. Failure Handling & Fallback Architectures
*   **LLM Fail-Safe**: If the Gemini API reaches its free-tier rate limit (`429 Too Many Requests`) or goes offline, the system catches the exception and falls back to a **local rule-based parser**. This parser uses regex keyword matching on the student's text to update statuses cleanly.
*   **Idempotency Checks**: Telegram bot updates are verified against a message audit log (`message_log`) to discard duplicate webhooks and prevent duplicate processing.

---

## 7. Key Trade-offs
*   **SQLite (`sql.js`) on Disk**: Chosen instead of a full database server (like PostgreSQL) to ensure the application starts up instantly without any environment setup, keeping it developer-friendly.
*   **Monolith Design**: Keeping backend routes, database helpers, and scheduling tasks in a single Express instance reduces deployment complexity for evaluate-ready projects.
