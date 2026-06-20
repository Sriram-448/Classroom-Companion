import os
import sqlite3
import uuid
import random
import string
from datetime import datetime, timedelta

# Path definition
db_env_path = os.environ.get('DB_PATH')
if db_env_path:
    if not os.path.isabs(db_env_path):
        # Resolve relative to the backend folder
        DB_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', db_env_path))
    else:
        DB_PATH = db_env_path
else:
    DB_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), '../data/classroom.db'))

# Ensure directory exists
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

VALID_TRANSITIONS = {
    'assigned': ['acknowledged', 'in_progress', 'blocked', 'submitted', 'overdue', 'cancelled'],
    'acknowledged': ['in_progress', 'blocked', 'submitted', 'overdue', 'cancelled'],
    'in_progress': ['blocked', 'submitted', 'overdue', 'cancelled'],
    'blocked': ['in_progress', 'submitted', 'overdue', 'cancelled'],
    'submitted': ['needs_revision', 'completed', 'cancelled'],
    'needs_revision': ['submitted', 'cancelled'],
    'completed': [],
    'overdue': ['submitted', 'cancelled'],
    'cancelled': []
}

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def initialize_database():
    conn = get_db()
    cursor = conn.cursor()
    tables = [
        """CREATE TABLE IF NOT EXISTS schools (
            id TEXT PRIMARY KEY, 
            name TEXT NOT NULL, 
            invite_code TEXT UNIQUE NOT NULL, 
            created_at TEXT DEFAULT (datetime('now'))
        )""",
        """CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY, 
            telegram_id TEXT UNIQUE, 
            telegram_handle TEXT, 
            name TEXT NOT NULL, 
            role TEXT NOT NULL, 
            school_id TEXT NOT NULL, 
            is_active INTEGER DEFAULT 1, 
            created_at TEXT DEFAULT (datetime('now'))
        )""",
        """CREATE TABLE IF NOT EXISTS classes (
            id TEXT PRIMARY KEY, 
            school_id TEXT NOT NULL, 
            name TEXT NOT NULL, 
            created_at TEXT DEFAULT (datetime('now'))
        )""",
        """CREATE TABLE IF NOT EXISTS teacher_classes (
            teacher_id TEXT NOT NULL, 
            class_id TEXT NOT NULL, 
            PRIMARY KEY (teacher_id, class_id)
        )""",
        """CREATE TABLE IF NOT EXISTS student_classes (
            student_id TEXT NOT NULL, 
            class_id TEXT NOT NULL, 
            PRIMARY KEY (student_id, class_id)
        )""",
        """CREATE TABLE IF NOT EXISTS invite_codes (
            id TEXT PRIMARY KEY, 
            code TEXT UNIQUE NOT NULL, 
            school_id TEXT NOT NULL, 
            class_id TEXT, 
            role TEXT NOT NULL, 
            created_by TEXT NOT NULL, 
            max_uses INTEGER DEFAULT 1, 
            use_count INTEGER DEFAULT 0, 
            expires_at TEXT, 
            is_active INTEGER DEFAULT 1, 
            created_at TEXT DEFAULT (datetime('now'))
        )""",
        """CREATE TABLE IF NOT EXISTS assignments (
            id TEXT PRIMARY KEY, 
            school_id TEXT NOT NULL, 
            class_id TEXT NOT NULL, 
            teacher_id TEXT NOT NULL, 
            title TEXT NOT NULL, 
            description TEXT NOT NULL, 
            raw_input TEXT, 
            due_at TEXT, 
            timezone TEXT DEFAULT 'UTC', 
            target_type TEXT DEFAULT 'class', 
            status TEXT DEFAULT 'assigned', 
            created_at TEXT DEFAULT (datetime('now')), 
            updated_at TEXT DEFAULT (datetime('now'))
        )""",
        """CREATE TABLE IF NOT EXISTS student_assignments (
            id TEXT PRIMARY KEY, 
            assignment_id TEXT NOT NULL, 
            student_id TEXT NOT NULL, 
            status TEXT DEFAULT 'assigned', 
            last_student_message TEXT, 
            submitted_at TEXT, 
            submission_text TEXT, 
            submission_file_path TEXT, 
            submission_file_name TEXT, 
            completed_at TEXT, 
            created_at TEXT DEFAULT (datetime('now')), 
            updated_at TEXT DEFAULT (datetime('now'))
        )""",
        """CREATE TABLE IF NOT EXISTS feedback (
            id TEXT PRIMARY KEY, 
            student_assignment_id TEXT NOT NULL, 
            teacher_id TEXT NOT NULL, 
            content TEXT NOT NULL, 
            sent_via_telegram INTEGER DEFAULT 0, 
            created_at TEXT DEFAULT (datetime('now'))
        )""",
        """CREATE TABLE IF NOT EXISTS reminders (
            id TEXT PRIMARY KEY, 
            student_assignment_id TEXT NOT NULL, 
            reminder_type TEXT NOT NULL, 
            message TEXT NOT NULL, 
            sent_at TEXT DEFAULT (datetime('now'))
        )""",
        """CREATE TABLE IF NOT EXISTS message_log (
            id TEXT PRIMARY KEY, 
            telegram_update_id TEXT UNIQUE, 
            user_id TEXT, 
            telegram_id TEXT, 
            direction TEXT, 
            content TEXT, 
            message_type TEXT DEFAULT 'text', 
            created_at TEXT DEFAULT (datetime('now'))
        )""",
        """CREATE TABLE IF NOT EXISTS pending_links (
            telegram_id TEXT PRIMARY KEY, 
            invite_code TEXT, 
            created_at TEXT DEFAULT (datetime('now'))
        )"""
    ]
    for sql in tables:
        try:
            cursor.execute(sql)
        except Exception as e:
            print(f"Error creating table: {e}")
    conn.commit()
    conn.close()
    print("Database initialized successfully")

