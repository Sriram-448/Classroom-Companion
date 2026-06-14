require('dotenv').config();
const { initializeDatabase } = require('../models/database');
const db = require('../services/db-service');

async function run() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log("Usage: node scripts/manage-student.js <student_name_or_id> <new_class_name>");
    process.exit(1);
  }

  const studentSearch = args[0];
  const newClassName = args[1];

  await initializeDatabase();

  // 1. Find the student
  const student = db.getUserById(studentSearch);
  if (!student || student.role !== 'student') {
    console.error(`❌ Student "${studentSearch}" not found.`);
    process.exit(1);
  }

  console.log(`🔍 Found student: ${student.name} (ID: ${student.id})`);

  // 2. Unlink Telegram
  db.rawPrepare(`UPDATE users SET telegram_id = NULL, telegram_handle = NULL WHERE id = ?`).run(student.id);
  console.log(`✅ Unlinked student from Telegram.`);

  // 3. Find or Create the Class in the same school
  let cls = db.rawPrepare(`SELECT * FROM classes WHERE school_id = ? AND name = ?`).get(student.school_id, newClassName);
  if (!cls) {
    console.log(`Creating new class "${newClassName}"...`);
    cls = db.createClass(student.school_id, newClassName);
  }
  console.log(`🏫 Target Class: ${cls.name} (ID: ${cls.id})`);

  // 4. Remove student from old classes
  db.rawPrepare(`DELETE FROM student_classes WHERE student_id = ?`).run(student.id);
  console.log(`✅ Removed student from all previous classes.`);

  // 5. Add student to new class
  db.addStudentToClass(student.id, cls.id);
  console.log(`✅ Added ${student.name} to ${cls.name}!`);

  console.log(`\n🎉 Success! Student is ready to link again using a new Class invite code if desired.`);
}

run().catch(err => {
  console.error("Error running script:", err);
  process.exit(1);
});
