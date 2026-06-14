// =============================================================
// bot.js — WHY: The Telegram bot is the PRIMARY interface.
// Every teacher/student interaction flows through here.
// WHY node-telegram-bot-api: battle-tested, supports both
// polling (local dev) and webhooks (production), handles
// file downloads, and has good TypeScript types.
// =============================================================

const TelegramBot = require('node-telegram-bot-api');
const db = require('../services/db-service');
const llm = require('../llm/llm');

let bot = null;
const pendingAssignments = new Map();

function getBot() {
  return bot;
}

function initBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN not set — bot disabled');
    return null;
  }

  // WHY polling for dev, webhook for prod:
  // Polling works without exposing a public URL (good for local dev)
  // Webhooks are more efficient in production (Telegram pushes updates)
  const useWebhook = process.env.NODE_ENV === 'production' && process.env.WEBHOOK_URL;
  
  bot = new TelegramBot(token, { polling: !useWebhook });
  
  if (useWebhook) {
    bot.setWebHook(`${process.env.WEBHOOK_URL}/webhook/${token}`);
    console.log('🔗 Bot running via webhook');
  } else {
    console.log('🤖 Bot running via polling');
  }

  // ─────────────────────────────────────────────
  // MESSAGE ROUTER — every incoming message comes here
  // ─────────────────────────────────────────────
  bot.on('message', async (msg) => {
    try {
      await handleMessage(msg);
    } catch (err) {
      console.error('❌ Bot message handler error:', err);
      // WHY catch-all: if a single message crashes, the bot keeps running
      try {
        await bot.sendMessage(msg.chat.id, 
          "Something went wrong processing your message. Please try again.");
      } catch (sendErr) {
        console.error('❌ Could not send error message:', sendErr.message);
      }
    }
  });

  bot.on('callback_query', async (query) => {
    try {
      await handleCallbackQuery(query);
    } catch (err) {
      console.error('❌ Callback query error:', err);
    }
  });

  // Handle photo/document submissions
  bot.on('photo', async (msg) => {
    try {
      await handleFileMessage(msg, 'photo');
    } catch (err) {
      console.error('❌ Photo handler error:', err);
    }
  });

  bot.on('document', async (msg) => {
    try {
      await handleFileMessage(msg, 'document');
    } catch (err) {
      console.error('❌ Document handler error:', err);
    }
  });

  console.log('✅ Telegram bot initialized');
  return bot;
}

// =============================================================
// IDEMPOTENCY CHECK — runs before processing any message
// WHY: Telegram can retry webhook deliveries. Processing the
// same update twice would send duplicate assignments/messages.
// =============================================================
async function handleMessage(msg) {
  const updateId = msg.message_id?.toString();
  const telegramId = msg.from?.id?.toString();
  const text = msg.text || '';
  const chatId = msg.chat.id;

  // Skip duplicate updates (Telegram retries)
  if (updateId && db.hasProcessedUpdate(updateId)) {
    console.log(`⚠️ Duplicate update ${updateId} — skipping`);
    return;
  }

  // Log incoming message for audit trail
  db.logMessage({
    updateId,
    telegramId,
    direction: 'incoming',
    content: text.substring(0, 500),
    messageType: 'text'
  });

  // ─── Look up user ──────────────────────────────
  const user = db.getUserByTelegramId(telegramId);

  // ─── Handle /start and invite codes ──────────────
  if (text.startsWith('/start')) {
    await handleStart(chatId, telegramId, text, msg.from);
    return;
  }

  if (text.startsWith('/help')) {
    await handleHelp(chatId, user);
    return;
  }

  // If they send an invite code directly as text (even if already registered)
  const potentialCode = text.trim().toUpperCase();
  if (potentialCode.match(/^(STU|TEA|SCH)-[A-Z0-9]{5,8}$/)) {
    await processInviteCode(chatId, telegramId, potentialCode, msg.from);
    return;
  }

  // ─── User not linked yet ───────────────────────
  if (!user) {
    await handleUnlinkedUser(chatId, telegramId, text, msg.from);
    return;
  }

  // ─── Route by role ─────────────────────────────
  if (user.role === 'teacher' || user.role === 'coordinator') {
    await handleTeacherMessage(chatId, user, text, msg);
  } else if (user.role === 'student') {
    await handleStudentMessage(chatId, user, text, msg);
  }
}

