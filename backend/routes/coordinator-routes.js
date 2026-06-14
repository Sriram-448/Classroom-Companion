// =============================================================
// coordinator-routes.js — WHY: The assignment specifies a
// "School/Coordinator" actor who owns the school context,
// creates grades/classes, invites teachers, and sees
// operational health. This is a separate role from teacher.
//
// Access rules:
// - Coordinator can see ALL data in their school
// - Coordinator CANNOT see data from other schools
// - Coordinators can also be teachers (same user, role='coordinator')
// =============================================================

const express = require('express');
const router = express.Router();
const db = require('../services/db-service');

// ── AUTH ──────────────────────────────────────────────────────
function requireCoordinator(req, res, next) {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header' });

  const user = db.getUserById(userId);
  if (!user || user.role.toLowerCase() !== 'coordinator') {
    return res.status(403).json({ error: 'Access denied: coordinator only' });
  }

  req.coordinator = user;
  next();
}

// ── GET /coordinator/school — full school health overview ─────
router.get('/school', requireCoordinator, (req, res) => {
  const school = db.getSchoolById(req.coordinator.school_id);
  if (!school) return res.status(404).json({ error: 'School not found' });

  const allUsers = db.getUsersBySchool(school.id);
  const teachers = allUsers.filter(u => ['teacher', 'coordinator'].includes(u.role));
  const students = allUsers.filter(u => u.role === 'student');
  const classes = db.getClassesBySchool(school.id);

  // Per-class health summary
  const classHealth = classes.map(cls => {
    const classTeachers = db.rawPrepare(
      `SELECT u.name FROM users u JOIN teacher_classes tc ON u.id=tc.teacher_id WHERE tc.class_id=?`
    ).all(cls.id);
    const classStudents = db.getStudentsByClass(cls.id);
    const assignments = db.getAssignmentsByClass(cls.id);

    const studentStats = { linked: 0, unlinked: 0 };
    classStudents.forEach(s => s.telegram_id ? studentStats.linked++ : studentStats.unlinked++);

    return {
      class: cls,
      teacherCount: classTeachers.length,
      teachers: classTeachers.map(t => t.name),
      studentCount: classStudents.length,
      studentStats,
      assignmentCount: assignments.length
    };
  });

  res.json({
    school,
    summary: {
      totalTeachers: teachers.length,
      totalStudents: students.length,
      totalClasses: classes.length,
      linkedStudents: students.filter(s => s.telegram_id).length
    },
    classes: classHealth,
    teachers: teachers.map(t => ({
      id: t.id, name: t.name, role: t.role,
      telegramLinked: !!t.telegram_id
    }))
  });
});

// ── POST /coordinator/classes — create a new class ────────────
router.post('/classes', requireCoordinator, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Class name required' });

  const cls = db.createClass(req.coordinator.school_id, name);
  res.status(201).json({ class: cls });
});

// ── POST /coordinator/invite-teacher — invite a teacher ───────
router.post('/invite-teacher', requireCoordinator, (req, res) => {
  const { classId } = req.body;

  const cls = classId ? db.getClassById(classId) : null;
  if (classId && (!cls || cls.school_id !== req.coordinator.school_id)) {
    return res.status(403).json({ error: 'Class not in your school' });
  }

  const invite = db.createInviteCode({
    schoolId: req.coordinator.school_id,
    classId: classId || null,
    role: 'teacher',
    createdBy: req.coordinator.id,
    maxUses: 5
  });

  const botUsername = process.env.BOT_USERNAME || 'ClassroomCompanionBot';
  res.status(201).json({
    invite,
    deepLink: `https://t.me/${botUsername}?start=${invite.code}`
  });
});

// ── GET /coordinator/students — all students in school ────────
router.get('/students', requireCoordinator, (req, res) => {
  const allUsers = db.getUsersBySchool(req.coordinator.school_id);
  const students = allUsers.filter(u => u.role === 'student');

  const enriched = students.map(s => {
    const assignments = db.getStudentAssignmentsByStudent(s.id);
    return {
      ...s,
      telegram_linked: !!s.telegram_id,
      total_assignments: assignments.length,
      overdue: assignments.filter(a => a.status === 'overdue').length,
      blocked: assignments.filter(a => a.status === 'blocked').length
    };
  });

  res.json({ students: enriched });
});

// ── DELETE /coordinator/students/:id ──────────────────────────
router.delete('/students/:id', requireCoordinator, (req, res) => {
  const { id } = req.params;
  const student = db.getUserById(id);
  if (!student || student.role !== 'student' || student.school_id !== req.coordinator.school_id) {
    return res.status(403).json({ error: 'Student not found or unauthorized' });
  }

  db.rawPrepare(`DELETE FROM student_classes WHERE student_id=?`).run(id);
  db.rawPrepare(`DELETE FROM student_assignments WHERE student_id=?`).run(id);
  db.rawPrepare(`DELETE FROM users WHERE id=?`).run(id);

  res.json({ success: true, message: `Student ${student.name} deleted` });
});

// ── DELETE /coordinator/teachers/:id ──────────────────────────
router.delete('/teachers/:id', requireCoordinator, (req, res) => {
  const { id } = req.params;
  const teacher = db.getUserById(id);
  if (!teacher || !['teacher', 'coordinator'].includes(teacher.role.toLowerCase()) || teacher.school_id !== req.coordinator.school_id) {
    return res.status(403).json({ error: 'Teacher not found or unauthorized' });
  }

  // Prevent coordinator from deleting themselves
  if (teacher.id === req.coordinator.id) {
    return res.status(400).json({ error: 'You cannot delete yourself!' });
  }

  db.rawPrepare(`DELETE FROM teacher_classes WHERE teacher_id=?`).run(id);
  db.rawPrepare(`DELETE FROM users WHERE id=?`).run(id);

  res.json({ success: true, message: `Teacher ${teacher.name} deleted` });
});

module.exports = router;
