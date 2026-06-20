import os
import sys
import asyncio
from fastapi import FastAPI, Header, HTTPException, Request, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
from dotenv import load_dotenv

# Path patch to support absolute backend imports
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Load environment variables explicitly from the backend folder
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))

from backend.services import db_service, bot_service
from backend.llm import llm_service
from backend.jobs import scheduler

app = FastAPI(title="Classroom Companion API", version="1.0")

# Enable CORS for frontend UI
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Startup event handler
@app.on_event("startup")
async def startup_event():
    # 1. Initialize SQLite Database
    db_service.initialize_database()
    
    # 2. Initialize Telegram Bot
    asyncio.create_task(bot_service.init_bot())
    
    # 3. Start Reminder Job Scheduler
    await scheduler.start_scheduler()

    # 4. Print Dashboard URLs
    print("\n" + "="*50)
    print("      Classroom Companion Web Portals")
    print("="*50)
    print("Coordinator Portal: http://localhost:5500/frontend/coordinator/index.html?user=mehta")
    print("Teacher Portal:     http://localhost:5500/frontend/teacher/index.html?user=manoj")
    print("Student Portal:     http://localhost:5500/frontend/student/index.html?user=maddy")
    print("="*50 + "\n")

# Auth Helpers (Header dependencies)
def get_current_user_id(x_user_id: Optional[str] = Header(None)):
    print(f"DEBUG: get_current_user_id received x-user-id header: {x_user_id}")
    if not x_user_id:
        raise HTTPException(status_code=401, detail="Missing x-user-id header")
    return x_user_id

def require_coordinator(user_id: str = Depends(get_current_user_id)):
    user = db_service.get_user_by_id(user_id)
    print(f"DEBUG: require_coordinator user found for id '{user_id}': {user}")
    if not user or user['role'].lower() != 'coordinator':
        raise HTTPException(status_code=403, detail="Access denied: coordinator only")
    return user

def require_teacher(user_id: str = Depends(get_current_user_id)):
    user = db_service.get_user_by_id(user_id)
    print(f"DEBUG: require_teacher user found for id '{user_id}': {user}")
    if not user or user['role'].lower() not in ['teacher', 'coordinator']:
        raise HTTPException(status_code=403, detail="Access denied: teachers only")
    return user

def require_student(user_id: str = Depends(get_current_user_id)):
    user = db_service.get_user_by_id(user_id)
    print(f"DEBUG: require_student user found for id '{user_id}': {user}")
    if not user or user['role'].lower() != 'student':
        raise HTTPException(status_code=403, detail="Access denied: students only")
    return user


# --- COORDINATOR ROUTES ---

@app.get("/api/coordinator/school")
def get_coordinator_school(coordinator: dict = Depends(require_coordinator)):
    school = db_service.get_school_by_id(coordinator['school_id'])
    if not school:
        raise HTTPException(status_code=404, detail="School not found")
        
    all_users = db_service.get_users_by_school(school['id'])
    teachers = [u for u in all_users if u['role'].lower() in ['teacher', 'coordinator']]
    students = [u for u in all_users if u['role'].lower() == 'student']
    classes = db_service.get_classes_by_school(school['id'])
    
    class_health = []
    for cls in classes:
        # Get class teachers
        conn = db_service.get_db()
        class_teachers_rows = conn.execute(
            "SELECT u.name FROM users u JOIN teacher_classes tc ON u.id=tc.teacher_id WHERE tc.class_id=?", 
            (cls['id'],)
        ).fetchall()
        conn.close()
        
        class_teachers = [r['name'] for r in class_teachers_rows]
        class_students = db_service.get_students_by_class(cls['id'])
        assignments = db_service.get_assignments_by_class(cls['id'])
        
        linked_count = len([s for s in class_students if s['telegram_id']])
        unlinked_count = len(class_students) - linked_count
        
        class_health.append({
            "class": cls,
            "teacherCount": len(class_teachers),
            "teachers": class_teachers,
            "studentCount": len(class_students),
            "studentStats": {"linked": linked_count, "unlinked": unlinked_count},
            "assignmentCount": len(assignments)
        })
        
    return {
        "school": school,
        "summary": {
            "totalTeachers": len(teachers),
            "totalStudents": len(students),
            "totalClasses": len(classes),
            "linkedStudents": len([s for s in students if s['telegram_id']])
        },
        "classes": class_health,
        "teachers": [{
            "id": t['id'],
            "name": t['name'],
            "role": t['role'],
            "telegramLinked": bool(t['telegram_id'])
        } for t in teachers]
    }