// =============================================================
// /start COMMAND HANDLER
// Handles: /start, /start INVITE_CODE
// =============================================================
async function handleStart(chatId, telegramId, text, from) {
  // Extract invite code from /start INVITE_CODE (Telegram deep linking)
  const parts = text.split(' ');
  const inviteCode = parts[1] || null;

  const existingUser = db.getUserByTelegramId(telegramId);

  if (existingUser) {
    if (inviteCode) {
      await processInviteCode(chatId, telegramId, inviteCode, from);
    } else {
      await sendWelcomeBack(chatId, existingUser);
    }
    return;
  }

  if (inviteCode) {
    await processInviteCode(chatId, telegramId, inviteCode, from);
  } else {
    await bot.sendMessage(chatId, 
      `👋 Welcome to Classroom Companion!\n\n` +
      `To get started, you need an invite code from your teacher or school coordinator.\n\n` +
      `Send your invite code now, or ask your teacher for one.`
    );
    // Save that this user is waiting — if they send a code next, we process it
    db.savePendingLink(telegramId, null);
  }
}

// =============================================================
// INVITE CODE PROCESSING
// WHY: This is the onboarding flow. An invite code ties a
// Telegram account to a pre-created user record in the DB.
// =============================================================
async function processInviteCode(chatId, telegramId, code, from) {
  const validation = db.validateInviteCode(code.toUpperCase());
  
  if (!validation.valid) {
    await bot.sendMessage(chatId, 
      `❌ ${validation.reason}\n\nPlease check your invite code and try again, or ask your teacher for a new one.`
    );
    return;
  }

  const invite = validation.invite;
  const school = db.getSchoolById(invite.school_id);

  let user = db.getUserByTelegramId(telegramId);
  if (!user) {
    // Create a new user record and link it to this Telegram account
    user = db.createUser({
      telegramId: telegramId,
      telegramHandle: from?.username || null,
      name: from?.first_name + (from?.last_name ? ' ' + from.last_name : '') || 'Unknown',
      role: invite.role,
      schoolId: invite.school_id
    });
  } else {
    // Check role compatibility
    if (user.role.toLowerCase() !== invite.role.toLowerCase()) {
      await bot.sendMessage(chatId, 
        `❌ Role mismatch: You are registered as a ${user.role}, but this invite is for a ${invite.role}.`
      );
      return;
    }
  }

  // If the invite is for a specific class, add them to it
  if (invite.class_id) {
    if (invite.role === 'teacher') {
      db.addTeacherToClass(user.id, invite.class_id);
    } else {
      db.addStudentToClass(user.id, invite.class_id);
    }
  }

  db.useInviteCode(invite.id);
  db.deletePendingLink(telegramId);

  const cls = invite.class_id ? db.getClassById(invite.class_id) : null;
  
  await bot.sendMessage(chatId,
    `✅ Welcome to ${school.name}!\n\n` +
    `You've been added to ${cls ? cls.name : 'the school'}.\n\n` +
    (invite.role === 'teacher' 
      ? `You can now create assignments by simply typing them in natural language.\n\nExample: "Create an essay assignment on the water cycle, due next Friday"\n\nType /help to see all commands.`
      : `Your teacher will send you assignments here. Stay tuned!\n\nType /help to see what you can do.`)
  );
}

// =============================================================
// UNLINKED USER HANDLER
// WHY: Someone messages the bot without going through /start.
// Could be an invite code pasted directly as a message.
// =============================================================
async function handleUnlinkedUser(chatId, telegramId, text, from) {
  // Check if they're sending an invite code
  const potentialCode = text.trim().toUpperCase();
  if (potentialCode.match(/^(STU|TEA|SCH)-[A-Z0-9]{5,8}$/)) {
    await processInviteCode(chatId, telegramId, potentialCode, from);
    return;
  }

  // Save their message in case they send a code next
  const pending = db.getPendingLink(telegramId);
  if (!pending) {
    db.savePendingLink(telegramId, null);
  }

  await bot.sendMessage(chatId,
    `👋 Hello! I'm Classroom Companion.\n\n` +
    `It looks like you're not set up yet. Please send your invite code to get started.\n\n` +
    `Your teacher or school coordinator should have given you one.`
  );
}

