// =============================================================
// scheduler.js — WHY: Reminders can't rely on someone typing
// a command — they need to run automatically in the background.
// WHY node-cron: runs on a schedule (like Unix cron), survives
// server restarts by re-registering on startup, and is simple
// enough to reason about and test.
//
// REMINDER POLICY (documented as required):
// 1. Due in 24h: ONE reminder if student hasn't submitted
// 2. Overdue:    ONE reminder per day for up to 3 days
// 3. Blocked:    Check in after 12 hours of silence
// 4. Silent:     Check in after 48 hours with no updates
// 5. NEVER spam: max 1 reminder per type per 24h period
// =============================================================

const cron = require('node-cron');
const db = require('../services/db-service');
const llm = require('../llm/llm');
const { sendTelegramMessage } = require('../services/bot');
const { differenceInHours, differenceInDays, isPast, parseISO } = require('date-fns');

let schedulerRunning = false;

function startScheduler() {
  // WHY run every 30 minutes: fine-grained enough for "due in 24h"
  // without being too frequent. Overdue checks need daily precision.
  cron.schedule('*/30 * * * *', async () => {
    console.log('⏰ Reminder scheduler tick');
    await runReminderCycle();
  });

  // Also mark assignments as overdue every hour
  cron.schedule('0 * * * *', async () => {
    await markOverdueAssignments();
  });

  console.log('✅ Reminder scheduler started (every 30 minutes)');
}

// =============================================================
// MANUAL TRIGGER — for demo/testing without waiting 30 min
// WHY: The assignment spec says we must be able to trigger
// reminder processing manually during demo.
// =============================================================
async function runReminderCycle() {
  if (schedulerRunning) {
    console.log('⚠️ Reminder cycle already running, skipping');
    return { skipped: true };
  }

  schedulerRunning = true;
  const results = { sent: 0, skipped: 0, errors: 0 };

  try {
    const activeSAs = db.getAssignmentsDueForReminder();
    console.log(`📊 Checking ${activeSAs.length} active student assignments`);

    for (const sa of activeSAs) {
      try {
        const result = await processStudentAssignment(sa);
        if (result === 'sent') results.sent++;
        else if (result === 'skipped') results.skipped++;
      } catch (err) {
        console.error(`❌ Reminder error for SA ${sa.id}:`, err.message);
        results.errors++;
      }
    }

    console.log(`📬 Reminder cycle: ${results.sent} sent, ${results.skipped} skipped, ${results.errors} errors`);
  } finally {
    schedulerRunning = false;
  }

  return results;
}

// =============================================================
// PER-STUDENT-ASSIGNMENT LOGIC
// This is where the reminder POLICY is implemented.
// =============================================================
async function processStudentAssignment(sa) {
  const now = new Date();

  // Parse due date
  let dueDate = null;
  let hoursUntilDue = null;
  let daysTillDue = null;
  let isOverdue = false;

  if (sa.due_at) {
    dueDate = parseISO(sa.due_at);
    hoursUntilDue = (dueDate - now) / (1000 * 60 * 60);
    daysTillDue = Math.ceil(hoursUntilDue / 24);
    isOverdue = hoursUntilDue < 0;
  }

  // Determine what kind of reminder to send (if any)
  let reminderType = null;

  if (sa.status === 'blocked') {
    // Blocked students: check in after 12 hours
    const recentBlockedReminders = db.getRecentReminders(sa.id, 12);
    const hasRecentBlockedReminder = recentBlockedReminders
      .some(r => r.reminder_type === 'blocked_checkin');
    
    if (!hasRecentBlockedReminder) {
      reminderType = 'blocked_checkin';
    }
  } else if (isOverdue && sa.status !== 'submitted') {
    // Overdue: once per day, max 3 days
    const overdueReminders = db.getRecentReminders(sa.id, 24);
    const hasRecentOverdueReminder = overdueReminders
      .some(r => r.reminder_type === 'overdue');
    
    // Count total overdue reminders to stop after 3
    const allReminders = db.getRecentReminders(sa.id, 72);
    const totalOverdueReminders = allReminders
      .filter(r => r.reminder_type === 'overdue').length;
    
    if (!hasRecentOverdueReminder && totalOverdueReminders < 3) {
      reminderType = 'overdue';
    }
  } else if (dueDate && hoursUntilDue <= 24 && hoursUntilDue > 0) {
    // Due in 24h: one reminder if not submitted
    const recentDueSoonReminders = db.getRecentReminders(sa.id, 24);
    const hasRecentDueSoonReminder = recentDueSoonReminders
      .some(r => r.reminder_type === 'due_soon');
    
    if (!hasRecentDueSoonReminder) {
      reminderType = 'due_soon';
    }
  } else if (sa.status === 'assigned' && !sa.last_student_message) {
    // Silent student: no updates in 48 hours
    const createdAt = parseISO(sa.created_at);
    const hoursSinceCreated = (now - createdAt) / (1000 * 60 * 60);
    
    if (hoursSinceCreated > 48) {
      const recentSilentReminders = db.getRecentReminders(sa.id, 48);
      const hasRecentSilentReminder = recentSilentReminders
        .some(r => r.reminder_type === 'silent_checkin');
      
      if (!hasRecentSilentReminder) {
        reminderType = 'silent_checkin';
      }
    }
  }

  // Nothing to send
  if (!reminderType) return 'skipped';

  // Generate a contextual message using the LLM
  const message = await llm.generateReminderMessage({
    studentName: sa.student_name,
    assignmentTitle: sa.title,
    dueAt: sa.due_at ? new Date(sa.due_at).toLocaleDateString() : 'no deadline',
    currentStatus: sa.status,
    reminderType,
    daysTillDue: daysTillDue || 0,
    lastMessageSummary: sa.last_student_message
  });

  // Send via Telegram
  const sent = await sendTelegramMessage(sa.student_telegram_id, message);

  if (sent) {
    db.logReminder(sa.id, reminderType, message);
    console.log(`📬 Sent ${reminderType} reminder to ${sa.student_name} for "${sa.title}"`);
    return 'sent';
  }

  return 'skipped';
}

// =============================================================
// MARK OVERDUE ASSIGNMENTS
// WHY separate: overdue is a system-driven state change,
// not something a student or teacher does manually.
// =============================================================
async function markOverdueAssignments() {
  const activeSAs = db.getAssignmentsDueForReminder();
  let markedOverdue = 0;

  for (const sa of activeSAs) {
    if (!sa.due_at) continue;
    
    const dueDate = parseISO(sa.due_at);
    const isOverdue = dueDate < new Date();
    
    if (isOverdue && !['submitted', 'completed', 'overdue', 'cancelled'].includes(sa.status)) {
      db.updateStudentAssignmentStatus(sa.id, 'overdue');
      markedOverdue++;
      console.log(`⚠️ Marked ${sa.student_name}'s "${sa.title}" as overdue`);
    }
  }

  if (markedOverdue > 0) {
    console.log(`⏰ Marked ${markedOverdue} assignments as overdue`);
  }
}

module.exports = { startScheduler, runReminderCycle, markOverdueAssignments };