class CreateClassModel(BaseModel):
    name: str

@app.post("/api/coordinator/classes", status_code=201)
def create_coordinator_class(body: CreateClassModel, coordinator: dict = Depends(require_coordinator)):
    cls = db_service.create_class(coordinator['school_id'], body.name)
    return {"class": cls}

class InviteTeacherModel(BaseModel):
    classId: Optional[str] = None

@app.post("/api/coordinator/invite-teacher", status_code=201)
def invite_coordinator_teacher(body: InviteTeacherModel, coordinator: dict = Depends(require_coordinator)):
    cls = None
    if body.classId:
        cls = db_service.get_class_by_id(body.classId)
        if not cls or cls['school_id'] != coordinator['school_id']:
            raise HTTPException(status_code=403, detail="Class not in your school")
            
    invite = db_service.create_invite_code({
        "schoolId": coordinator['school_id'],
        "classId": body.classId,
        "role": "teacher",
        "createdBy": coordinator['id'],
        "maxUses": 5
    })
    
    bot_username = os.environ.get('BOT_USERNAME', 'ClassroomCompanionBot')
    return {
        "invite": invite,
        "deepLink": f"https://t.me/{bot_username}?start={invite['code']}"
    }

@app.get("/api/coordinator/students")
def get_coordinator_students(coordinator: dict = Depends(require_coordinator)):
    all_users = db_service.get_users_by_school(coordinator['school_id'])
    students = [u for u in all_users if u['role'].lower() == 'student']
    
    enriched = []
    for s in students:
        assignments = db_service.get_student_assignments_by_student(s['id'])
        enriched.append({
            **s,
            "telegram_linked": bool(s['telegram_id']),
            "total_assignments": len(assignments),
            "overdue": len([a for a in assignments if a['status'] == 'overdue']),
            "blocked": len([a for a in assignments if a['status'] == 'blocked'])
        })
    return {"students": enriched}

@app.delete("/api/coordinator/students/{student_id}")
def delete_coordinator_student(student_id: str, coordinator: dict = Depends(require_coordinator)):
    student = db_service.get_user_by_id(student_id)
    if not student or student['role'].lower() != 'student' or student['school_id'] != coordinator['school_id']:
        raise HTTPException(status_code=403, detail="Student not found or unauthorized")
        
    db_service.delete_student(student_id)
    return {"success": True, "message": f"Student {student['name']} deleted"}

@app.delete("/api/coordinator/teachers/{teacher_id}")
def delete_coordinator_teacher(teacher_id: str, coordinator: dict = Depends(require_coordinator)):
    teacher = db_service.get_user_by_id(teacher_id)
    if not teacher or teacher['role'].lower() not in ['teacher', 'coordinator'] or teacher['school_id'] != coordinator['school_id']:
        raise HTTPException(status_code=403, detail="Teacher not found or unauthorized")
        
    if teacher['id'] == coordinator['id']:
        raise HTTPException(status_code=400, detail="You cannot delete yourself!")
        
    db_service.delete_teacher(teacher_id)
    return {"success": True, "message": f"Teacher {teacher['name']} deleted"}


# --- STUDENT ROUTES ---

@app.get("/api/student/me")
def get_student_me(student: dict = Depends(require_student)):
    return {"user": student}

@app.get("/api/student/assignments")
def get_student_assignments(student: dict = Depends(require_student)):
    assignments = db_service.get_student_assignments_by_student(student['id'])
    
    enriched = []
    for sa in assignments:
        enriched.append({
            **sa,
            "feedback": db_service.get_feedback_for_student_assignment(sa['id'])
        })
        
    active = [a for a in enriched if a['status'] not in ['completed', 'cancelled']]
    completed = [a for a in enriched if a['status'] == 'completed']
    cancelled = [a for a in enriched if a['status'] == 'cancelled']
    
    return {"assignments": enriched, "active": active, "completed": completed, "cancelled": cancelled}

