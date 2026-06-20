import os
import json
import base64
import asyncio
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, MessageHandler, CallbackQueryHandler, ContextTypes, filters
from backend.services import db_service
from backend.llm import llm_service

# Global bot instance
bot_app = None
pending_assignments = {}  # key: teacher_user_id, value: dict

async def get_bot():
    return bot_app.bot if bot_app else None

async def send_telegram_message(telegram_id, message, options=None):
    if not bot_app:
        print("Warning: Bot not initialized, cannot send message")
        return False
    if options is None:
        options = {}
    try:
        parse_mode = options.get('parse_mode', None)
        reply_markup = options.get('reply_markup', None)
        await bot_app.bot.send_message(
            chat_id=str(telegram_id), 
            text=message, 
            parse_mode=parse_mode,
            reply_markup=reply_markup
        )
        db_service.log_message({
            "telegramId": str(telegram_id),
            "direction": "outgoing",
            "content": message[:500],
            "messageType": "text"
        })
        return True
    except Exception as e:
        print(f"Error: Failed to send Telegram message to {telegram_id}: {e}")
        return False

# Message processing router
async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message:
        return
        
    update_id = str(update.message.message_id)
    telegram_id = str(update.message.from_user.id)
    text = update.message.text or ''
    chat_id = update.message.chat_id

    # Skip duplicates
    if db_service.has_processed_update(update_id):
        print(f"Warning: Duplicate update {update_id} — skipping")
        return

    # Log incoming message
    db_service.log_message({
        "updateId": update_id,
        "telegramId": telegram_id,
        "direction": "incoming",
        "content": text[:500],
        "messageType": "text"
    })

    user = db_service.get_user_by_telegram_id(telegram_id)

    # Handle /start command
    if text.startswith('/start'):
        await handle_start(update, context)
        return

    # Handle /help command
    if text.startswith('/help'):
        await handle_help(update, context, user)
        return

    # If they send an invite code directly as text
    potential_code = text.strip().upper()
    import re
    if re.match(r'^(STU|TEA|SCH)-[A-Z0-9]{5,8}$', potential_code):
        await process_invite_code(update, context, potential_code)
        return

    # User not linked yet
    if not user:
        await handle_unlinked_user(update, context)
        return

    # Route by role
    if user['role'] in ['teacher', 'coordinator']:
        await handle_teacher_message(update, context, user)
    elif user['role'] == 'student':
        await handle_student_message(update, context, user)

async def handle_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.message.chat_id
    telegram_id = str(update.message.from_user.id)
    text = update.message.text or ''
    
    parts = text.split(' ')
    invite_code = parts[1] if len(parts) > 1 else None

    existing_user = db_service.get_user_by_telegram_id(telegram_id)

    if existing_user:
        if invite_code:
            await process_invite_code(update, context, invite_code)
        else:
            await send_welcome_back(update, context, existing_user)
        return

    if invite_code:
        await process_invite_code(update, context, invite_code)
    else:
        await update.message.reply_text(
            " Welcome to Classroom Companion!\n\n"
            "To get started, you need an invite code from your teacher or school coordinator.\n\n"
            "Send your invite code now, or ask your teacher for one."
        )
        db_service.save_pending_link(telegram_id, None)

async def send_welcome_back(update: Update, context: ContextTypes.DEFAULT_TYPE, user):
    if user['role'] == 'student':
        msg = "Type /help to see what you can do, or send a message about your assignments."
    else:
        msg = "Type /assignments to see your current assignments or /summary for a status update."
    await update.message.reply_text(f"Welcome back, {user['name']}! \n\n{msg}")

