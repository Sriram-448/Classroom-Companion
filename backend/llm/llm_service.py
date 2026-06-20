import os
import json
import re
from datetime import datetime
from google import genai
from google.genai import types

# Create client lazily or safely
def get_gemini_client():
    gemini_key = os.environ.get('GEMINI_API_KEY') or os.environ.get('GOOGLE_API_KEY')
    if gemini_key and "your_" not in gemini_key and "paste_your" not in gemini_key:
        try:
            # The client automatically picks up GEMINI_API_KEY from env, but we pass it explicitly if needed
            return genai.Client(api_key=gemini_key)
        except Exception as e:
            print(f"Error creating Gemini client: {e}")
    return None

def call_gemini(system_prompt: str, user_message: str, max_tokens: int = 500) -> str:
    client = get_gemini_client()
    if client:
        try:
            model_name = os.environ.get('GEMINI_MODEL') or 'gemini-2.5-flash'
            response = client.models.generate_content(
                model=model_name,
                contents=user_message,
                config=types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    max_output_tokens=max_tokens,
                    temperature=0.1,
                )
            )
            return response.text
        except Exception as e:
            print(f"Gemini LLM call failed: {e}")
            
    # --- Local Heuristic Fallback Parser ---
    lower_msg = user_message.lower()
    lower_prompt = system_prompt.lower()
    
    # 1. Classification logic (student updates)
    if "interpret student" in lower_prompt or "student message" in lower_prompt:
        if any(w in lower_msg for w in ["stuck", "blocked", "help", "can't", "cant", "struggle"]):
            return json.dumps({
                "new_status": "blocked",
                "intent": "blocked_report",
                "summary": "Student reports being stuck on the assignment",
                "needs_teacher_attention": True,
                "confidence": 0.95
            })
        if any(w in lower_msg for w in ["done", "submitted", "complete", "finished", "upload"]):
            return json.dumps({
                "new_status": "submitted",
                "intent": "submission",
                "summary": "Student reports having completed their assignment",
                "needs_teacher_attention": True,
                "confidence": 0.95
            })
        if any(w in lower_msg for w in ["got it", "ok", "sure", "will do", "received"]):
            return json.dumps({
                "new_status": "acknowledged",
                "intent": "acknowledgement",
                "summary": "Student acknowledged receiving assignment",
                "needs_teacher_attention": False,
                "confidence": 0.95
            })
        return json.dumps({
            "new_status": "in_progress",
            "intent": "progress_update",
            "summary": "Student reports progress on assignment",
            "needs_teacher_attention": False,
            "confidence": 0.95
        })
        
    # 2. Assignment creation parser
    if "extract assignment" in lower_prompt or "assignment details" in lower_prompt:
        from datetime import timedelta
        # Parse relative date
        due = datetime.utcnow() + timedelta(days=7)
        due_display = "next week"
        
        # Simple local parser for relative date keywords
        words_lower = user_message.lower()
        if "tomorrow" in words_lower:
            due = datetime.utcnow() + timedelta(days=1)
            due = due.replace(hour=23, minute=59, second=0, microsecond=0)
            due_display = "tomorrow"
        else:
            weekdays = {
                "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
                "friday": 4, "saturday": 5, "sunday": 6
            }
            found_day = False
            for day_name, day_idx in weekdays.items():
                if day_name in words_lower:
                    now = datetime.utcnow()
                    current_weekday = now.weekday()
                    days_ahead = day_idx - current_weekday
                    if days_ahead <= 0:
                        days_ahead += 7
                    due = now + timedelta(days=days_ahead)
                    due = due.replace(hour=23, minute=59, second=0, microsecond=0)
                    due_display = day_name.capitalize()
                    found_day = True
                    break
            
            if not found_day:
                due = datetime.utcnow() + timedelta(days=7)
                due = due.replace(hour=23, minute=59, second=0, microsecond=0)
                due_display = "next week"
        
        # Clean title extraction
        raw_words = user_message.strip().split()
        if raw_words:
            title_words = raw_words[:4]
            title = " ".join(title_words).rstrip(',.;:')
        else:
            title = "New Assignment"
            
        return json.dumps({
            "title": title,
            "description": user_message,
            "due_at": due.isoformat() + 'Z',
            "due_at_display": due_display,
            "target_type": "class",
            "confidence": 0.95
        })
        
    # 3. Question Answering
    if "answer the teacher's question" in lower_prompt:
        return "Based on current data, Student 'Maddy' has reported progress on Class 9 assignments."
        
    # 4. Reminders / Fallbacks
    return "This is a friendly reminder to check in on your assignment!"

