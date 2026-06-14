const { getDb } = require('../models/database');
const { v4: uuidv4 } = require('uuid');

const db = () => getDb();

function createSchool(name) {
  const id = uuidv4();
  const inviteCode = 'SCH-' + Math.random().toString(36).substring(2,8).toUpperCase();
  db().prepare(`INSERT INTO schools (id,name,invite_code) VALUES (?,?,?)`).run(id,name,inviteCode);
  return getSchoolById(id);
}
function getSchoolById(id) {
  return db().prepare(`SELECT * FROM schools WHERE id=?`).get(id);
}
function getSchoolByInviteCode(code) {
  return db().prepare(`SELECT * FROM schools WHERE invite_code=?`).get(code);
}

function createClass(schoolId, name) {
  const id = uuidv4();
  db().prepare(`INSERT INTO classes (id,school_id,name) VALUES (?,?,?)`).run(id,schoolId,name);
  return getClassById(id);
}
function getClassById(id) { return db().prepare(`SELECT * FROM classes WHERE id=?`).get(id); }
function getClassesBySchool(schoolId) { return db().prepare(`SELECT * FROM classes WHERE school_id=?`).all(schoolId); }
function getTeacherClasses(teacherId) {
  return db().prepare(`
    SELECT c.*,s.name as school_name FROM classes c
    JOIN teacher_classes tc ON c.id=tc.class_id
    JOIN schools s ON c.school_id=s.id
    WHERE tc.teacher_id=?`).all(teacherId);
}
function addTeacherToClass(teacherId, classId) {
  try { db().prepare(`INSERT INTO teacher_classes (teacher_id,class_id) VALUES (?,?)`).run(teacherId,classId); } catch(e) {}
}
function addStudentToClass(studentId, classId) {
  try { db().prepare(`INSERT INTO student_classes (student_id,class_id) VALUES (?,?)`).run(studentId,classId); } catch(e) {}
}
function getStudentsByClass(classId) {
  return db().prepare(`SELECT u.* FROM users u JOIN student_classes sc ON u.id=sc.student_id WHERE sc.class_id=?`).all(classId);
}
function isTeacherInClass(teacherId, classId) {
  return !!db().prepare(`SELECT 1 FROM teacher_classes WHERE teacher_id=? AND class_id=?`).get(teacherId,classId);
}
function isStudentInClass(studentId, classId) {
  return !!db().prepare(`SELECT 1 FROM student_classes WHERE student_id=? AND class_id=?`).get(studentId,classId);
}

function createUser(data) {
  const id = uuidv4();
  db().prepare(`INSERT INTO users (id,telegram_id,telegram_handle,name,role,school_id) VALUES (?,?,?,?,?,?)`)
    .run(id, data.telegramId||null, data.telegramHandle||null, data.name, data.role, data.schoolId);
  return getUserById(id);
}
function getUserById(id) { 
  if (!id) return null;
  let user = db().prepare(`SELECT * FROM users WHERE id=?`).get(id);
  if (!user) {
    user = db().prepare(`SELECT * FROM users WHERE telegram_handle=?`).get(id);
  }
  if (!user) {
    user = db().prepare(`SELECT * FROM users WHERE LOWER(name) LIKE ?`).get(`%${id.toLowerCase()}%`);
  }
  return user;
}
function getUserByTelegramId(telegramId) {
  return db().prepare(`SELECT * FROM users WHERE telegram_id=?`).get(String(telegramId));
}
function linkTelegramToUser(userId, telegramId, telegramHandle) {
  db().prepare(`UPDATE users SET telegram_id=?,telegram_handle=? WHERE id=?`).run(String(telegramId),telegramHandle,userId);
}
function getUsersBySchool(schoolId) { return db().prepare(`SELECT * FROM users WHERE school_id=?`).all(schoolId); }