@app.get("/api/student/assignments/{sa_id}")
def get_student_assignment_detail(sa_id: str, student: dict = Depends(require_student)):
    sa = db_service.get_student_assignment_by_id(sa_id)
    if not sa:
        raise HTTPException(status_code=404, detail="Not found")
        
    if sa['student_id'] != student['id']:
        raise HTTPException(status_code=403, detail="This is not your assignment")
        
    feedback = db_service.get_feedback_for_student_assignment(sa['id'])
    return {"assignment": sa, "feedback": feedback}

@app.get("/api/student/dashboard")
def get_student_dashboard(student: dict = Depends(require_student)):
    assignments = db_service.get_student_assignments_by_student(student['id'])
    
    enriched = []
    for sa in assignments:
        enriched.append({
            **sa,
            "feedback": db_service.get_feedback_for_student_assignment(sa['id'])
        })
        
    stats = {
        "total": len(assignments),
        "active": len([a for a in assignments if a['status'] not in ['completed', 'cancelled']]),
        "submitted": len([a for a in assignments if a['status'] in ['submitted', 'needs_revision']]),
        "completed": len([a for a in assignments if a['status'] == 'completed']),
        "overdue": len([a for a in assignments if a['status'] == 'overdue']),
        "blocked": len([a for a in assignments if a['status'] == 'blocked'])
    }
    
    return {"student": student, "assignments": enriched, "stats": stats}


# --- TEACHER ROUTES ---

@app.get("/api/teacher/me")
def get_teacher_me(teacher: dict = Depends(require_teacher)):
    classes = db_service.get_teacher_classes(teacher['id'])
    return {"user": teacher, "classes": classes}

@app.get("/api/teacher/classes")
def get_teacher_classes_list(teacher: dict = Depends(require_teacher)):
    classes = db_service.get_teacher_classes(teacher['id'])
    return {"classes": classes}

@app.get("/api/teacher/classes/{class_id}/assignments")
def get_teacher_class_assignments(class_id: str, teacher: dict = Depends(require_teacher)):
    if not db_service.is_teacher_in_class(teacher['id'], class_id):
        raise HTTPException(status_code=403, detail="You are not authorized for this class")
        
    assignments = db_service.get_assignments_by_class(class_id)
    enriched = []
    for a in assignments:
        students = db_service.get_assignment_students(a['id'])
        status_counts = {}
        for s in students:
            status_counts[s['status']] = status_counts.get(s['status'], 0) + 1
        enriched.append({
            **a,
            "students": students,
            "statusCounts": status_counts,
            "studentCount": len(students)
        })
        
    return {"assignments": enriched}

class CreateAssignmentModel(BaseModel):
    class_id: Optional[str] = None
    classId: Optional[str] = None
    raw_input: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    dueAt: Optional[str] = None
    targetType: Optional[str] = None