async def process_invite_code(update: Update, context: ContextTypes.DEFAULT_TYPE, code: str):
    chat_id = update.message.chat_id
    telegram_id = str(update.message.from_user.id)
    from_user = update.message.from_user

    validation = db_service.validate_invite_code(code)
    if not validation['valid']:
        await update.message.reply_text(
            f"[Error] {validation['reason']}\n\nPlease check your invite code and try again, or ask your teacher for a new one."
        )
        return

    invite = validation['invite']
    school = db_service.get_school_by_id(invite['school_id'])
    user = db_service.get_user_by_telegram_id(telegram_id)

    if not user:
        name = from_user.first_name + (f" {from_user.last_name}" if from_user.last_name else "")
        if not name.strip():
            name = "Unknown"
        user = db_service.create_user({
            "telegramId": telegram_id,
            "telegramHandle": from_user.username,
            "name": name,
            "role": invite['role'],
            "schoolId": invite['school_id']
        })
    else:
        if user['role'].lower() != invite['role'].lower():
            await update.message.reply_text(
                f"[Error] Role mismatch: You are registered as a {user['role']}, but this invite is for a {invite['role']}."
            )
            return

    if invite['class_id']:
        if invite['role'] == 'teacher':
            db_service.add_teacher_to_class(user['id'], invite['class_id'])
        else:
            db_service.add_student_to_class(user['id'], invite['class_id'])

    db_service.use_invite_code(invite['id'])
    db_service.delete_pending_link(telegram_id)

    cls = db_service.get_class_by_id(invite['class_id']) if invite['class_id'] else None
    
    role_desc = invite['role']
    class_desc = f" in {cls['name']}" if cls else ""
    welcome_msg = (
        f"[OK] Welcome to {school['name']}!\n\n"
        f"You've been added to {cls['name'] if cls else 'the school'}.\n\n"
    )
    if invite['role'] == 'teacher':
        welcome_msg += "You can now create assignments by simply typing them in natural language.\n\nExample: \"Create an essay assignment on the water cycle, due next Friday\"\n\nType /help to see all commands."
    else:
        welcome_msg += "Your teacher will send you assignments here. Stay tuned!\n\nType /help to see what you can do."

    await update.message.reply_text(welcome_msg)

async def handle_unlinked_user(update: Update, context: ContextTypes.DEFAULT_TYPE):
    telegram_id = str(update.message.from_user.id)
    pending = db_service.get_pending_link(telegram_id)
    if not pending:
        db_service.save_pending_link(telegram_id, None)

    await update.message.reply_text(
        " Hello! I'm Classroom Companion.\n\n"
        "It looks like you're not set up yet. Please send your invite code to get started.\n\n"
        "Your teacher or school coordinator should have given you one."
    )

async def handle_help(update: Update, context: ContextTypes.DEFAULT_TYPE, user):
    if not user:
        await update.message.reply_text("Send your invite code to get started!\nExample: STU-ABC123")
        return

    if user['role'] in ['teacher', 'coordinator']:
        await update.message.reply_text(
            "*Teacher Commands*\n\n"
            " Describe an assignment to create it\n"
            " /assignments — list your assignments\n"
            " /summary — get class status summary\n"
            " Ask any question like \"Who is at risk?\"\n\n"
            "_Example: \"Essay on climate change, 500 words, due Friday\"_",
            parse_mode='Markdown'
        )
    else:
        await update.message.reply_text(
            "*Student Commands*\n\n"
            "[OK] \"Got it\" — acknowledge an assignment\n"
            " \"Working on it\" — update your progress\n"
            " \"I'm stuck\" — report a blocker\n"
            " Send text or a file to submit work\n"
            " Ask any question about your assignment\n\n"
            "_Your teacher will be notified of important updates._",
            parse_mode='Markdown'
        )

async def handle_teacher_message(update: Update, context: ContextTypes.DEFAULT_TYPE, teacher):
    chat_id = update.message.chat_id
    text = update.message.text or ''

    classes = db_service.get_teacher_classes(teacher['id'])
    if not classes:
        await update.message.reply_text(
            "You're not assigned to any classes yet. Ask your school coordinator to add you to a class."
        )
        return

    # Call LLM classifier
    intent_data = llm_service.classify_teacher_intent(text, {
        "teacherName": teacher['name'],
        "classes": [{"id": c['id'], "name": c['name']} for c in classes]
    })

    intent = intent_data.get('intent')
    confidence = intent_data.get('confidence', 0.0)

    print(f"Teacher intent: {intent} ({confidence})")

    if intent == 'create_assignment' and confidence > 0.6:
        await handle_create_assignment(update, context, teacher, text, classes)
    elif intent == 'list_assignments':
        await handle_list_assignments(update, context, teacher, classes)
    elif intent == 'ask_question' and confidence > 0.6:
        await handle_teacher_question(update, context, teacher, text, classes)
    elif text.lower().startswith('/assignments'):
        await handle_list_assignments(update, context, teacher, classes)
    elif text.lower().startswith('/summary'):
        await handle_teacher_question(update, context, teacher, 'Give me a summary of all current assignments and who needs attention', classes)
    else:
        await update.message.reply_text(
            "I'm not sure what you'd like to do. Here are some options:\n\n"
            " *Create assignment* — just describe it in natural language\n"
            " /assignments — see all your assignments\n"
            " /summary — get a status summary\n\n"
            "Example: \"Essay on climate change due next Friday for Grade 8\"",
            parse_mode='Markdown'
        )