// =============================================================
// TEACHER MESSAGE HANDLER
// WHY: Teachers interact primarily through natural language.
// We classify their intent with the LLM, then take action.
// =============================================================
async function handleTeacherMessage(chatId, teacher, text, msg) {
  // Get teacher's classes for context
  const classes = db.getTeacherClasses(teacher.id);
  
  if (classes.length === 0) {
    await bot.sendMessage(chatId,
      `You're not assigned to any classes yet. ` +
      `Ask your school coordinator to add you to a class.`
    );
    return;
  }

  // WHY classify first: lets the LLM decide what the teacher wants
  // before we run expensive queries or take irreversible actions
  const intent = await llm.classifyTeacherIntent(text, {
    teacherName: teacher.name,
    classes: classes.map(c => ({ id: c.id, name: c.name }))
  });

  console.log(`📍 Teacher intent: ${intent.intent} (${intent.confidence})`);

  if (intent.intent === 'create_assignment' && intent.confidence > 0.6) {
    await handleCreateAssignment(chatId, teacher, text, classes);
  } else if (intent.intent === 'list_assignments') {
    await handleListAssignments(chatId, teacher, classes);
  } else if (intent.intent === 'ask_question' && intent.confidence > 0.6) {
    await handleTeacherQuestion(chatId, teacher, text, classes);
  } else if (text.toLowerCase().startsWith('/assignments')) {
    await handleListAssignments(chatId, teacher, classes);
  } else if (text.toLowerCase().startsWith('/summary')) {
    await handleTeacherQuestion(chatId, teacher, 'Give me a summary of all current assignments and who needs attention', classes);
  } else {
    // WHY graceful fallback: if we can't classify, show options
    await bot.sendMessage(chatId,
      `I'm not sure what you'd like to do. Here are some options:\n\n` +
      `📝 *Create assignment* — just describe it in natural language\n` +
      `📋 /assignments — see all your assignments\n` +
      `📊 /summary — get a status summary\n\n` +
      `Example: "Essay on climate change due next Friday for Grade 8"`,
      { parse_mode: 'Markdown' }
    );
  }
}