@app.post("/api/teacher/assignments", status_code=201)
async def create_teacher_assignment(body: CreateAssignmentModel, teacher: dict = Depends(require_teacher)):
    target_class_id = body.class_id or body.classId
    if not target_class_id:
        raise HTTPException(status_code=400, detail="classId is required")
        
    if not db_service.is_teacher_in_class(teacher['id'], target_class_id):
        raise HTTPException(status_code=403, detail="Not authorized for this class")
        
    final_title = body.title
    final_description = body.description
    final_due_at = body.dueAt

    if body.raw_input:
        try:
            parsed = llm_service.parse_assignment(body.raw_input, datetime.utcnow().isoformat() + 'Z', 'UTC')
            final_title = parsed.get('title') or 'New Assignment'
            final_description = parsed.get('description') or body.raw_input
            final_due_at = parsed.get('due_at')
        except Exception as e:
            print(f"AI parsing failed: {e}")
            final_title = 'New Assignment'
            final_description = body.raw_input

    if not final_title or not final_description:
        raise HTTPException(status_code=400, detail="Title and description are required")

    assignment = db_service.create_assignment({
        "schoolId": teacher['school_id'],
        "classId": target_class_id,
        "teacherId": teacher['id'],
        "title": final_title,
        "description": final_description,
        "dueAt": final_due_at,
        "targetType": body.targetType or 'class',
        "rawInput": body.raw_input
    })

    students = db_service.get_students_by_class(target_class_id)
    notified_count = 0

    for s in students:
        db_service.create_student_assignment(assignment['id'], s['id'])
        if s['telegram_id']:
            due_lbl = final_due_at[:10] if final_due_at else 'TBD'
            msg = f"[Assignment] *New Assignment*\n\n*{final_title}*\n{final_description}\n\nDue: Due: {due_lbl}"
            sent = await bot_service.send_telegram_message(s['telegram_id'], msg, {"parse_mode": "Markdown"})
            if sent:
                notified_count += 1

    return {
        "assignment": assignment,
        "studentsTotal": len(students),
        "studentsNotified": notified_count
    }

