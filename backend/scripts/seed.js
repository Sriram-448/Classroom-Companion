require('dotenv').config({ path: require('path').join(__dirname,'../../.env') });
const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname,'../data/classroom.db');

const { initializeDatabase } = require('../models/database');
const db = require('../services/db-service');

async function seed() {
  await initializeDatabase();
  console.log('🌱 Seeding demo data...\n');

  let school = db.getSchoolByInviteCode('SCH-DEMO1');
  if (!school) {
    school = db.createSchool('Demo School');
    db.rawPrepare(`UPDATE schools SET invite_code='SCH-DEMO1' WHERE id=?`).run(school.id);
    school = db.getSchoolById(school.id);
  }
  console.log(`✅ School: ${school.name} (${school.id})`);

  const classes = db.getClassesBySchool(school.id);
  let cls = classes.find(c => c.name === 'Grade 8 - Section A');
  if (!cls) cls = db.createClass(school.id, 'Grade 8 - Section A');
  console.log(`✅ Class: ${cls.name} (${cls.id})`);

  let teacher = db.rawPrepare(`SELECT * FROM users WHERE name='Ms. Sharma' AND school_id=?`).get(school.id);
  if (!teacher) teacher = db.createUser({ name:'Ms. Sharma', role:'teacher', schoolId:school.id,
    telegramId: process.env.TEACHER_TELEGRAM_ID||'TEACHER_TG_DEMO', telegramHandle:'mssharma_teacher' });
  db.addTeacherToClass(teacher.id, cls.id);
  console.log(`✅ Teacher: ${teacher.name} (${teacher.id})`);

  // Coordinator — school-level admin
  let coordinator = db.rawPrepare(`SELECT * FROM users WHERE name='Principal Mehta' AND school_id=?`).get(school.id);
  if (!coordinator) coordinator = db.createUser({ name:'Principal Mehta', role:'coordinator', schoolId:school.id,
    telegramId: process.env.COORDINATOR_TELEGRAM_ID||'COORDINATOR_TG_DEMO', telegramHandle:'principal_mehta' });
  console.log(`✅ Coordinator: ${coordinator.name} (${coordinator.id})`);

  let s1 = db.rawPrepare(`SELECT * FROM users WHERE name='Rahul Verma' AND school_id=?`).get(school.id);
  if (!s1) s1 = db.createUser({ name:'Rahul Verma', role:'student', schoolId:school.id,
    telegramId: process.env.STUDENT1_TELEGRAM_ID||'STUDENT1_TG_DEMO', telegramHandle:'rahul_verma' });
  db.addStudentToClass(s1.id, cls.id);
  console.log(`✅ Student 1 (linked): ${s1.name} (${s1.id})`);

  let s2 = db.rawPrepare(`SELECT * FROM users WHERE name='Priya Singh' AND school_id=?`).get(school.id);
  if (!s2) s2 = db.createUser({ name:'Priya Singh', role:'student', schoolId:school.id, telegramId:null });
  db.addStudentToClass(s2.id, cls.id);
  console.log(`✅ Student 2 (unlinked): ${s2.name} (${s2.id})`);

  // Invite codes
  const setCode = (id, code) => db.rawPrepare(`UPDATE invite_codes SET code=? WHERE id=?`).run(code, id);
  
  if (!db.getInviteCode('STU-PRIYA1')) {
    const inv = db.createInviteCode({ schoolId:school.id, classId:cls.id, role:'student', createdBy:teacher.id, maxUses:1 });
    setCode(inv.id, 'STU-PRIYA1');
  }
  if (!db.getInviteCode('STU-GEN01')) {
    const inv = db.createInviteCode({ schoolId:school.id, classId:cls.id, role:'student', createdBy:teacher.id, maxUses:30 });
    setCode(inv.id, 'STU-GEN01');
  }
  if (!db.getInviteCode('TEA-GEN01')) {
    const inv = db.createInviteCode({ schoolId:school.id, classId:cls.id, role:'teacher', createdBy:teacher.id, maxUses:5 });
    setCode(inv.id, 'TEA-GEN01');
  }

  console.log('\n' + '='.repeat(60));
  console.log('📋 DEMO CREDENTIALS');
  console.log('='.repeat(60));
  console.log(`Coordinator ID: ${coordinator.id}`);
  console.log(`Teacher ID:     ${teacher.id}`);
  console.log(`Student 1 ID:   ${s1.id}`);
  console.log(`Student 2 ID:   ${s2.id}`);
  console.log(`\nInvite Codes:`);
  console.log(`  Students (general): STU-GEN01`);
  console.log(`  Priya (personal):   STU-PRIYA1`);
  console.log(`  Teachers:           TEA-GEN01`);
  console.log('\nOpen Teacher UI: frontend/teacher/index.html?user=' + teacher.id);
  console.log('Open Student UI: frontend/student/index.html?user=' + s1.id);
  console.log('='.repeat(60));
  console.log('✅ Seed complete!');
}

seed().catch(err => { console.error('❌ Seed failed:', err); process.exit(1); });
