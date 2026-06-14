// =============================================================
// teacher-routes.js — WHY: REST API for the Teacher Web UI.
// Every route enforces authorization BEFORE returning data.
// WHY separate file: keeps server.js clean, lets us test routes
// independently, and makes the API surface easy to document.
// =============================================================

const express = require('express');
const router = express.Router();
const db = require('../services/db-service');
const llm = require('../llm/llm');
const { sendTelegramMessage } = require('../services/bot');
const { runReminderCycle } = require('../jobs/scheduler');

// ─────────────────────────────────────────────
// AUTH MIDDLEWARE
// WHY: Every teacher route checks that the caller is
// actually a teacher (not a student or stranger).
// In production, this would verify a JWT token.
// For this demo, we use a teacher_id header.
// ─────────────────────────────────────────────
function requireTeacher(req, res, next) {
  const teacherId = req.headers['x-user-id'];
  if (!teacherId) {
    return res.status(401).json({ error: 'Missing x-user-id header' });
  }

  const user = db.getUserById(teacherId);
  if (!user || !['teacher', 'coordinator'].includes(user.role.toLowerCase())) {
    return res.status(403).json({ error: 'Access denied: teachers only' });
  }

  req.teacher = user;
  next();
}

// ─────────────────────────────────────────────
// GET /teacher/me — who am I?
// ─────────────────────────────────────────────
router.get('/me', requireTeacher, (req, res) => {
  const classes = db.getTeacherClasses(req.teacher.id);
  res.json({ user: req.teacher, classes });
});

// ─────────────────────────────────────────────
// GET /teacher/classes — teacher's authorized classes
// ─────────────────────────────────────────────
router.get('/classes', requireTeacher, (req, res) => {
  const classes = db.getTeacherClasses(req.teacher.id);
  res.json({ classes });
});

// ─────────────────────────────────────────────
// GET /teacher/classes/:classId/assignments
// WHY authorization check: teacher can only see their own classes
// ─────────────────────────────────────────────
router.get('/classes/:classId/assignments', requireTeacher, (req, res) => {
  const { classId } = req.params;

  if (!db.isTeacherInClass(req.teacher.id, classId)) {
    return res.status(403).json({ error: 'You are not authorized for this class' });
  }

  const assignments = db.getAssignmentsByClass(classId);
  
  // Enrich with student statuses
  const enriched = assignments.map(a => {
    const students = db.getAssignmentStudents(a.id);
    const statusCounts = {};
    students.forEach(s => {
      statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
    });
    return { ...a, students, statusCounts, studentCount: students.length };
  });

  res.json({ assignments: enriched });
});

// ─────────────────────────────────────────────
// POST /teacher/assignments — create assignment via web UI
// ─────────────────────────────────────────────
router.post('/assignments', requireTeacher, async (req, res) => {
  const { class_id, classId: directClassId, raw_input, title: directTitle, description: directDescription, dueAt: directDueAt, targetType } = req.body;
  const targetClassId = class_id || directClassId;

  if (!targetClassId) {
    return res.status(400).json({ error: 'classId is required' });
  }

  if (!db.isTeacherInClass(req.teacher.id, targetClassId)) {
    return res.status(403).json({ error: 'Not authorized for this class' });
  }

  let finalTitle = directTitle;
  let finalDescription = directDescription;
  let finalDueAt = directDueAt;

  // If raw natural language input is supplied, run it through the Grok LLM parser
  if (raw_input) {
    try {
      const parsed = await llm.parseAssignment(raw_input, new Date().toISOString(), 'UTC');
      finalTitle = parsed.title || 'New Assignment';
      finalDescription = parsed.description || raw_input;
      finalDueAt = parsed.due_at || null;
    } catch (err) {
      console.error("AI Assignment parsing failed, using fallback:", err);
      finalTitle = 'New Assignment';
      finalDescription = raw_input;
    }
  }

  if (!finalTitle || !finalDescription) {
    return res.status(400).json({ error: 'Title and description are required' });
  }

  const assignment = db.createAssignment({
    schoolId: req.teacher.school_id,
    classId: targetClassId,
    teacherId: req.teacher.id,
    title: finalTitle,
    description: finalDescription,
    dueAt: finalDueAt || null,
    targetType: targetType || 'class'
  });

  // Distribute to students
  const students = db.getStudentsByClass(targetClassId);
  let notifiedCount = 0;

  for (const student of students) {
    db.createStudentAssignment(assignment.id, student.id);
    if (student.telegram_id) {
      const sent = await sendTelegramMessage(student.telegram_id,
        `📚 *New Assignment*\n\n*${finalTitle}*\n${finalDescription}\n\n📅 Due: ${finalDueAt ? new Date(finalDueAt).toLocaleDateString() : 'TBD'}`,
        { parse_mode: 'Markdown' }
      );
      if (sent) notifiedCount++;
    }
  }

  res.status(201).json({ 
    assignment, 
    studentsTotal: students.length,
    studentsNotified: notifiedCount
  });
});


