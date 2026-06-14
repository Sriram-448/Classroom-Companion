// =============================================================
// student-routes.js — REST API for the Student Web UI.
// Students can ONLY see their own data — enforced server-side.
// =============================================================

const express = require('express');
const router = express.Router();
const db = require('../services/db-service');

// ─────────────────────────────────────────────
// AUTH MIDDLEWARE — students only
// ─────────────────────────────────────────────
function requireStudent(req, res, next) {
  const studentId = req.headers['x-user-id'];
  if (!studentId) return res.status(401).json({ error: 'Missing x-user-id header' });

  const user = db.getUserById(studentId);
  if (!user || user.role.toLowerCase() !== 'student') {
    return res.status(403).json({ error: 'Access denied: students only' });
  }

  req.student = user;
  next();
}

// GET /student/me
router.get('/me', requireStudent, (req, res) => {
  res.json({ user: req.student });
});

// GET /student/assignments — student's own assignments only
router.get('/assignments', requireStudent, (req, res) => {
  const assignments = db.getStudentAssignmentsByStudent(req.student.id);
  
  // Enrich with feedback
  const enriched = assignments.map(sa => ({
    ...sa,
    feedback: db.getFeedbackForStudentAssignment(sa.id)
  }));

  // Separate into active vs completed for easier UI rendering
  const active = enriched.filter(a => !['completed','cancelled'].includes(a.status));
  const completed = enriched.filter(a => a.status === 'completed');
  const cancelled = enriched.filter(a => a.status === 'cancelled');

  res.json({ assignments: enriched, active, completed, cancelled });
});

// GET /student/assignments/:id — one assignment's detail
// WHY check student_id: a student must NOT be able to access
// another student's assignment by guessing the ID
router.get('/assignments/:id', requireStudent, (req, res) => {
  const sa = db.getStudentAssignmentById(req.params.id);
  if (!sa) return res.status(404).json({ error: 'Not found' });

  // Server-side ownership check
  if (sa.student_id !== req.student.id) {
    return res.status(403).json({ error: 'This is not your assignment' });
  }

  const feedback = db.getFeedbackForStudentAssignment(sa.id);
  res.json({ assignment: sa, feedback });
});

// GET /student/dashboard — all data for student dashboard
router.get('/dashboard', requireStudent, (req, res) => {
  const assignments = db.getStudentAssignmentsByStudent(req.student.id);
  
  const enriched = assignments.map(sa => ({
    ...sa,
    feedback: db.getFeedbackForStudentAssignment(sa.id)
  }));

  const stats = {
    total: assignments.length,
    active: assignments.filter(a => !['completed','cancelled'].includes(a.status)).length,
    submitted: assignments.filter(a => ['submitted','needs_revision'].includes(a.status)).length,
    completed: assignments.filter(a => a.status === 'completed').length,
    overdue: assignments.filter(a => a.status === 'overdue').length,
    blocked: assignments.filter(a => a.status === 'blocked').length
  };

  res.json({ student: req.student, assignments: enriched, stats });
});

module.exports = router;