// =============================================================
// CREATE ASSIGNMENT FLOW
// =============================================================
async function handleCreateAssignment(chatId, teacher, text, classes) {
  await bot.sendMessage(chatId, '⏳ Processing your assignment...');

  const now = new Date().toISOString();
  const parsed = await llm.parseAssignment(text, now, 'Asia/Kolkata');

  if (parsed.confidence < 0.5) {
    await bot.sendMessage(chatId,
      `I couldn't extract a clear assignment from that.\n\n` +
      `Try something like:\n` +
      `"Essay on the water cycle, 2 pages, due this Friday evening"`
    );
    return;
  }

  // If teacher has only one class, use it automatically
  // If multiple classes, ask them to pick
  if (classes.length === 1) {
    await createAndDistributeAssignment(chatId, teacher, parsed, classes[0], text);
  } else {
    // Store parsed data temporarily in memory to bypass 64-character Telegram callback limit
    pendingAssignments.set(teacher.id, {
      title: parsed.title,
      description: parsed.description,
      due_at: parsed.due_at,
      raw: text
    });

    const keyboard = {
      inline_keyboard: classes.map(cls => ([{
        text: cls.name,
        callback_data: `assign_to_class:${cls.id}`
      }]))
    };

    await bot.sendMessage(chatId,
      `📝 Assignment parsed:\n*${parsed.title}*\n${parsed.description}\n\nDue: ${parsed.due_at_display || 'No deadline'}\n\nWhich class is this for?`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  }
}

async function createAndDistributeAssignment(chatId, teacher, parsed, cls, rawText) {
  // Verify teacher is authorized for this class
  if (!db.isTeacherInClass(teacher.id, cls.id)) {
    await bot.sendMessage(chatId, '❌ You are not authorized to assign work in this class.');
    return;
  }

  const assignment = db.createAssignment({
    schoolId: teacher.school_id,
    classId: cls.id,
    teacherId: teacher.id,
    title: parsed.title,
    description: parsed.description,
    rawInput: rawText,
    dueAt: parsed.due_at,
    targetType: parsed.target_type || 'class'
  });

  // Get all students in the class and create per-student records
  const students = db.getStudentsByClass(cls.id);
  let notifiedCount = 0;

  for (const student of students) {
    db.createStudentAssignment(assignment.id, student.id);

    // Send to students who have linked their Telegram
    if (student.telegram_id) {
      try {
        await bot.sendMessage(student.telegram_id,
          `📚 *New Assignment from ${teacher.name}*\n\n` +
          `*${assignment.title}*\n${assignment.description}\n\n` +
          `📅 Due: ${parsed.due_at_display || 'Check with your teacher'}\n` +
          `🏫 Class: ${cls.name}\n\n` +
          `Reply to let me know:\n` +
          `✅ "Got it" to acknowledge\n` +
          `📝 "Working on it" to update progress\n` +
          `🚧 "I'm stuck" if you need help\n` +
          `📤 Send your work when you're ready to submit`,
          { parse_mode: 'Markdown' }
        );
        notifiedCount++;
      } catch (err) {
        console.error(`❌ Could not notify student ${student.id}:`, err.message);
      }
    }
  }

  const unlinkedCount = students.length - notifiedCount;
  
  await bot.sendMessage(chatId,
    `✅ Assignment created and distributed!\n\n` +
    `*${assignment.title}*\n` +
    `📤 Notified: ${notifiedCount}/${students.length} students\n` +
    (unlinkedCount > 0 ? `⚠️ ${unlinkedCount} student(s) haven't linked Telegram yet\n` : '') +
    `\nView full details at your Teacher Dashboard.`,
    { parse_mode: 'Markdown' }
  );

  console.log(`✅ Assignment ${assignment.id} created, ${notifiedCount} students notified`);
}

// =============================================================
// LIST ASSIGNMENTS FOR TEACHER
// =============================================================
async function handleListAssignments(chatId, teacher, classes) {
  let response = '📋 *Your Active Assignments*\n\n';
  let hasAny = false;

  for (const cls of classes) {
    const assignments = db.getAssignmentsByClass(cls.id);
    if (assignments.length === 0) continue;
    
    hasAny = true;
    response += `*${cls.name}*\n`;
    
    for (const a of assignments.slice(0, 5)) {
      const students = db.getAssignmentStudents(a.id);
      const submitted = students.filter(s => ['submitted','completed'].includes(s.status)).length;
      const blocked = students.filter(s => s.status === 'blocked').length;
      
      response += `• ${a.title}\n`;
      response += `  📊 ${submitted}/${students.length} submitted`;
      if (blocked > 0) response += ` | ⚠️ ${blocked} blocked`;
      response += '\n';
    }
    response += '\n';
  }

  if (!hasAny) {
    response = 'No active assignments. Type a description to create one!';
  }

  await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
}

// =============================================================
// TEACHER QUESTION ANSWERING ("Who is at risk?")
// =============================================================
async function handleTeacherQuestion(chatId, teacher, question, classes) {
  await bot.sendMessage(chatId, '🔍 Analyzing...');

  // Gather all relevant data for the LLM to reason over
  const contextData = {};
  for (const cls of classes) {
    const assignments = db.getAssignmentsByClass(cls.id);
    contextData[cls.name] = assignments.map(a => ({
      title: a.title,
      due_at: a.due_at,
      students: db.getAssignmentStudents(a.id).map(s => ({
        name: s.student_name,
        status: s.status,
        last_message: s.last_student_message
      }))
    }));
  }

  const answer = await llm.answerTeacherQuestion(question, contextData);
  await bot.sendMessage(chatId, answer);
}

// =============================================================
// STUDENT MESSAGE HANDLER
// WHY: Students send casual messages — we use LLM to understand
// what they mean and update their assignment status accordingly.
// =============================================================
async function handleStudentMessage(chatId, student, text, msg) {
  // Get student's active assignments
  const studentAssignments = db.getStudentAssignmentsByStudent(student.id)
    .filter(sa => !['completed', 'cancelled'].includes(sa.status));

  if (studentAssignments.length === 0) {
    await bot.sendMessage(chatId,
      `You have no active assignments right now. Check back when your teacher sends something! 📚`
    );
    return;
  }

  // If only one active assignment, it's clearly about that one
  // If multiple, the LLM might figure it out from context, or we ask
  let targetSA = studentAssignments[0];
  
  if (studentAssignments.length > 1) {
    // Try to figure out which assignment from context
    // For simplicity, use the most recent one — a production system
    // would do smarter disambiguation
    targetSA = studentAssignments[0];
  }

  // Ask LLM to interpret the student's message
  const interpretation = await llm.interpretStudentMessage(
    text,
    targetSA.status,
    targetSA.title
  );

  console.log(`📍 Student interpretation: ${interpretation.intent} → ${interpretation.new_status} (${interpretation.confidence})`);

  // Apply status transition if LLM is confident
  let statusChanged = false;
  if (interpretation.new_status !== 'same' && interpretation.confidence > 0.6) {
    try {
      db.updateStudentAssignmentStatus(targetSA.id, interpretation.new_status, {
        lastStudentMessage: interpretation.summary
      });
      statusChanged = true;
    } catch (err) {
      console.warn('⚠️ Status transition rejected:', err.message);
    }
  } else {
    // Even if no status change, record what they said
    db.updateStudentAssignmentStatus(targetSA.id, targetSA.status, {
      lastStudentMessage: interpretation.summary
    });
  }

  // Notify teacher if student needs immediate attention
  if (interpretation.needs_teacher_attention) {
    await notifyTeacherOfStudentUpdate(targetSA, student, interpretation, text);
  }

  // Respond to student
  await respondToStudent(chatId, student, targetSA, interpretation, statusChanged);
}

async function respondToStudent(chatId, student, sa, interpretation, statusChanged) {
  const responses = {
    acknowledgement: `✅ Got it! I've noted that you've acknowledged "${sa.title}". Good luck!`,
    progress_update: `📝 Thanks for the update on "${sa.title}"! Keep it up.`,
    blocked_report: `🚧 I've let your teacher know you're blocked on "${sa.title}". They'll get back to you soon. Hang tight!`,
    submission: `📤 Thanks! I've recorded your submission for "${sa.title}". Your teacher will review it.`,
    help_request: `💬 Your teacher has been notified that you need help with "${sa.title}". They'll respond soon.`,
    unclear: `I received your message about "${sa.title}". If you want to update your progress, try:\n• "Got it" to acknowledge\n• "Working on it" for progress\n• "I'm stuck" if blocked\n• Send your work to submit`
  };

  const response = responses[interpretation.intent] || responses.unclear;
  await bot.sendMessage(chatId, response);
}

async function notifyTeacherOfStudentUpdate(sa, student, interpretation, originalMessage) {
  // Find the teacher for this assignment
  const assignment = db.getAssignmentById(sa.assignment_id);
  if (!assignment) return;
  
  const teacher = db.getUserById(assignment.teacher_id);
  if (!teacher || !teacher.telegram_id) return;

  const urgencyEmoji = interpretation.intent === 'blocked_report' ? '🚨' : '📬';
  
  try {
    await bot.sendMessage(teacher.telegram_id,
      `${urgencyEmoji} *Update from ${student.name}*\n\n` +
      `Assignment: ${sa.title}\n` +
      `Status: ${interpretation.new_status !== 'same' ? interpretation.new_status : sa.status}\n` +
      `Message: "${interpretation.summary}"\n\n` +
      `View full details in your Teacher Dashboard.`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('❌ Could not notify teacher:', err.message);
  }
}

// =============================================================
// FILE/PHOTO SUBMISSION HANDLER
// =============================================================
async function handleFileMessage(msg, type) {
  const telegramId = msg.from?.id?.toString();
  const chatId = msg.chat.id;
  const updateId = msg.message_id?.toString();
  const caption = msg.caption || '';

  if (db.hasProcessedUpdate(updateId)) return;

  const user = db.getUserByTelegramId(telegramId);
  if (!user || user.role !== 'student') {
    await bot.sendMessage(chatId, 'File submissions are for students only.');
    return;
  }

  const studentAssignments = db.getStudentAssignmentsByStudent(user.id)
    .filter(sa => !['completed', 'cancelled'].includes(sa.status));

  if (studentAssignments.length === 0) {
    await bot.sendMessage(chatId, 'You have no active assignments to submit to.');
    return;
  }

  const targetSA = studentAssignments[0];

  // Get file info for logging
  let fileId, fileName;
  if (type === 'photo') {
    const photos = msg.photo;
    fileId = photos[photos.length - 1].file_id; // Largest size
    fileName = `photo_${Date.now()}.jpg`;
  } else {
    fileId = msg.document.file_id;
    fileName = msg.document.file_name || `document_${Date.now()}`;
  }

  db.updateStudentAssignmentStatus(targetSA.id, 'submitted', {
    submissionText: caption || 'File submission',
    submissionFilePath: fileId, // Store Telegram file_id for retrieval
    submissionFileName: fileName,
    lastStudentMessage: `Submitted ${type}: ${fileName}`
  });

  db.logMessage({
    updateId,
    telegramId,
    userId: user.id,
    direction: 'incoming',
    content: `[${type.toUpperCase()}] ${fileName} - ${caption}`,
    messageType: type
  });

  await bot.sendMessage(chatId,
    `📤 *Submission received!*\n\n` +
    `Assignment: ${targetSA.title}\n` +
    `File: ${fileName}\n\n` +
    `Your teacher will review it and send feedback soon.`,
    { parse_mode: 'Markdown' }
  );

  // Notify teacher
  await notifyTeacherOfStudentUpdate(
    targetSA, user, 
    { intent: 'submission', new_status: 'submitted', summary: `Submitted ${type}: ${fileName}`, needs_teacher_attention: true },
    caption
  );
}

// =============================================================
// CALLBACK QUERY HANDLER (inline keyboard buttons)
// =============================================================
async function handleCallbackQuery(query) {
  const chatId = query.message.chat.id;
  const telegramId = query.from?.id?.toString();
  const data = query.data;

  await bot.answerCallbackQuery(query.id); // Acknowledge the button tap

  const user = db.getUserByTelegramId(telegramId);
  if (!user) return;

  if (data.startsWith('assign_to_class:')) {
    const parts = data.split(':');
    const classId = parts[1];
    
    const parsedData = pendingAssignments.get(user.id);
    if (!parsedData) {
      await bot.sendMessage(chatId, '❌ Could not find the pending assignment. Please try creating it again.');
      return;
    }

    const cls = db.getClassById(classId);
    if (!cls || !db.isTeacherInClass(user.id, classId)) {
      await bot.sendMessage(chatId, '❌ Unauthorized action.');
      return;
    }

    pendingAssignments.delete(user.id); // Clean up memory
    await createAndDistributeAssignment(chatId, user, parsedData, cls, parsedData.raw);
  }
}

async function handleHelp(chatId, user) {
  if (!user) {
    await bot.sendMessage(chatId, 
      `Send your invite code to get started!\nExample: STU-ABC123`
    );
    return;
  }

  if (user.role === 'teacher' || user.role === 'coordinator') {
    await bot.sendMessage(chatId,
      `*Teacher Commands*\n\n` +
      `📝 Describe an assignment to create it\n` +
      `📋 /assignments — list your assignments\n` +
      `📊 /summary — get class status summary\n` +
      `❓ Ask any question like "Who is at risk?"\n\n` +
      `_Example: "Essay on climate change, 500 words, due Friday"_`,
      { parse_mode: 'Markdown' }
    );
  } else {
    await bot.sendMessage(chatId,
      `*Student Commands*\n\n` +
      `✅ "Got it" — acknowledge an assignment\n` +
      `📝 "Working on it" — update your progress\n` +
      `🚧 "I'm stuck" — report a blocker\n` +
      `📤 Send text or a file to submit work\n` +
      `❓ Ask any question about your assignment\n\n` +
      `_Your teacher will be notified of important updates._`,
      { parse_mode: 'Markdown' }
    );
  }
}

async function sendWelcomeBack(chatId, user) {
  await bot.sendMessage(chatId,
    `Welcome back, ${user.name}! 👋\n\n` +
    (user.role === 'student' 
      ? `Type /help to see what you can do, or send a message about your assignments.`
      : `Type /assignments to see your current assignments or /summary for a status update.`)
  );
}

// WHY exported sendMessage: the reminder scheduler needs to send
// Telegram messages but shouldn't import the full bot module
async function sendTelegramMessage(telegramId, message, options = {}) {
  if (!bot) {
    console.warn('⚠️ Bot not initialized, cannot send message');
    return false;
  }
  try {
    await bot.sendMessage(telegramId, message, options);
    db.logMessage({
      telegramId: String(telegramId),
      direction: 'outgoing',
      content: message.substring(0, 500),
      messageType: 'text'
    });
    return true;
  } catch (err) {
    console.error(`❌ Failed to send Telegram message to ${telegramId}:`, err.message);
    return false;
  }
}

module.exports = { initBot, getBot, sendTelegramMessage };