async def handle_list_assignments(update: Update, context: ContextTypes.DEFAULT_TYPE, teacher, classes):
    response = ' *Your Active Assignments*\n\n'
    has_any = False

    for cls in classes:
        assignments = db_service.get_assignments_by_class(cls['id'])
        if not assignments:
            continue
        has_any = True
        response += f"*{cls['name']}*\n"
        for a in assignments[:5]:
            students = db_service.get_assignment_students(a['id'])
            submitted = len([s for s in students if s['status'] in ['submitted', 'completed']])
            blocked = len([s for s in students if s['status'] == 'blocked'])
            response += f"• {a['title']}\n"
            response += f"   {submitted}/{len(students)} submitted"
            if blocked > 0:
                response += f" | [Warning]️ {blocked} blocked"
            response += '\n'
        response += '\n'

    if not has_any:
        response = 'No active assignments. Type a description to create one!'

    await update.message.reply_text(response, parse_mode='Markdown')

async def handle_teacher_question(update: Update, context: ContextTypes.DEFAULT_TYPE, teacher, question, classes):
    await update.message.reply_text(' Analyzing...')
    context_data = {}
    for cls in classes:
        assignments = db_service.get_assignments_by_class(cls['id'])
        context_data[cls['name']] = []
        for a in assignments:
            students = db_service.get_assignment_students(a['id'])
            context_data[cls['name']].append({
                "title": a['title'],
                "due_at": a['due_at'],
                "students": [{
                    "name": s['student_name'],
                    "status": s['status'],
                    "last_message": s['last_student_message']
                } for s in students]
            })

    answer = llm_service.answer_teacher_question(question, context_data)
    await update.message.reply_text(answer)

async def handle_create_assignment(update: Update, context: ContextTypes.DEFAULT_TYPE, teacher, text, classes):
    await update.message.reply_text(' Processing your assignment...')

    now_str = datetime.utcnow().isoformat() + 'Z'
    parsed = llm_service.parse_assignment(text, now_str, 'Asia/Kolkata')

    if parsed.get('confidence', 1.0) < 0.5:
        await update.message.reply_text(
            "I couldn't extract a clear assignment from that.\n\n"
            "Try something like:\n"
            "\"Essay on the water cycle, 2 pages, due this Friday evening\""
        )
        return

    if len(classes) == 1:
        await create_and_distribute_assignment(update.message.chat_id, teacher, parsed, classes[0], text)
    else:
        # Save in pending assignments to bypass 64-character Telegram callback data limit
        pending_assignments[teacher['id']] = {
            "title": parsed['title'],
            "description": parsed['description'],
            "due_at": parsed['due_at'],
            "raw": text
        }
        keyboard = []
        for cls in classes:
            keyboard.append([InlineKeyboardButton(cls['name'], callback_data=f"assign_to_class:{cls['id']}")])
            
        reply_markup = InlineKeyboardMarkup(keyboard)
        await update.message.reply_text(
            f" Assignment parsed:\n*{parsed['title']}*\n{parsed['description']}\n\nDue: {parsed.get('due_at_display') or 'No deadline'}\n\nWhich class is this for?",
            parse_mode='Markdown',
            reply_markup=reply_markup
        )