// ─────────────────────────────────────────────
// PATCH /teacher/assignments/:id — update deadline or details
// WHY PATCH not PUT: we're updating fields, not replacing the whole object
// ─────────────────────────────────────────────
router.patch('/assignments/:id', requireTeacher, async (req, res) => {
  const { id } = req.params;
  const { title, description, dueAt, status } = req.body;

  const assignment = db.getAssignmentById(id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  // Verify ownership — teacher can only edit their own assignments
  if (assignment.teacher_id !== req.teacher.id) {
    return res.status(403).json({ error: 'You can only edit your own assignments' });
  }

  const updated = db.updateAssignment(id, { title, description, dueAt, status });

  // If deadline changed, notify students via Telegram
  if (dueAt && dueAt !== assignment.due_at) {
    const students = db.getAssignmentStudents(id);
    for (const sa of students) {
      if (sa.student_telegram_id && !['completed', 'cancelled'].includes(sa.status)) {
        await sendTelegramMessage(sa.student_telegram_id,
          `📅 *Deadline Updated*\n\nThe deadline for "${assignment.title}" has been changed.\n\nNew deadline: ${new Date(dueAt).toLocaleDateString()}`
        );
      }
    }
  }

  // If cancelled, notify students
  if (status === 'cancelled') {
    const students = db.getAssignmentStudents(id);
    for (const sa of students) {
      if (sa.student_telegram_id && !['completed'].includes(sa.status)) {
        await sendTelegramMessage(sa.student_telegram_id,
          `❌ *Assignment Cancelled*\n\n"${assignment.title}" has been cancelled by your teacher.`
        );
      }
    }
  }

  res.json({ assignment: updated });
});

// ─────────────────────────────────────────────
// GET /teacher/assignments/:id — full detail view
// ─────────────────────────────────────────────
router.get('/assignments/:id', requireTeacher, async (req, res) => {
  const assignment = db.getAssignmentById(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'Not found' });

  if (assignment.teacher_id !== req.teacher.id && 
      !db.isTeacherInClass(req.teacher.id, assignment.class_id)) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const students = db.getAssignmentStudents(assignment.id);
  const studentsWithFeedback = students.map(sa => ({
    ...sa,
    feedback: db.getFeedbackForStudentAssignment(sa.id)
  }));

  // Generate LLM summary
  const summary = await llm.generateTeacherSummary(
    assignment,
    studentsWithFeedback.map(s => ({
      name: s.student_name,
      status: s.status,
      last_message: s.last_student_message
    }))
  );

  res.json({ assignment, students: studentsWithFeedback, summary });
});