# Helper to serialize sqlite3.Row to dict
def to_dict(row):
    if row is None:
        return None
    return dict(row)

def to_dict_list(rows):
    return [to_dict(row) for row in rows]

# --- SCHOOLS ---
def create_school(name):
    conn = get_db()
    cur = conn.cursor()
    school_id = str(uuid.uuid4())
    invite_code = 'SCH-' + ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
    cur.execute("INSERT INTO schools (id, name, invite_code) VALUES (?, ?, ?)", (school_id, name, invite_code))
    conn.commit()
    conn.close()
    return get_school_by_id(school_id)

def get_school_by_id(school_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM schools WHERE id=?", (school_id,)).fetchone()
    conn.close()
    return to_dict(row)

def get_school_by_invite_code(code):
    conn = get_db()
    row = conn.execute("SELECT * FROM schools WHERE invite_code=?", (code,)).fetchone()
    conn.close()
    return to_dict(row)

# --- CLASSES ---
def create_class(school_id, name):
    conn = get_db()
    cur = conn.cursor()
    class_id = str(uuid.uuid4())
    cur.execute("INSERT INTO classes (id, school_id, name) VALUES (?, ?, ?)", (class_id, school_id, name))
    conn.commit()
    conn.close()
    return get_class_by_id(class_id)

def get_class_by_id(class_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM classes WHERE id=?", (class_id,)).fetchone()
    conn.close()
    return to_dict(row)

def get_classes_by_school(school_id):
    conn = get_db()
    rows = conn.execute("SELECT * FROM classes WHERE school_id=?", (school_id,)).fetchall()
    conn.close()
    return to_dict_list(rows)

def get_teacher_classes(teacher_id):
    conn = get_db()
    rows = conn.execute("""
        SELECT c.*, s.name as school_name FROM classes c
        JOIN teacher_classes tc ON c.id=tc.class_id
        JOIN schools s ON c.school_id=s.id
        WHERE tc.teacher_id=?
    """, (teacher_id,)).fetchall()
    conn.close()
    return to_dict_list(rows)

def add_teacher_to_class(teacher_id, class_id):
    conn = get_db()
    try:
        conn.execute("INSERT INTO teacher_classes (teacher_id, class_id) VALUES (?, ?)", (teacher_id, class_id))
        conn.commit()
    except sqlite3.IntegrityError:
        pass
    conn.close()

def add_student_to_class(student_id, class_id):
    conn = get_db()
    try:
        conn.execute("INSERT INTO student_classes (student_id, class_id) VALUES (?, ?)", (student_id, class_id))
        conn.commit()
    except sqlite3.IntegrityError:
        pass
    conn.close()

def get_students_by_class(class_id):
    conn = get_db()
    rows = conn.execute("""
        SELECT u.* FROM users u 
        JOIN student_classes sc ON u.id=sc.student_id 
        WHERE sc.class_id=?
    """, (class_id,)).fetchall()
    conn.close()
    return to_dict_list(rows)

def is_teacher_in_class(teacher_id, class_id):
    conn = get_db()
    row = conn.execute("SELECT 1 FROM teacher_classes WHERE teacher_id=? AND class_id=?", (teacher_id, class_id)).fetchone()
    conn.close()
    return row is not None

def is_student_in_class(student_id, class_id):
    conn = get_db()
    row = conn.execute("SELECT 1 FROM student_classes WHERE student_id=? AND class_id=?", (student_id, class_id)).fetchone()
    conn.close()
    return row is not None

# --- USERS ---
def create_user(data):
    conn = get_db()
    cur = conn.cursor()
    user_id = str(uuid.uuid4())
    cur.execute("""
        INSERT INTO users (id, telegram_id, telegram_handle, name, role, school_id) 
        VALUES (?, ?, ?, ?, ?, ?)
    """, (
        user_id,
        str(data.get('telegramId')) if data.get('telegramId') else None,
        data.get('telegramHandle'),
        data.get('name'),
        data.get('role'),
        data.get('schoolId')
    ))
    conn.commit()
    conn.close()
    return get_user_by_id(user_id)

def get_user_by_id(user_id):
    if not user_id:
        return None
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if not row:
        row = conn.execute("SELECT * FROM users WHERE telegram_handle=?", (user_id,)).fetchone()
    if not row:
        row = conn.execute("SELECT * FROM users WHERE LOWER(name) LIKE ?", (f"%{user_id.lower()}%",)).fetchone()
    conn.close()
    return to_dict(row)

def get_user_by_telegram_id(telegram_id):
    if not telegram_id:
        return None
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE telegram_id=?", (str(telegram_id),)).fetchone()
    conn.close()
    return to_dict(row)

def link_telegram_to_user(user_id, telegram_id, telegram_handle):
    conn = get_db()
    conn.execute("UPDATE users SET telegram_id=?, telegram_handle=? WHERE id=?", (str(telegram_id), telegram_handle, user_id))
    conn.commit()
    conn.close()

def get_users_by_school(school_id):
    conn = get_db()
    rows = conn.execute("SELECT * FROM users WHERE school_id=?", (school_id,)).fetchall()
    conn.close()
    return to_dict_list(rows)

# --- INVITE CODES ---
def create_invite_code(data):
    conn = get_db()
    cur = conn.cursor()
    code_id = str(uuid.uuid4())
    code = data['role'].upper()[:3] + '-' + ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
    cur.execute("""
        INSERT INTO invite_codes (id, code, school_id, class_id, role, created_by, max_uses, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        code_id,
        code,
        data['schoolId'],
        data.get('classId'),
        data['role'],
        data['createdBy'],
        data.get('maxUses', 1),
        data.get('expiresAt')
    ))
    conn.commit()
    conn.close()
    return get_invite_code_by_id(code_id)

def get_invite_code_by_id(code_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM invite_codes WHERE id=?", (code_id,)).fetchone()
    conn.close()
    return to_dict(row)

def get_invite_code(code):
    conn = get_db()
    row = conn.execute("SELECT * FROM invite_codes WHERE code=?", (code.upper(),)).fetchone()
    conn.close()
    return to_dict(row)

def use_invite_code(code_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM invite_codes WHERE id=?", (code_id,)).fetchone()
    if row:
        inv = dict(row)
        new_count = inv['use_count'] + 1
        new_active = 0 if new_count >= inv['max_uses'] else 1
        conn.execute("UPDATE invite_codes SET use_count=?, is_active=? WHERE id=?", (new_count, new_active, code_id))
        conn.commit()
    conn.close()

def validate_invite_code(code):
    invite = get_invite_code(code)
    if not invite:
        return {"valid": False, "reason": "Code not found"}
    if not invite['is_active']:
        return {"valid": False, "reason": "Code has been fully used or deactivated"}
    if invite['expires_at'] and datetime.fromisoformat(invite['expires_at'].replace('Z', '+00:00')) < datetime.now():
        return {"valid": False, "reason": "Code has expired"}
    return {"valid": True, "invite": invite}

# --- ASSIGNMENTS ---
def create_assignment(data):
    conn = get_db()
    cur = conn.cursor()
    assignment_id = str(uuid.uuid4())
    cur.execute("""
        INSERT INTO assignments (id, school_id, class_id, teacher_id, title, description, raw_input, due_at, timezone, target_type, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assigned')
    """, (
        assignment_id,
        data['schoolId'],
        data['classId'],
        data['teacherId'],
        data['title'],
        data['description'],
        data.get('rawInput'),
        data.get('dueAt'),
        data.get('timezone', 'UTC'),
        data.get('targetType', 'class')
    ))
    conn.commit()
    conn.close()
    return get_assignment_by_id(assignment_id)

def get_assignment_by_id(assignment_id):
    conn = get_db()
    row = conn.execute("""
        SELECT a.*, u.name as teacher_name, c.name as class_name
        FROM assignments a 
        JOIN users u ON a.teacher_id=u.id 
        JOIN classes c ON a.class_id=c.id
        WHERE a.id=?
    """, (assignment_id,)).fetchone()
    conn.close()
    return to_dict(row)

def get_assignments_by_class(class_id):
    conn = get_db()
    rows = conn.execute("""
        SELECT a.*, u.name as teacher_name FROM assignments a 
        JOIN users u ON a.teacher_id=u.id
        WHERE a.class_id=? AND a.status!='cancelled' 
        ORDER BY a.created_at DESC
    """, (class_id,)).fetchall()
    conn.close()
    return to_dict_list(rows)

def update_assignment(assignment_id, data):
    conn = get_db()
    a = conn.execute("SELECT * FROM assignments WHERE id=?", (assignment_id,)).fetchone()
    if not a:
        conn.close()
        return None
    a_dict = dict(a)
    title = data.get('title') if data.get('title') is not None else a_dict['title']
    desc = data.get('description') if data.get('description') is not None else a_dict['description']
    due = data.get('dueAt') if data.get('dueAt') is not None else a_dict['due_at']
    status = data.get('status') if data.get('status') is not None else a_dict['status']
    
    conn.execute("""
        UPDATE assignments SET title=?, description=?, due_at=?, status=?, updated_at=? WHERE id=?
    """, (title, desc, due, status, datetime.utcnow().isoformat() + 'Z', assignment_id))
    conn.commit()
    conn.close()
    return get_assignment_by_id(assignment_id)

# --- STUDENT ASSIGNMENTS ---
def create_student_assignment(assignment_id, student_id):
    conn = get_db()
    existing = conn.execute("SELECT * FROM student_assignments WHERE assignment_id=? AND student_id=?", (assignment_id, student_id)).fetchone()
    if existing:
        conn.close()
        return to_dict(existing)
    sa_id = str(uuid.uuid4())
    conn.execute("""
        INSERT INTO student_assignments (id, assignment_id, student_id, status)
        VALUES (?, ?, ?, 'assigned')
    """, (sa_id, assignment_id, student_id))
    conn.commit()
    conn.close()
    return get_student_assignment(assignment_id, student_id)

def get_student_assignment(assignment_id, student_id):
    conn = get_db()
    row = conn.execute("""
        SELECT sa.*, a.title, a.description, a.due_at, a.timezone, a.teacher_id, a.class_id, a.school_id,
               u.name as student_name, u.telegram_id as student_telegram_id
        FROM student_assignments sa 
        JOIN assignments a ON sa.assignment_id=a.id 
        JOIN users u ON sa.student_id=u.id
        WHERE sa.assignment_id=? AND sa.student_id=?
    """, (assignment_id, student_id)).fetchone()
    conn.close()
    return to_dict(row)

def get_student_assignment_by_id(sa_id):
    conn = get_db()
    row = conn.execute("""
        SELECT sa.*, a.title, a.description, a.due_at, a.timezone, a.teacher_id, a.class_id,
               u.name as student_name, u.telegram_id as student_telegram_id, t.name as teacher_name
        FROM student_assignments sa 
        JOIN assignments a ON sa.assignment_id=a.id 
        JOIN users u ON sa.student_id=u.id 
        JOIN users t ON a.teacher_id=t.id
        WHERE sa.id=?
    """, (sa_id,)).fetchone()
    conn.close()
    return to_dict(row)

def get_student_assignments_by_student(student_id):
    conn = get_db()
    rows = conn.execute("""
        SELECT sa.*, a.title, a.description, a.due_at, a.timezone, c.name as class_name, u.name as teacher_name
        FROM student_assignments sa 
        JOIN assignments a ON sa.assignment_id=a.id 
        JOIN classes c ON a.class_id=c.id 
        JOIN users u ON a.teacher_id=u.id
        WHERE sa.student_id=? AND a.status!='cancelled'
        ORDER BY a.due_at, sa.created_at DESC
    """, (student_id,)).fetchall()
    conn.close()
    return to_dict_list(rows)

def get_assignment_students(assignment_id):
    conn = get_db()
    rows = conn.execute("""
        SELECT sa.*, u.name as student_name, u.telegram_id as student_telegram_id
        FROM student_assignments sa 
        JOIN users u ON sa.student_id=u.id 
        WHERE sa.assignment_id=?
    """, (assignment_id,)).fetchall()
    conn.close()
    return to_dict_list(rows)

def update_student_assignment_status(sa_id, status, extra_data=None):
    if extra_data is None:
        extra_data = {}
    conn = get_db()
    
    current = conn.execute("SELECT * FROM student_assignments WHERE id=?", (sa_id,)).fetchone()
    if not current:
        conn.close()
        raise ValueError(f"SA {sa_id} not found")
        
    current_dict = dict(current)
    valid = VALID_TRANSITIONS.get(current_dict['status'], [])
    if status != current_dict['status'] and status not in valid:
        print(f"Invalid transition {current_dict['status']} to {status}")
        conn.close()
        return to_dict(current)

    fields = ["status=?", "updated_at=?"]
    params = [status, datetime.utcnow().isoformat() + 'Z']
    
    if 'lastStudentMessage' in extra_data:
        fields.append("last_student_message=?")
        params.append(extra_data['lastStudentMessage'])
    if 'submissionText' in extra_data:
        fields.append("submission_text=?")
        params.append(extra_data['submissionText'])
        fields.append("submitted_at=?")
        params.append(datetime.utcnow().isoformat() + 'Z')
    if 'submissionFilePath' in extra_data:
        fields.append("submission_file_path=?")
        params.append(extra_data['submissionFilePath'])
    if 'submissionFileName' in extra_data:
        fields.append("submission_file_name=?")
        params.append(extra_data['submissionFileName'])
    if status == 'completed':
        fields.append("completed_at=?")
        params.append(datetime.utcnow().isoformat() + 'Z')
        
    query = f"UPDATE student_assignments SET {', '.join(fields)} WHERE id=?"
    params.append(sa_id)
    
    conn.execute(query, params)
    conn.commit()
    conn.close()
    return get_student_assignment_by_id(sa_id)

# --- FEEDBACK ---
def get_feedback_for_student_assignment(sa_id):
    conn = get_db()
    rows = conn.execute("""
        SELECT f.*, u.name as teacher_name FROM feedback f
        JOIN users u ON f.teacher_id=u.id
        WHERE f.student_assignment_id=? ORDER BY f.created_at DESC
    """, (sa_id,)).fetchall()
    conn.close()
    return to_dict_list(rows)

def create_feedback(sa_id, teacher_id, content, sent_via_telegram=0):
    conn = get_db()
    cur = conn.cursor()
    feedback_id = str(uuid.uuid4())
    cur.execute("""
        INSERT INTO feedback (id, student_assignment_id, teacher_id, content, sent_via_telegram)
        VALUES (?, ?, ?, ?, ?)
    """, (feedback_id, sa_id, teacher_id, content, sent_via_telegram))
    conn.commit()
    conn.close()
    return get_feedback_by_id(feedback_id)

def get_feedback_by_id(feedback_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM feedback WHERE id=?", (feedback_id,)).fetchone()
    conn.close()
    return to_dict(row)

def mark_feedback_sent(feedback_id):
    conn = get_db()
    conn.execute("UPDATE feedback SET sent_via_telegram=1 WHERE id=?", (feedback_id,))
    conn.commit()
    conn.close()

# --- REMINDERS & AUDIT ---
def log_reminder(sa_id, reminder_type, message):
    conn = get_db()
    rem_id = str(uuid.uuid4())
    conn.execute("""
        INSERT INTO reminders (id, student_assignment_id, reminder_type, message) VALUES (?, ?, ?, ?)
    """, (rem_id, sa_id, reminder_type, message))
    conn.commit()
    conn.close()

def get_recent_reminders(sa_id, hours_back=24):
    conn = get_db()
    cutoff = (datetime.utcnow() - timedelta(hours=hours_back)).isoformat() + 'Z'
    rows = conn.execute("""
        SELECT * FROM reminders WHERE student_assignment_id=? AND sent_at>?
    """, (sa_id, cutoff)).fetchall()
    conn.close()
    return to_dict_list(rows)

def get_assignments_due_for_reminder():
    conn = get_db()
    rows = conn.execute("""
        SELECT sa.*, a.title, a.due_at, a.timezone, a.class_id,
               u.name as student_name, u.telegram_id as student_telegram_id,
               t.name as teacher_name, t.telegram_id as teacher_telegram_id
        FROM student_assignments sa 
        JOIN assignments a ON sa.assignment_id=a.id
        JOIN users u ON sa.student_id=u.id 
        JOIN users t ON a.teacher_id=t.id
        WHERE sa.status NOT IN ('completed', 'cancelled') AND a.status='assigned' AND u.telegram_id IS NOT NULL
    """).fetchall()
    conn.close()
    return to_dict_list(rows)

def has_processed_update(update_id):
    if not update_id:
        return False
    conn = get_db()
    row = conn.execute("SELECT 1 FROM message_log WHERE telegram_update_id=?", (str(update_id),)).fetchone()
    conn.close()
    return row is not None

def log_message(data):
    conn = get_db()
    cur = conn.cursor()
    log_id = str(uuid.uuid4())
    try:
        cur.execute("""
            INSERT INTO message_log (id, telegram_update_id, user_id, telegram_id, direction, content, message_type)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            log_id,
            str(data.get('updateId')) if data.get('updateId') else None,
            data.get('userId'),
            str(data.get('telegramId')) if data.get('telegramId') else None,
            data.get('direction'),
            data.get('content'),
            data.get('messageType', 'text')
        ))
        conn.commit()
    except Exception:
        pass
    conn.close()

# --- PENDING LINKS ---
def save_pending_link(telegram_id, invite_code):
    conn = get_db()
    try:
        conn.execute("""
            INSERT OR REPLACE INTO pending_links (telegram_id, invite_code) VALUES (?, ?)
        """, (str(telegram_id), invite_code))
        conn.commit()
    except Exception:
        pass
    conn.close()

def get_pending_link(telegram_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM pending_links WHERE telegram_id=?", (str(telegram_id),)).fetchone()
    conn.close()
    return to_dict(row)

def delete_pending_link(telegram_id):
    conn = get_db()
    conn.execute("DELETE FROM pending_links WHERE telegram_id=?", (str(telegram_id),))
    conn.commit()
    conn.close()

# --- ADMINISTRATIVE ---
def delete_student(student_id):
    conn = get_db()
    conn.execute("DELETE FROM student_classes WHERE student_id=?", (student_id,))
    conn.execute("DELETE FROM student_assignments WHERE student_id=?", (student_id,))
    conn.execute("DELETE FROM users WHERE id=?", (student_id,))
    conn.commit()
    conn.close()

def delete_teacher(teacher_id):
    conn = get_db()
    conn.execute("DELETE FROM teacher_classes WHERE teacher_id=?", (teacher_id,))
    conn.execute("DELETE FROM users WHERE id=?", (teacher_id,))
    conn.commit()
    conn.close()