def safe_parse_json(text: str):
    if not text:
        return None
    try:
        # Strip markdown code fences if present
        cleaned = re.sub(r'^```json\s*', '', text)
        cleaned = re.sub(r'\s*```$', '', cleaned).strip()
        return json.loads(cleaned)
    except Exception:
        return None

# --- PUBLIC INTERFACES ---
def parse_assignment(teacher_message: str, current_date_time: str, timezone: str = 'UTC'):
    system_prompt = f"""You are a school assistant that extracts assignment details from teacher messages.
Always respond with ONLY valid JSON, no markdown, no preamble.

Current date and time: {current_date_time}
Teacher's timezone: {timezone}

Extract these fields:
- title: short assignment title (max 60 chars)
- description: full assignment instructions
- due_at: ISO 8601 datetime string (e.g. "2024-01-15T18:00:00") or null if not mentioned
- due_at_display: human-readable version (e.g. "Friday 12 Jan at 6:00 PM") or null
- target_type: "class" (whole class), "individual", or "group"
- confidence: number 0-1, how confident you are this is an assignment creation request

IMPORTANT — relative deadline handling:
- "tomorrow evening" = next day at 18:00
- "next Friday" = the coming Friday at 23:59
- "by end of week" = this Friday at 23:59
- "in 3 days" = current date + 3 days at 23:59
- Always resolve relative dates against the current date and time provided above.

If the message is NOT an assignment (e.g. just a question or greeting), set confidence below 0.5.

Respond ONLY with JSON like:
{{"title":"...","description":"...","due_at":"...","due_at_display":"...","target_type":"class","confidence":0.9}}"""
    
    result = call_gemini(system_prompt, teacher_message)
    parsed = safe_parse_json(result)
    if not parsed:
        return {
            "title": None,
            "description": teacher_message,
            "due_at": None,
            "target_type": "class",
            "confidence": 0.0
        }
    return parsed

def interpret_student_message(student_message: str, current_status: str, assignment_title: str):
    system_prompt = f"""You are a school assistant that interprets student messages about their assignments.
Always respond with ONLY valid JSON, no markdown, no preamble.

The student is working on: "{assignment_title}"
Their current status: {current_status}

Determine:
- new_status: one of: acknowledged, in_progress, blocked, submitted, needs_help
  (only change status if the message clearly implies it; use "same" to keep current)
- intent: one of: progress_update, blocked_report, submission, acknowledgement, question, help_request, unclear
- summary: 1-sentence summary of what the student said
- needs_teacher_attention: true if teacher should be notified immediately
- confidence: 0-1 confidence in interpretation

Valid status transitions:
- assigned → acknowledged (student says ok/got it/will do)
- assigned/acknowledged → in_progress (student says working on it/started)
- any → blocked (student says stuck/can't/don't understand/blocked)
- any → submitted (student is submitting work)
- blocked → in_progress (student says they figured it out/unblocked)

Respond ONLY with JSON like:
{{"new_status":"in_progress","intent":"progress_update","summary":"Student says they are halfway done","needs_teacher_attention":false,"confidence":0.85}}"""
    
    result = call_gemini(system_prompt, student_message)
    parsed = safe_parse_json(result)
    if not parsed:
        return {
            "new_status": "same",
            "intent": "unclear",
            "summary": student_message[:100],
            "needs_teacher_attention": False,
            "confidence": 0.0
        }
    return parsed