// ─────────────────────────────────────────────
// POST /teacher/feedback — send feedback on submission
// ─────────────────────────────────────────────
router.post('/feedback', requireTeacher, async (req, res) => {
  const { studentAssignmentId, content, markAsNeedsRevision } = req.body;

  if (!studentAssignmentId || !content) {
    return res.status(400).json({ error: 'studentAssignmentId and content required' });
  }

  const sa = db.getStudentAssignmentById(studentAssignmentId);
  if (!sa) return res.status(404).json({ error: 'Student assignment not found' });

  // Verify teacher is authorized for this assignment's class
  const assignment = db.getAssignmentById(sa.assignment_id);
  if (!db.isTeacherInClass(req.teacher.id, assignment.class_id)) {
    return res.status(403).json({ error: 'Not authorized for this class' });
  }

  // Create feedback record
  const feedback = db.createFeedback(studentAssignmentId, req.teacher.id, content);

  // Update assignment status based on teacher's decision
  const newStatus = markAsNeedsRevision ? 'needs_revision' : 'completed';
  db.updateStudentAssignmentStatus(studentAssignmentId, newStatus);

  // Send feedback via Telegram if student is linked
  if (sa.student_telegram_id) {
    const statusMsg = markAsNeedsRevision
      ? '📝 Your teacher has reviewed your work and has some suggestions:'
      : '✅ Your teacher has reviewed and completed your assignment:';

    const sent = await sendTelegramMessage(sa.student_telegram_id,
      `${statusMsg}\n\n*${sa.title}*\n\n💬 Feedback:\n${content}`,
      { parse_mode: 'Markdown' }
    );

    if (sent) db.markFeedbackSent(feedback.id);
  }

  res.status(201).json({ feedback, newStatus });
});

// ─────────────────────────────────────────────
// POST /teacher/invite — create invite code for a class
// ─────────────────────────────────────────────
router.post('/invite', requireTeacher, (req, res) => {
  const { classId, role, maxUses } = req.body;

  if (!classId || !role) {
    return res.status(400).json({ error: 'classId and role required' });
  }

  if (!['student', 'teacher'].includes(role)) {
    return res.status(400).json({ error: 'role must be student or teacher' });
  }

  if (!db.isTeacherInClass(req.teacher.id, classId)) {
    return res.status(403).json({ error: 'Not authorized for this class' });
  }

  const invite = db.createInviteCode({
    schoolId: req.teacher.school_id,
    classId,
    role,
    createdBy: req.teacher.id,
    maxUses: maxUses || 30 // Allow up to 30 students per code by default
  });

  const botUsername = process.env.BOT_USERNAME || 'ClassroomCompanionBot';
  const deepLink = `https://t.me/${botUsername}?start=${invite.code}`;

  res.status(201).json({ invite, deepLink });
});

// ─────────────────────────────────────────────
// POST /teacher/remind — manually trigger reminders (demo use)
// ─────────────────────────────────────────────
router.post('/remind', requireTeacher, async (req, res) => {
  console.log(`🔔 Manual reminder trigger by teacher ${req.teacher.id}`);
  const results = await runReminderCycle();
  res.json({ message: 'Reminder cycle completed', results });
});

// ─────────────────────────────────────────────
// GET /teacher/dashboard — all data for dashboard
// ─────────────────────────────────────────────
router.get('/dashboard', requireTeacher, (req, res) => {
  const classes = db.getTeacherClasses(req.teacher.id);
  
  const dashboard = classes.map(cls => {
    const assignments = db.getAssignmentsByClass(cls.id);
    
    const assignmentSummaries = assignments.map(a => {
      const students = db.getAssignmentStudents(a.id);
      return {
        ...a,
        studentCount: students.length,
        submitted: students.filter(s => ['submitted','completed'].includes(s.status)).length,
        blocked: students.filter(s => s.status === 'blocked').length,
        overdue: students.filter(s => s.status === 'overdue').length,
        atRisk: students.filter(s => ['blocked','overdue','assigned'].includes(s.status))
          .map(s => ({ name: s.student_name, status: s.status }))
      };
    });

    return {
      class: cls,
      assignments: assignmentSummaries,
      stats: {
        total: assignments.length,
        hasRisk: assignmentSummaries.some(a => a.blocked > 0 || a.overdue > 0)
      }
    };
  });

  res.json({ teacher: req.teacher, dashboard });
});

module.exports = router;