function createInviteCode(data) {
  const id = uuidv4();
  const code = data.role.toUpperCase().substring(0,3)+'-'+Math.random().toString(36).substring(2,8).toUpperCase();
  db().prepare(`INSERT INTO invite_codes (id,code,school_id,class_id,role,created_by,max_uses,expires_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id,code,data.schoolId,data.classId||null,data.role,data.createdBy,data.maxUses||1,data.expiresAt||null);
  return db().prepare(`SELECT * FROM invite_codes WHERE id=?`).get(id);
}
function getInviteCode(code) { return db().prepare(`SELECT * FROM invite_codes WHERE code=?`).get(code); }
function useInviteCode(codeId) {
  const inv = db().prepare(`SELECT * FROM invite_codes WHERE id=?`).get(codeId);
  if (!inv) return;
  const newCount = inv.use_count + 1;
  const newActive = newCount >= inv.max_uses ? 0 : 1;
  db().prepare(`UPDATE invite_codes SET use_count=?,is_active=? WHERE id=?`).run(newCount,newActive,codeId);
}
function validateInviteCode(code) {
  const invite = getInviteCode(code);
  if (!invite) return { valid:false, reason:'Code not found' };
  if (!invite.is_active) return { valid:false, reason:'Code has been fully used or deactivated' };
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return { valid:false, reason:'Code has expired' };
  return { valid:true, invite };
}

function createAssignment(data) {
  const id = uuidv4();
  db().prepare(`INSERT INTO assignments (id,school_id,class_id,teacher_id,title,description,raw_input,due_at,timezone,target_type,status) VALUES (?,?,?,?,?,?,?,?,?,?,'assigned')`)
    .run(id,data.schoolId,data.classId,data.teacherId,data.title,data.description,data.rawInput||null,data.dueAt||null,data.timezone||'UTC',data.targetType||'class');
  return getAssignmentById(id);
}
function getAssignmentById(id) {
  return db().prepare(`
    SELECT a.*,u.name as teacher_name,c.name as class_name
    FROM assignments a JOIN users u ON a.teacher_id=u.id JOIN classes c ON a.class_id=c.id
    WHERE a.id=?`).get(id);
}
function getAssignmentsByClass(classId) {
  return db().prepare(`
    SELECT a.*,u.name as teacher_name FROM assignments a JOIN users u ON a.teacher_id=u.id
    WHERE a.class_id=? AND a.status!='cancelled' ORDER BY a.created_at DESC`).all(classId);
}
function updateAssignment(id, data) {
  const a = db().prepare(`SELECT * FROM assignments WHERE id=?`).get(id);
  if (!a) return null;
  const title = data.title!==undefined ? data.title : a.title;
  const desc  = data.description!==undefined ? data.description : a.description;
  const due   = data.dueAt!==undefined ? data.dueAt : a.due_at;
  const status= data.status!==undefined ? data.status : a.status;
  db().prepare(`UPDATE assignments SET title=?,description=?,due_at=?,status=?,updated_at=? WHERE id=?`)
    .run(title,desc,due,status,new Date().toISOString(),id);
  return getAssignmentById(id);
}

const VALID_TRANSITIONS = {
  assigned:['acknowledged','in_progress','blocked','submitted','overdue','cancelled'],
  acknowledged:['in_progress','blocked','submitted','overdue','cancelled'],
  in_progress:['blocked','submitted','overdue','cancelled'],
  blocked:['in_progress','submitted','overdue','cancelled'],
  submitted:['needs_revision','completed','cancelled'],
  needs_revision:['submitted','cancelled'],
  completed:[],
  overdue:['submitted','cancelled'],
  cancelled:[]
};

function createStudentAssignment(assignmentId, studentId) {
  const existing = db().prepare(`SELECT * FROM student_assignments WHERE assignment_id=? AND student_id=?`).get(assignmentId,studentId);
  if (existing) return existing;
  const id = uuidv4();
  db().prepare(`INSERT INTO student_assignments (id,assignment_id,student_id,status) VALUES (?,?,?,'assigned')`)
    .run(id,assignmentId,studentId);
  return getStudentAssignment(assignmentId,studentId);
}
function getStudentAssignment(assignmentId, studentId) {
  return db().prepare(`
    SELECT sa.*,a.title,a.description,a.due_at,a.timezone,a.teacher_id,a.class_id,a.school_id,
           u.name as student_name,u.telegram_id as student_telegram_id
    FROM student_assignments sa JOIN assignments a ON sa.assignment_id=a.id JOIN users u ON sa.student_id=u.id
    WHERE sa.assignment_id=? AND sa.student_id=?`).get(assignmentId,studentId);
}
function getStudentAssignmentById(id) {
  return db().prepare(`
    SELECT sa.*,a.title,a.description,a.due_at,a.timezone,a.teacher_id,a.class_id,
           u.name as student_name,u.telegram_id as student_telegram_id,t.name as teacher_name
    FROM student_assignments sa JOIN assignments a ON sa.assignment_id=a.id
    JOIN users u ON sa.student_id=u.id JOIN users t ON a.teacher_id=t.id
    WHERE sa.id=?`).get(id);
}
function getStudentAssignmentsByStudent(studentId) {
  return db().prepare(`
    SELECT sa.*,a.title,a.description,a.due_at,a.timezone,c.name as class_name,u.name as teacher_name
    FROM student_assignments sa JOIN assignments a ON sa.assignment_id=a.id
    JOIN classes c ON a.class_id=c.id JOIN users u ON a.teacher_id=u.id
    WHERE sa.student_id=? AND a.status!='cancelled' ORDER BY a.due_at,sa.created_at DESC`).all(studentId);
}
function getAssignmentStudents(assignmentId) {
  return db().prepare(`
    SELECT sa.*,u.name as student_name,u.telegram_id as student_telegram_id
    FROM student_assignments sa JOIN users u ON sa.student_id=u.id
    WHERE sa.assignment_id=?`).all(assignmentId);
}
function updateStudentAssignmentStatus(id, newStatus, extraData={}) {
  const current = db().prepare(`SELECT * FROM student_assignments WHERE id=?`).get(id);
  if (!current) throw new Error(`SA ${id} not found`);
  const valid = VALID_TRANSITIONS[current.status]||[];
  if (newStatus !== current.status && !valid.includes(newStatus)) {
    console.warn(`Invalid transition ${current.status} to ${newStatus}`);
    return current;
  }
  let q = `UPDATE student_assignments SET status=?,updated_at=?`;
  const vals = [newStatus, new Date().toISOString()];
  if (newStatus==='submitted') { q+=`,submitted_at=?`; vals.push(new Date().toISOString()); }
  if (newStatus==='completed') { q+=`,completed_at=?`; vals.push(new Date().toISOString()); }
  if (extraData.lastStudentMessage) { q+=`,last_student_message=?`; vals.push(extraData.lastStudentMessage); }
  if (extraData.submissionText) { q+=`,submission_text=?`; vals.push(extraData.submissionText); }
  if (extraData.submissionFilePath) { q+=`,submission_file_path=?`; vals.push(extraData.submissionFilePath); }
  if (extraData.submissionFileName) { q+=`,submission_file_name=?`; vals.push(extraData.submissionFileName); }
  q+=` WHERE id=?`; vals.push(id);
  db().prepare(q).run(...vals);
  return db().prepare(`SELECT * FROM student_assignments WHERE id=?`).get(id);
}

function createFeedback(saId, teacherId, content) {
  const id = uuidv4();
  db().prepare(`INSERT INTO feedback (id,student_assignment_id,teacher_id,content) VALUES (?,?,?,?)`).run(id,saId,teacherId,content);
  return db().prepare(`SELECT * FROM feedback WHERE id=?`).get(id);
}
function markFeedbackSent(feedbackId) {
  db().prepare(`UPDATE feedback SET sent_via_telegram=1 WHERE id=?`).run(feedbackId);
}
function getFeedbackForStudentAssignment(saId) {
  return db().prepare(`SELECT f.*,u.name as teacher_name FROM feedback f JOIN users u ON f.teacher_id=u.id WHERE f.student_assignment_id=? ORDER BY f.created_at DESC`).all(saId);
}

function logReminder(saId, reminderType, message) {
  const id = uuidv4();
  db().prepare(`INSERT INTO reminders (id,student_assignment_id,reminder_type,message) VALUES (?,?,?,?)`).run(id,saId,reminderType,message);
}
function getRecentReminders(saId, hoursBack=24) {
  const cutoff = new Date(Date.now() - hoursBack*3600*1000).toISOString();
  return db().prepare(`SELECT * FROM reminders WHERE student_assignment_id=? AND sent_at>?`).all(saId,cutoff);
}
function getAssignmentsDueForReminder() {
  return db().prepare(`
    SELECT sa.*,a.title,a.due_at,a.timezone,a.class_id,
           u.name as student_name,u.telegram_id as student_telegram_id,
           t.name as teacher_name,t.telegram_id as teacher_telegram_id
    FROM student_assignments sa JOIN assignments a ON sa.assignment_id=a.id
    JOIN users u ON sa.student_id=u.id JOIN users t ON a.teacher_id=t.id
    WHERE sa.status NOT IN ('completed','cancelled') AND a.status='assigned' AND u.telegram_id IS NOT NULL`).all();
}

function logMessage(data) {
  const id = uuidv4();
  try {
    db().prepare(`INSERT INTO message_log (id,telegram_update_id,user_id,telegram_id,direction,content,message_type) VALUES (?,?,?,?,?,?,?)`)
      .run(id,data.updateId||null,data.userId||null,data.telegramId||null,data.direction,data.content,data.messageType||'text');
  } catch(e) {}
}
function hasProcessedUpdate(updateId) {
  if (!updateId) return false;
  return !!db().prepare(`SELECT 1 FROM message_log WHERE telegram_update_id=?`).get(String(updateId));
}

function savePendingLink(telegramId, inviteCode) {
  try {
    db().prepare(`INSERT INTO pending_links (telegram_id,invite_code) VALUES (?,?)`).run(String(telegramId),inviteCode);
  } catch(e) {
    db().prepare(`UPDATE pending_links SET invite_code=? WHERE telegram_id=?`).run(inviteCode,String(telegramId));
  }
}
function getPendingLink(telegramId) { return db().prepare(`SELECT * FROM pending_links WHERE telegram_id=?`).get(String(telegramId)); }
function deletePendingLink(telegramId) { db().prepare(`DELETE FROM pending_links WHERE telegram_id=?`).run(String(telegramId)); }
function rawPrepare(sql) { return db().prepare(sql); }

module.exports = {
  createSchool,getSchoolById,getSchoolByInviteCode,
  createClass,getClassById,getClassesBySchool,getTeacherClasses,
  addTeacherToClass,addStudentToClass,getStudentsByClass,isTeacherInClass,isStudentInClass,
  createUser,getUserById,getUserByTelegramId,linkTelegramToUser,getUsersBySchool,
  createInviteCode,getInviteCode,useInviteCode,validateInviteCode,
  createAssignment,getAssignmentById,getAssignmentsByClass,updateAssignment,
  createStudentAssignment,getStudentAssignment,getStudentAssignmentById,
  getStudentAssignmentsByStudent,getAssignmentStudents,updateStudentAssignmentStatus,
  createFeedback,markFeedbackSent,getFeedbackForStudentAssignment,
  logReminder,getRecentReminders,getAssignmentsDueForReminder,
  logMessage,hasProcessedUpdate,
  savePendingLink,getPendingLink,deletePendingLink,
  rawPrepare
};