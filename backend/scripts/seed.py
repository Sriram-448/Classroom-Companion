import os
import sys
import sqlite3

# Path patch to support absolute backend imports
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# Load environment variables
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env'))

from backend.services import db_service

def seed():
    # Force database initialization
    db_service.initialize_database()
    
    conn = db_service.get_db()
    cur = conn.cursor()
    
    # Check if school already exists
    school = cur.execute("SELECT * FROM schools").fetchone()
    if school:
        print("Database already seeded. Skipping...")
        conn.close()
        return

    print("Seeding database with default mock data...")
    
    # Create school
    school_id = "srm-university-id"
    cur.execute(
        "INSERT INTO schools (id, name, invite_code) VALUES (?, ?, ?)", 
        (school_id, "SRM University", "SCH-SRM123")
    )
    
    # Create classes
    classes = [
        ("maths-class-id", "Class 9 - Maths"),
        ("science-class-id", "Class 10 - Science"),
        ("social-class-id", "Grade 10 - Social Science")
    ]
    for cid, name in classes:
        cur.execute("INSERT INTO classes (id, school_id, name) VALUES (?, ?, ?)", (cid, school_id, name))
        
    # Create users
    users = [
        # Coordinator
        ("mehta", None, None, "Principal Mehta", "coordinator", school_id),
        # Teachers
        ("2e8a01b7-8efe-41e3-938c-97be53b05d75", "11223344", "manoj_m", "MANOJ M", "teacher", school_id),
        ("87394a90-9e0e-4ae2-8946-0beac5e37809", "55667788", "sharma_ms", "Ms. Sharma", "teacher", school_id),
        # Students
        ("maddy", None, None, "Maddy", "student", school_id),
        ("priya", None, None, "Priya Singh", "student", school_id),
        ("rahul", None, None, "Rahul Verma", "student", school_id)
    ]
    
    for uid, tg_id, tg_handle, name, role, sid in users:
        cur.execute(
            "INSERT INTO users (id, telegram_id, telegram_handle, name, role, school_id) VALUES (?, ?, ?, ?, ?, ?)",
            (uid, tg_id, tg_handle, name, role, sid)
        )
        
    # Link teachers to classes
    teacher_classes = [
        ("2e8a01b7-8efe-41e3-938c-97be53b05d75", "maths-class-id"),
        ("87394a90-9e0e-4ae2-8946-0beac5e37809", "science-class-id")
    ]
    for tid, cid in teacher_classes:
        cur.execute("INSERT INTO teacher_classes (teacher_id, class_id) VALUES (?, ?)", (tid, cid))
        
    # Link students to classes
    student_classes = [
        ("maddy", "maths-class-id"),
        ("priya", "science-class-id"),
        ("rahul", "science-class-id")
    ]
    for sid, cid in student_classes:
        cur.execute("INSERT INTO student_classes (student_id, class_id) VALUES (?, ?)", (sid, cid))
        
    conn.commit()
    conn.close()
    print("Database seeding completed successfully!")

if __name__ == "__main__":
    seed()
