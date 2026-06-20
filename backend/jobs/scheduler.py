import asyncio
from datetime import datetime
from backend.services import db_service, bot_service
from backend.llm import llm_service

scheduler_running = False

async def run_reminder_cycle():
    global scheduler_running
    if scheduler_running:
        print("[Warning]️ Reminder cycle already running, skipping")
        return {"skipped": True}

    scheduler_running = True
    results = {"sent": 0, "skipped": 0, "errors": 0}

    try:
        active_sas = db_service.get_assignments_due_for_reminder()
        print(f" Checking {len(active_sas)} active student assignments")

        for sa in active_sas:
            try:
                result = await process_student_assignment(sa)
                if result == 'sent':
                    results['sent'] += 1
                elif result == 'skipped':
                    results['skipped'] += 1
            except Exception as e:
                print(f"[Error] Reminder error for SA {sa['id']}: {e}")
                results['errors'] += 1

        print(f" Reminder cycle: {results['sent']} sent, {results['skipped']} skipped, {results['errors']} errors")
    finally:
        scheduler_running = False

    return results

async def process_student_assignment(sa):
    now = datetime.utcnow()

    # Parse due date
    due_date = None
    hours_until_due = None
    days_till_due = None
    is_overdue = False

    if sa.get('due_at'):
        try:
            # handle formats like 2026-06-14T12:00:00.000Z or similar
            due_clean = sa['due_at'].replace('Z', '').split('.')[0]
            due_date = datetime.fromisoformat(due_clean)
            hours_until_due = (due_date - now).total_seconds() / 3600.0
            days_till_due = int(hours_until_due / 24.0) + 1
            is_overdue = hours_until_due < 0
        except Exception as e:
            print(f"Error parsing due date {sa['due_at']}: {e}")

    # Determine what kind of reminder to send
    reminder_type = None

    if sa['status'] == 'blocked':
        # Blocked: check in after 12h
        recent = db_service.get_recent_reminders(sa['id'], 12)
        has_recent = any(r['reminder_type'] == 'blocked_checkin' for r in recent)
        if not has_recent:
            reminder_type = 'blocked_checkin'
    elif is_overdue and sa['status'] != 'submitted':
        # Overdue: once per 24h, max 3
        recent = db_service.get_recent_reminders(sa['id'], 24)
        has_recent = any(r['reminder_type'] == 'overdue' for r in recent)
        all_r = db_service.get_recent_reminders(sa['id'], 72)
        total_overdue = len([r for r in all_r if r['reminder_type'] == 'overdue'])
        if not has_recent and total_overdue < 3:
            reminder_type = 'overdue'
    elif due_date and 0 < hours_until_due <= 24:
        # Due in 24h: one reminder
        recent = db_service.get_recent_reminders(sa['id'], 24)
        has_recent = any(r['reminder_type'] == 'due_soon' for r in recent)
        if not has_recent:
            reminder_type = 'due_soon'
    elif sa['status'] == 'assigned' and not sa.get('last_student_message'):
        # Silent: no updates in 48h
        try:
            created_clean = sa['created_at'].replace('Z', '').split('.')[0]
            created_at = datetime.fromisoformat(created_clean)
            hours_since_created = (now - created_at).total_seconds() / 3600.0
            if hours_since_created > 48:
                recent = db_service.get_recent_reminders(sa['id'], 48)
                has_recent = any(r['reminder_type'] == 'silent_checkin' for r in recent)
                if not has_recent:
                    reminder_type = 'silent_checkin'
        except Exception as e:
            print(f"Error parsing created_at {sa['created_at']}: {e}")

    if not reminder_type:
        return 'skipped'

    # Generate message
    due_display = due_date.strftime('%Y-%m-%d') if due_date else 'no deadline'
    message = llm_service.generate_reminder_message({
        "studentName": sa['student_name'],
        "assignmentTitle": sa['title'],
        "dueAt": due_display,
        "currentStatus": sa['status'],
        "reminderType": reminder_type,
        "daysTillDue": days_till_due or 0,
        "lastMessageSummary": sa.get('last_student_message')
    })

    # Send message
    sent = await bot_service.send_telegram_message(sa['student_telegram_id'], message)
    if sent:
        db_service.log_reminder(sa['id'], reminder_type, message)
        print(f"Sent {reminder_type} reminder to {sa['student_name']} for \"{sa['title']}\"")
        return 'sent'

    return 'skipped'

async def mark_overdue_assignments():
    active_sas = db_service.get_assignments_due_for_reminder()
    marked_overdue = 0
    now = datetime.utcnow()

    for sa in active_sas:
        if not sa.get('due_at'):
            continue
        try:
            due_clean = sa['due_at'].replace('Z', '').split('.')[0]
            due_date = datetime.fromisoformat(due_clean)
            is_overdue = due_date < now
            if is_overdue and sa['status'] not in ['submitted', 'completed', 'overdue', 'cancelled']:
                db_service.update_student_assignment_status(sa['id'], 'overdue')
                marked_overdue += 1
                print(f"Marked {sa['student_name']}'s \"{sa['title']}\" as overdue")
        except Exception as e:
            print(f"Error parsing date {sa['due_at']}: {e}")

    if marked_overdue > 0:
        print(f"Marked {marked_overdue} assignments as overdue")

async def start_scheduler():
    print("[OK] Reminder scheduler started (30m cycle, 1h overdue check)")
    async def reminder_loop():
        while True:
            await asyncio.sleep(1800)  # every 30 minutes
            try:
                await run_reminder_cycle()
            except Exception as e:
                print(f"Error in background reminder tick: {e}")

    async def overdue_loop():
        while True:
            await asyncio.sleep(3600)  # every hour
            try:
                await mark_overdue_assignments()
            except Exception as e:
                print(f"Error in background overdue tick: {e}")

    asyncio.create_task(reminder_loop())
    asyncio.create_task(overdue_loop())
