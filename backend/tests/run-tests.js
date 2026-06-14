require('dotenv').config({ path: require('path').join(__dirname,'../../.env') });
const path = require('path');
process.env.DB_PATH = path.join(__dirname,'../data/test.db');

const { initializeDatabase } = require('../models/database');
const db = require('../services/db-service');

let passed=0, failed=0, errors=[];

function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch(err) { console.log(`  ❌ ${name}: ${err.message}`); failed++; errors.push({name,error:err.message}); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg||'Assertion failed'); }
function assertEqual(a, b, msg) { if (a!==b) throw new Error(msg||`Expected "${b}", got "${a}"`); }

async function run() {
  await initializeDatabase();
  // Clear test data
  ['feedback','reminders','message_log','student_assignments','assignments',
   'student_classes','teacher_classes','invite_codes','pending_links','users','classes','schools']
    .forEach(t => { try { db.rawPrepare(`DELETE FROM ${t}`).run(); } catch(e){} });

  console.log('\n🧪 Classroom Companion Test Suite\n');

  console.log('📦 Test 1: Domain Model');
  let school,cls,teacher,s1,s2;
  test('Create school', () => {
    school = db.createSchool('Test School');
    assert(school.id,'no id'); assert(school.invite_code,'no invite_code');
  });
  test('Create class', () => {
    cls = db.createClass(school.id,'Grade 8A');
    assert(cls.id,'no id'); assertEqual(cls.school_id,school.id,'wrong school');
  });
  test('Create teacher + add to class', () => {
    teacher = db.createUser({name:'Test Teacher',role:'teacher',schoolId:school.id,telegramId:'tg_t_1'});
    db.addTeacherToClass(teacher.id,cls.id);
    assert(db.isTeacherInClass(teacher.id,cls.id),'teacher not in class');
  });
  test('Create two students + add to class', () => {
    s1 = db.createUser({name:'Student One',role:'student',schoolId:school.id,telegramId:'tg_s_1'});
    s2 = db.createUser({name:'Student Two',role:'student',schoolId:school.id,telegramId:null});
    db.addStudentToClass(s1.id,cls.id); db.addStudentToClass(s2.id,cls.id);
    assertEqual(db.getStudentsByClass(cls.id).length,2,'expected 2 students');
  });
  test('Lookup user by Telegram ID', () => {
    const u = db.getUserByTelegramId('tg_t_1');
    assert(u,'not found'); assertEqual(u.id,teacher.id,'wrong user');
  });

  console.log('\n📋 Test 2: Assignment State Machine');
  let assignment,sa1;
  test('Create assignment', () => {
    assignment = db.createAssignment({schoolId:school.id,classId:cls.id,teacherId:teacher.id,
      title:'Water Cycle Essay',description:'Write 500 words',
      dueAt:new Date(Date.now()+7*86400000).toISOString()});
    assert(assignment.id,'no id'); assertEqual(assignment.status,'assigned','wrong status');
  });
  test('Create student assignment records', () => {
    sa1 = db.createStudentAssignment(assignment.id,s1.id);
    const sa2 = db.createStudentAssignment(assignment.id,s2.id);
    assert(sa1&&sa2,'failed'); assertEqual(sa1.status,'assigned','wrong initial status');
  });
  test('assigned → acknowledged', () => {
    const u = db.updateStudentAssignmentStatus(sa1.id,'acknowledged');
    assertEqual(u.status,'acknowledged','wrong status');
  });
  test('acknowledged → in_progress', () => {
    const u = db.updateStudentAssignmentStatus(sa1.id,'in_progress');
    assertEqual(u.status,'in_progress','wrong status');
  });
  test('in_progress → blocked', () => {
    const u = db.updateStudentAssignmentStatus(sa1.id,'blocked',{lastStudentMessage:"I'm stuck"});
    assertEqual(u.status,'blocked','wrong status');
    assert(u.last_student_message,'no message stored');
  });
  test('blocked → in_progress (unblocked)', () => {
    const u = db.updateStudentAssignmentStatus(sa1.id,'in_progress');
    assertEqual(u.status,'in_progress','wrong status');
  });
  test('in_progress → submitted', () => {
    const u = db.updateStudentAssignmentStatus(sa1.id,'submitted',{submissionText:'My essay here'});
    assertEqual(u.status,'submitted','wrong status');
    assert(u.submitted_at,'no submitted_at');
  });
  test('submitted → completed', () => {
    const u = db.updateStudentAssignmentStatus(sa1.id,'completed');
    assertEqual(u.status,'completed','wrong status');
    assert(u.completed_at,'no completed_at');
  });
  test('INVALID: completed → in_progress is silently rejected', () => {
    const before = db.rawPrepare(`SELECT status FROM student_assignments WHERE id=?`).get(sa1.id);
    db.updateStudentAssignmentStatus(sa1.id,'in_progress');
    const after = db.rawPrepare(`SELECT status FROM student_assignments WHERE id=?`).get(sa1.id);
    assertEqual(after.status,'completed','status should not change from completed');
  });

  console.log('\n🔐 Test 3: Authorization Boundaries');
  let school2,cls2,teacher2;
  test('Setup second school/class', () => {
    school2 = db.createSchool('Other School');
    cls2 = db.createClass(school2.id,'Grade 9B');
    teacher2 = db.createUser({name:'Other Teacher',role:'teacher',schoolId:school2.id,telegramId:'tg_t_2'});
    db.addTeacherToClass(teacher2.id,cls2.id);
    assert(true,'setup ok');
  });
  test('Teacher1 NOT in class2', () => assert(!db.isTeacherInClass(teacher.id,cls2.id),'should not be authorized'));
  test('Teacher2 NOT in class1', () => assert(!db.isTeacherInClass(teacher2.id,cls.id),'should not be authorized'));
  test('Student from school1 NOT in school2 class', () => assert(!db.isStudentInClass(s1.id,cls2.id),'wrong isolation'));
  test('Student only sees own assignments', () => {
    db.getStudentAssignmentsByStudent(s1.id).forEach(a => assertEqual(a.student_id,s1.id,'saw another student'));
    assert(true,'isolation ok');
  });

  console.log('\n🔄 Test 4: Idempotency');
  test('Duplicate Telegram update_id detected', () => {
    const uid = 'tg_upd_99999';
    assert(!db.hasProcessedUpdate(uid),'should not be processed');
    db.logMessage({updateId:uid,telegramId:'tg_s_1',direction:'incoming',content:'hi',messageType:'text'});
    assert(db.hasProcessedUpdate(uid),'should be detected as duplicate');
  });
  test('Creating same student assignment twice does not duplicate', () => {
    const a2 = db.createAssignment({schoolId:school.id,classId:cls.id,teacherId:teacher.id,title:'Dedup Test',description:'test'});
    db.createStudentAssignment(a2.id,s1.id);
    db.createStudentAssignment(a2.id,s1.id);
    const rows = db.rawPrepare(`SELECT COUNT(*) as c FROM student_assignments WHERE assignment_id=? AND student_id=?`).get(a2.id,s1.id);
    assertEqual(rows.c,1,'should only be 1 row');
  });

  console.log('\n📨 Test 5: Invite Codes');
  test('Create and validate invite code', () => {
    const inv = db.createInviteCode({schoolId:school.id,classId:cls.id,role:'student',createdBy:teacher.id,maxUses:2});
    const v = db.validateInviteCode(inv.code);
    assert(v.valid,'should be valid');
  });
  test('Single-use code invalid after use', () => {
    const inv = db.createInviteCode({schoolId:school.id,classId:cls.id,role:'student',createdBy:teacher.id,maxUses:1});
    db.useInviteCode(inv.id);
    assert(!db.validateInviteCode(inv.code).valid,'should be invalid after use');
  });
  test('Fake code returns error', () => {
    const v = db.validateInviteCode('FAKE-XXXX');
    assert(!v.valid,'should be invalid'); assert(v.reason,'should have reason');
  });

  console.log('\n💬 Test 6: Feedback');
  test('Create feedback on submission', () => {
    const a3 = db.createAssignment({schoolId:school.id,classId:cls.id,teacherId:teacher.id,title:'FB Test',description:'test'});
    const sa = db.createStudentAssignment(a3.id,s1.id);
    db.updateStudentAssignmentStatus(sa.id,'acknowledged');
    db.updateStudentAssignmentStatus(sa.id,'submitted',{submissionText:'here'});
    const fb = db.createFeedback(sa.id,teacher.id,'Great work!');
    assert(fb.id,'no id');
    const list = db.getFeedbackForStudentAssignment(sa.id);
    assertEqual(list.length,1,'should have 1 feedback');
    assert(list[0].teacher_name,'no teacher name on feedback');
  });

  console.log('\n'+'='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (errors.length) { console.log('\nFailed:'); errors.forEach(e => console.log(`  ❌ ${e.name}: ${e.error}`)); }
  console.log('='.repeat(50));
  process.exit(failed>0?1:0);
}

run().catch(err => { console.error(err); process.exit(1); });