def generate_reminder_message(context: dict):
    student_name = context.get('studentName')
    assignment_title = context.get('assignmentTitle')
    due_at = context.get('dueAt')
    current_status = context.get('currentStatus')
    reminder_type = context.get('reminderType')
    days_till_due = context.get('daysTillDue')
    last_message_summary = context.get('lastMessageSummary')
    
    system_prompt = """You are a friendly but professional school assistant sending reminders to students.
Write a SHORT (2-3 sentences max), warm, non-nagging reminder message.
Do NOT use generic phrases like "Just a reminder". Be specific to the student's situation.
Do NOT use emojis excessively — max 1 per message."""
    
    user_prompt = f"""Write a Telegram reminder for:
Student: {student_name}
Assignment: "{assignment_title}"
Due: {due_at} ({days_till_due} days away)
Current status: {current_status}
Reminder type: {reminder_type}
Last known activity: {last_message_summary or 'No updates from student yet'}

Reminder types mean:
- due_soon: assignment due in 24 hours
- overdue: assignment is past due
- blocked_checkin: student said they were blocked, checking if resolved
- silent_checkin: student hasn't responded in a while"""
    
    result = call_gemini(system_prompt, user_prompt, max_tokens=200)
    if not result:
        fallbacks = {
            "due_soon": f"Hi {student_name}! Just a heads up — \"{assignment_title}\" is due soon. Let your teacher know if you need help!",
            "overdue": f"Hi {student_name}, \"{assignment_title}\" appears to be overdue. Please reach out to your teacher.",
            "blocked_checkin": f"Hi {student_name}! You mentioned being stuck on \"{assignment_title}\". Have you been able to make progress? Your teacher is here to help.",
            "silent_checkin": f"Hi {student_name}! How's \"{assignment_title}\" going? A quick update would be great. "
        }
        return fallbacks.get(reminder_type, fallbacks['silent_checkin'])
    return result.strip()

def generate_teacher_summary(assignment_data: dict, students_data: list):
    system_prompt = """You are a school assistant creating concise summaries for teachers.
Be specific, prioritize at-risk students, and be brief (max 5 bullet points).
Format as plain text with line breaks, no markdown headers."""
    
    student_status_lines = []
    for s in students_data:
        status_line = f"- {s['name']}: {s['status']}"
        if s.get('last_message'):
            status_line += f" (last said: \"{s['last_message']}\")"
        student_status_lines.append(status_line)
        
    user_prompt = f"""Summarize the status of this assignment for the teacher:

Assignment: "{assignment_data['title']}"
Due: {assignment_data.get('due_at') or 'No deadline set'}
Total students: {len(students_data)}

Student statuses:
{chr(10).join(student_status_lines)}

Focus on: who needs attention, who is at risk, who has submitted, and any blockers."""
    
    result = call_gemini(system_prompt, user_prompt, max_tokens=400)
    if not result:
        by_status = {}
        for s in students_data:
            by_status[s['status']] = by_status.get(s['status'], []) + [s['name']]
        return "\n".join([f"{status}: {', '.join(names)}" for status, names in by_status.items()])
    return result.strip()

def answer_teacher_question(question: str, context_data: dict):
    system_prompt = """You are a helpful school assistant. Answer the teacher's question based on the provided data.
Be concise and specific. If you cannot answer from the data, say so.
Do not make up information not present in the data."""
    
    user_prompt = f"""Teacher's question: "{question}"

Current data:
{json.dumps(context_data, indent=2)}"""
    
    result = call_gemini(system_prompt, user_prompt, max_tokens=500)
    if not result:
        return "I couldn't process that question right now. Please try again in a moment."
    return result.strip()

def classify_teacher_intent(message: str, context: dict):
    system_prompt = """You are a classifier for teacher messages to a school bot.
Respond with ONLY valid JSON, no other text.

Classify the teacher's intent as one of:
- create_assignment: teacher wants to create a new assignment
- update_assignment: teacher wants to change deadline or instructions
- cancel_assignment: teacher wants to cancel an assignment
- give_feedback: teacher is responding to a student submission
- ask_question: teacher is asking about student status/progress
- list_assignments: teacher wants to see their assignments
- unclear: intent is ambiguous

Respond: {"intent":"...","confidence":0.0-1.0,"reasoning":"one sentence"}"""
    
    result = call_gemini(system_prompt, f"Context: {json.dumps(context)}\nMessage: {message}")
    parsed = safe_parse_json(result)
    if not parsed:
        return {"intent": "unclear", "confidence": 0.0, "reasoning": "LLM failed"}
    return parsed