async def create_and_distribute_assignment(chat_id, teacher, parsed, cls, raw_text):
    if not db_service.is_teacher_in_class(teacher['id'], cls['id']):
        await send_telegram_message(chat_id, '[Error] You are not authorized to assign work in this class.')
        return

    assignment = db_service.create_assignment({
        "schoolId": teacher['school_id'],
        "classId": cls['id'],
        "teacherId": teacher['id'],
        "title": parsed['title'],
        "description": parsed['description'],
        "rawInput": raw_text,
        "dueAt": parsed['due_at'],
        "targetType": parsed.get('target_type', 'class')
    })

    students = db_service.get_students_by_class(cls['id'])
    notified_count = 0

    for student in students:
        db_service.create_student_assignment(assignment['id'], student['id'])
        if student['telegram_id']:
            due_display = parsed.get('due_at_display') or 'Check with your teacher'
            student_msg = (
                f"[Assignment] *New Assignment from {teacher['name']}*\n\n"
                f"*{assignment['title']}*\n{assignment['description']}\n\n"
                f"Due: Due: {due_display}\n"
                f" Class: {cls['name']}\n\n"
                f"Reply to let me know:\n"
                f"[OK] \"Got it\" to acknowledge\n"
                f" \"Working on it\" to update progress\n"
                f" \"I'm stuck\" if you need help\n"
                f" Send your work when you're ready to submit"
            )
            sent = await send_telegram_message(student['telegram_id'], student_msg, {"parse_mode": "Markdown"})
            if sent:
                notified_count += 1

    unlinked_count = len(students) - notified_count
    await send_telegram_message(
        chat_id,
        f"[OK] Assignment created and distributed!\n\n"
        f"*{assignment['title']}*\n"
        f" Notified: {notified_count}/{len(students)} students\n"
        + (f"[Warning]️ {unlinked_count} student(s) haven't linked Telegram yet\n" if unlinked_count > 0 else "") +
        f"\nView full details at your Teacher Dashboard.",
        {"parse_mode": "Markdown"}
    )