class UpdateAssignmentModel(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    dueAt: Optional[str] = None
    status: Optional[str] = None

@app.patch("/api/teacher/assignments/{assignment_id}")
async def update_teacher_assignment(assignment_id: str, body: UpdateAssignmentModel, teacher: dict = Depends(require_teacher)):
    assignment = db_service.get_assignment_by_id(assignment_id)
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")
        
    if assignment['teacher_id'] != teacher['id']:
        raise HTTPException(status_code=403, detail="You can only edit your own assignments")
        
    updated = db_service.update_assignment(assignment_id, body.dict(exclude_none=True))
    
    # Notify updates
    if body.dueAt and body.dueAt != assignment['due_at']:
        students = db_service.get_assignment_students(assignment_id)
        for s in students:
            if s['student_telegram_id'] and s['status'] not in ['completed', 'cancelled']:
                due_lbl = body.dueAt[:10] if body.dueAt else 'TBD'
                msg = f"Due: *Deadline Updated*\n\nThe deadline for \"{assignment['title']}\" has been changed.\n\nNew deadline: {due_lbl}"
                await bot_service.send_telegram_message(s['student_telegram_id'], msg)
                
    if body.status == 'cancelled':
        students = db_service.get_assignment_students(assignment_id)
        for s in students:
            if s['student_telegram_id'] and s['status'] != 'completed':
                msg = f"[Error] *Assignment Cancelled*\n\n\"{assignment['title']}\" has been cancelled by your teacher."
                await bot_service.send_telegram_message(s['student_telegram_id'], msg)
                
    return {"assignment": updated}

@app.get("/api/teacher/assignments/{assignment_id}")
async def get_teacher_assignment_detail(assignment_id: str, teacher: dict = Depends(require_teacher)):
    assignment = db_service.get_assignment_by_id(assignment_id)
    if not assignment:
        raise HTTPException(status_code=404, detail="Not found")
        
    if assignment['teacher_id'] != teacher['id'] and not db_service.is_teacher_in_class(teacher['id'], assignment['class_id']):
        raise HTTPException(status_code=403, detail="Not authorized")
        
    students = db_service.get_assignment_students(assignment_id)
    students_with_feedback = []
    for s in students:
        students_with_feedback.append({
            **s,
            "feedback": db_service.get_feedback_for_student_assignment(s['id'])
        })
        
    summary = llm_service.generate_teacher_summary(
        assignment,
        [{
            "name": s['student_name'],
            "status": s['status'],
            "last_message": s.get('last_student_message')
        } for s in students_with_feedback]
    )
    
    return {"assignment": assignment, "students": students_with_feedback, "summary": summary}

class SendFeedbackModel(BaseModel):
    studentAssignmentId: str
    content: str
    markAsNeedsRevision: Optional[bool] = False

@app.post("/api/teacher/feedback")
async def send_teacher_feedback(body: SendFeedbackModel, teacher: dict = Depends(require_teacher)):
    sa = db_service.get_student_assignment_by_id(body.studentAssignmentId)
    if not sa:
        raise HTTPException(status_code=404, detail="Student assignment not found")
        
    assignment = db_service.get_assignment_by_id(sa['assignment_id'])
    if not db_service.is_teacher_in_class(teacher['id'], assignment['class_id']):
        raise HTTPException(status_code=403, detail="Not authorized for this class")
        
    feedback = db_service.create_feedback(body.studentAssignmentId, teacher['id'], body.content)
    
    new_status = 'needs_revision' if body.markAsNeedsRevision else 'completed'
    db_service.update_student_assignment_status(body.studentAssignmentId, new_status)
    
    # Notify student
    if sa['student_telegram_id']:
        status_lbl = "needs revision " if body.markAsNeedsRevision else "has been marked as completed! Completed!"
        msg = f" *New Feedback from {teacher['name']}*\n\nAssignment: *{assignment['title']}*\nStatus: Your work {status_lbl}\n\nFeedback:\n\"{body.content}\""
        sent = await bot_service.send_telegram_message(sa['student_telegram_id'], msg, {"parse_mode": "Markdown"})
        if sent:
            db_service.mark_feedback_sent(feedback['id'])
            
    return {"feedback": feedback}

@app.post("/api/teacher/trigger-reminders")
async def trigger_teacher_reminders(teacher: dict = Depends(require_teacher)):
    results = await scheduler.run_reminder_cycle()
    return results

@app.post("/api/teacher/remind")
async def trigger_teacher_remind_manual(teacher: dict = Depends(require_teacher)):
    results = await scheduler.run_reminder_cycle()
    return {"message": "Reminder cycle completed", "results": results}

class CreateInviteModel(BaseModel):
    classId: str
    role: str
    maxUses: Optional[int] = 30

@app.post("/api/teacher/invite", status_code=201)
def create_teacher_invite(body: CreateInviteModel, teacher: dict = Depends(require_teacher)):
    if body.role not in ['student', 'teacher']:
        raise HTTPException(status_code=400, detail="role must be student or teacher")
        
    if not db_service.is_teacher_in_class(teacher['id'], body.classId):
        raise HTTPException(status_code=403, detail="Not authorized for this class")
        
    invite = db_service.create_invite_code({
        "schoolId": teacher['school_id'],
        "classId": body.classId,
        "role": body.role,
        "createdBy": teacher['id'],
        "maxUses": body.maxUses
    })
    
    bot_username = os.environ.get('BOT_USERNAME', 'ClassroomCompanionBot')
    deep_link = f"https://t.me/{bot_username}?start={invite['code']}"
    
    return {"invite": invite, "deepLink": deep_link}

@app.get("/api/teacher/dashboard")
def get_teacher_dashboard(teacher: dict = Depends(require_teacher)):
    classes = db_service.get_teacher_classes(teacher['id'])
    
    dashboard = []
    for cls in classes:
        assignments = db_service.get_assignments_by_class(cls['id'])
        
        assignment_summaries = []
        for a in assignments:
            students = db_service.get_assignment_students(a['id'])
            
            submitted_count = len([s for s in students if s['status'] in ['submitted', 'completed']])
            blocked_count = len([s for s in students if s['status'] == 'blocked'])
            overdue_count = len([s for s in students if s['status'] == 'overdue'])
            
            at_risk = []
            for s in students:
                if s['status'] in ['blocked', 'overdue', 'assigned']:
                    at_risk.append({
                        "name": s['student_name'],
                        "status": s['status']
                    })
                    
            assignment_summaries.append({
                **a,
                "studentCount": len(students),
                "submitted": submitted_count,
                "blocked": blocked_count,
                "overdue": overdue_count,
                "atRisk": at_risk
            })
            
        has_risk = any(a['blocked'] > 0 or a['overdue'] > 0 for a in assignment_summaries)
        
        dashboard.append({
            "class": cls,
            "assignments": assignment_summaries,
            "stats": {
                "total": len(assignments),
                "hasRisk": has_risk
            }
        })
        
    return {"teacher": teacher, "dashboard": dashboard}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=3001, log_level="info")