async def handle_callback_query(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    chat_id = query.message.chat.id
    telegram_id = str(query.from_user.id)
    data = query.data

    user = db_service.get_user_by_telegram_id(telegram_id)
    if not user:
        return

    if data.startswith('assign_to_class:'):
        class_id = data.split(':')[1]
        parsed_data = pending_assignments.get(user['id'])
        if not parsed_data:
            await query.message.reply_text('[Error] Could not find the pending assignment. Please try creating it again.')
            return

        cls = db_service.get_class_by_id(class_id)
        if not cls or not db_service.is_teacher_in_class(user['id'], class_id):
            await query.message.reply_text('[Error] Unauthorized action.')
            return

        pending_assignments.pop(user['id'], None)  # Clean up memory
        await create_and_distribute_assignment(chat_id, user, parsed_data, cls, parsed_data['raw'])

async def handle_student_message(update: Update, context: ContextTypes.DEFAULT_TYPE, student):
    chat_id = update.message.chat_id
    text = update.message.text or ''

    assignments = db_service.get_student_assignments_by_student(student['id'])
    active = [a for a in assignments if a['status'] not in ['completed', 'cancelled']]

    if not active:
        await update.message.reply_text(
            "You have no active assignments right now. Check back when your teacher sends something! [Assignment]"
        )
        return

    # Use the most recent assignment for target
    target_sa = active[0]

    interpretation = llm_service.interpret_student_message(text, target_sa['status'], target_sa['title'])
    intent = interpretation.get('intent')
    new_status = interpretation.get('new_status', 'same')
    confidence = interpretation.get('confidence', 0.0)

    print(f"Student interpretation: {intent} -> {new_status} ({confidence})")

    status_changed = False
    if new_status != 'same' and confidence > 0.6:
        try:
            db_service.update_student_assignment_status(target_sa['id'], new_status, {
                "lastStudentMessage": interpretation.get('summary')
            })
            status_changed = True
        except Exception as e:
            print(f"Warning: Status transition rejected: {e}")
    else:
        db_service.update_student_assignment_status(target_sa['id'], target_sa['status'], {
            "lastStudentMessage": interpretation.get('summary')
        })

    if interpretation.get('needs_teacher_attention'):
        await notify_teacher_of_student_update(target_sa, student, interpretation)

    await respond_to_student(update, target_sa, interpretation, status_changed)

async def respond_to_student(update: Update, sa, interpretation, status_changed):
    responses = {
        "acknowledgement": f"[OK] Got it! I've noted that you've acknowledged \"{sa['title']}\". Good luck!",
        "progress_update": f" Thanks for the update on \"{sa['title']}\"! Keep it up.",
        "blocked_report": f" I've let your teacher know you're blocked on \"{sa['title']}\". They'll get back to you soon. Hang tight!",
        "submission": f" Thanks! I've recorded your submission for \"{sa['title']}\". Your teacher will review it.",
        "help_request": f"[Feedback] Your teacher has been notified that you need help with \"{sa['title']}\". They'll respond soon.",
        "unclear": f"I received your message about \"{sa['title']}\". If you want to update your progress, try:\n• \"Got it\" to acknowledge\n• \"Working on it\" for progress\n• \"I'm stuck\" if blocked\n• Send your work to submit"
    }
    response = responses.get(interpretation.get('intent'), responses['unclear'])
    await update.message.reply_text(response)

async def notify_teacher_of_student_update(sa, student, interpretation):
    assignment = db_service.get_assignment_by_id(sa['assignment_id'])
    if not assignment:
        return
    teacher = db_service.get_user_by_id(assignment['teacher_id'])
    if not teacher or not teacher['telegram_id']:
        return

    urgency = '' if interpretation.get('intent') == 'blocked_report' else ''
    msg = (
        f"{urgency} *Update from {student['name']}*\n\n"
        f"Assignment: {sa['title']}\n"
        f"Status: {interpretation.get('new_status') if interpretation.get('new_status') != 'same' else sa['status']}\n"
        f"Message: \"{interpretation.get('summary')}\"\n\n"
        f"View full details in your Teacher Dashboard."
    )
    await send_telegram_message(teacher['telegram_id'], msg, {"parse_mode": "Markdown"})

async def handle_file(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message:
        return
        
    telegram_id = str(update.message.from_user.id)
    chat_id = update.message.chat_id
    update_id = str(update.message.message_id)
    caption = update.message.caption or ''

    if db_service.has_processed_update(update_id):
        return

    user = db_service.get_user_by_telegram_id(telegram_id)
    if not user or user['role'] != 'student':
        await update.message.reply_text('File submissions are for students only.')
        return

    assignments = db_service.get_student_assignments_by_student(user['id'])
    active = [a for a in assignments if a['status'] not in ['completed', 'cancelled']]

    if not active:
        await update.message.reply_text('You have no active assignments to submit to.')
        return

    target_sa = active[0]

    # File resolution
    file_id = ""
    file_name = ""
    if update.message.photo:
        file_id = update.message.photo[-1].file_id
        file_name = f"photo_{int(datetime.utcnow().timestamp())}.jpg"
        file_type = "photo"
    elif update.message.document:
        file_id = update.message.document.file_id
        file_name = update.message.document.file_name or f"document_{int(datetime.utcnow().timestamp())}"
        file_type = "document"
    else:
        return

    db_service.update_student_assignment_status(target_sa['id'], 'submitted', {
        "submissionText": caption or 'File submission',
        "submissionFilePath": file_id,
        "submissionFileName": file_name,
        "lastStudentMessage": f"Submitted {file_type}: {file_name}"
    })

    db_service.log_message({
        "updateId": update_id,
        "telegramId": telegram_id,
        "userId": user['id'],
        "direction": "incoming",
        "content": f"[{file_type.upper()}] {file_name} - {caption}",
        "messageType": file_type
    })

    await update.message.reply_text(
        f" *Submission received!*\n\n"
        f"Assignment: {target_sa['title']}\n"
        f"File: {file_name}\n\n"
        f"Your teacher will review it and send feedback soon.",
        parse_mode='Markdown'
    )

    await notify_teacher_of_student_update(target_sa, user, {
        "intent": "submission",
        "new_status": "submitted",
        "summary": f"Submitted {file_type}: {file_name}",
        "needs_teacher_attention": True
    })

async def init_bot():
    global bot_app
    token = os.environ.get('TELEGRAM_BOT_TOKEN')
    if not token:
        print('Warning: TELEGRAM_BOT_TOKEN not set — bot disabled')
        return None

    bot_app = Application.builder().token(token).build()
    
    bot_app.add_handler(CommandHandler("start", handle_start))
    bot_app.add_handler(CallbackQueryHandler(handle_callback_query))
    bot_app.add_handler(MessageHandler(filters.PHOTO, handle_file))
    bot_app.add_handler(MessageHandler(filters.Document.ALL, handle_file))
    bot_app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    # Initialize the app asynchronously
    await bot_app.initialize()
    await bot_app.start()
    await bot_app.updater.start_polling()
    print('Telegram bot initialized and polling')
    return bot_app
