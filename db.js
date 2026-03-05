// ============================================
// db.js - Database Layer
// ============================================

const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host:             "localhost",
  user:             "root",
  password:         "k123",        // ← put your MySQL password here
  database:         "exam_seating",
  waitForConnections: true,
  connectionLimit:  10,
  queueLimit:       0,
});

pool.getConnection()
  .then(conn => { console.log("✅ MySQL connected"); conn.release(); })
  .catch(err  => { console.error("❌ MySQL error:", err.message); process.exit(1); });

// ============================================
// HALLS
// ============================================
const upsertHall = async (hall_id, hall_name, capacity, total_rows, total_cols) => {
  const [r] = await pool.execute(
    `INSERT INTO halls (hall_id, hall_name, capacity, total_rows, total_cols)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       hall_name=VALUES(hall_name), capacity=VALUES(capacity),
       total_rows=VALUES(total_rows), total_cols=VALUES(total_cols)`,
    [hall_id, hall_name, capacity, total_rows, total_cols]
  );
  return r;
};

const getAllHalls = async () => {
  const [r] = await pool.execute(`SELECT * FROM halls ORDER BY hall_id`);
  return r;
};

const getHallById = async (hall_id) => {
  const [r] = await pool.execute(`SELECT * FROM halls WHERE hall_id=?`, [hall_id]);
  return r[0] || null;
};

const deleteHall = async (hall_id) => {
  const [r] = await pool.execute(`DELETE FROM halls WHERE hall_id=?`, [hall_id]);
  return r;
};

const getTotalCapacity = async () => {
  const [r] = await pool.execute(`SELECT COALESCE(SUM(capacity),0) AS total FROM halls`);
  return r[0].total;
};

// ============================================
// STUDENTS
// ============================================
const insertStudent = async (student_id, student_name, subject_code) => {
  const [r] = await pool.execute(
    `INSERT IGNORE INTO students (student_id, student_name, subject_code) VALUES (?,?,?)`,
    [student_id, student_name, subject_code]
  );
  return { inserted: r.affectedRows > 0 };
};

const bulkInsertStudents = async (students) => {
  let inserted = 0, duplicates = 0;
  const errors = [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const s of students) {
      const [r] = await conn.execute(
        `INSERT IGNORE INTO students (student_id, student_name, subject_code) VALUES (?,?,?)`,
        [s.student_id, s.student_name, s.subject_code]
      );
      if (r.affectedRows > 0) inserted++;
      else { duplicates++; errors.push(`Duplicate: ${s.student_id}`); }
    }
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
  return { inserted, duplicates, errors };
};

const getAllStudents = async () => {
  const [r] = await pool.execute(`SELECT * FROM students ORDER BY subject_code, student_id`);
  return r;
};

const getStudentsGroupedBySubject = async () => {
  const [rows] = await pool.execute(
    `SELECT subject_code, student_id, student_name FROM students ORDER BY subject_code, student_id`
  );
  const grouped = {};
  for (const s of rows) {
    if (!grouped[s.subject_code]) grouped[s.subject_code] = [];
    grouped[s.subject_code].push(s);
  }
  return grouped;
};

const getTotalStudentCount = async () => {
  const [r] = await pool.execute(`SELECT COUNT(*) AS total FROM students`);
  return r[0].total;
};

const getStudentCountBySubject = async () => {
  const [r] = await pool.execute(
    `SELECT subject_code, COUNT(*) AS total FROM students GROUP BY subject_code ORDER BY subject_code`
  );
  return r;
};

const clearStudents = async () => {
  const [r] = await pool.execute(`DELETE FROM students`);
  return r;
};

// ============================================
// SEAT ALLOCATIONS
// ============================================
const bulkInsertAllocations = async (allocations) => {
  if (!allocations.length) return { inserted: 0 };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const a of allocations) {
      await conn.execute(
        `INSERT INTO seat_allocations (student_id, hall_id, seat_row, seat_col, seat_label)
         VALUES (?,?,?,?,?)`,
        [a.student_id, a.hall_id, a.seat_row, a.seat_col, a.seat_label]
      );
    }
    await conn.commit();
    return { inserted: allocations.length };
  } catch (err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
};

const getAllAllocations = async () => {
  const [r] = await pool.execute(`SELECT * FROM v_seating_chart`);
  return r;
};

const getAllocationsByHall = async (hall_id) => {
  const [r] = await pool.execute(
    `SELECT * FROM v_seating_chart WHERE hall_id=? ORDER BY seat_row, seat_col`, [hall_id]
  );
  return r;
};

const clearAllocations = async () => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(`DELETE FROM unallocated_students`);
    await conn.execute(`DELETE FROM seat_allocations`);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
};

// ============================================
// UNALLOCATED STUDENTS
// ============================================
const bulkInsertUnallocated = async (students) => {
  if (!students.length) return;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const s of students) {
      await conn.execute(
        `INSERT IGNORE INTO unallocated_students (student_id, student_name, subject_code, reason)
         VALUES (?,?,?,?)`,
        [s.student_id, s.student_name || '', s.subject_code || '', s.reason || 'Capacity overflow']
      );
    }
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
};

const getUnallocatedStudents = async () => {
  const [r] = await pool.execute(
    `SELECT student_id, student_name, subject_code, reason, logged_at
     FROM unallocated_students ORDER BY subject_code, student_id`
  );
  return r;
};

// ============================================
// REPORTS
// ============================================
const getSubjectPerHall = async () => {
  const [r] = await pool.execute(`SELECT * FROM v_subject_per_hall`);
  return r;
};

const getHallSummary = async () => {
  const [r] = await pool.execute(`SELECT * FROM v_hall_summary`);
  return r;
};

// ============================================
// ALLOCATION LOGS
// ============================================
const insertAllocationLog = async (log) => {
  const [r] = await pool.execute(
    `INSERT INTO allocation_logs
       (total_students, total_allocated, total_unallocated, constraint_violations, duration_ms, status, message)
     VALUES (?,?,?,?,?,?,?)`,
    [log.total_students, log.total_allocated, log.total_unallocated,
     log.constraint_violations || 0, log.duration_ms, log.status, log.message || null]
  );
  return r;
};

const getLatestLog = async () => {
  const [r] = await pool.execute(`SELECT * FROM allocation_logs ORDER BY run_at DESC LIMIT 1`);
  return r[0] || null;
};

const getAllLogs = async () => {
  const [r] = await pool.execute(`SELECT * FROM allocation_logs ORDER BY run_at DESC`);
  return r;
};

// ============================================
// USERS
// ============================================
const getAllUsers = async () => {
  const [r] = await pool.execute(
    `SELECT id, username, role, created_at FROM users ORDER BY id DESC`
  );
  return r;
};

const getUserByUsername = async (username) => {
  const [r] = await pool.execute(`SELECT * FROM users WHERE username=?`, [username]);
  return r[0] || null;
};

const createUser = async (username, password, role) => {
  const [r] = await pool.execute(
    `INSERT INTO users (username, password, role) VALUES (?,?,?)`,
    [username, password, role]
  );
  return r;
};

const updateUserPassword = async (username, newPassword) => {
  const [r] = await pool.execute(
    `UPDATE users SET password=? WHERE username=?`, [newPassword, username]
  );
  return r;
};

const deleteUser = async (id) => {
  const [r] = await pool.execute(`DELETE FROM users WHERE id=?`, [id]);
  return r;
};

// ============================================
// EXPORTS
// ============================================
module.exports = {
  pool,
  upsertHall, getAllHalls, getHallById, deleteHall, getTotalCapacity,
  insertStudent, bulkInsertStudents, getAllStudents, getStudentsGroupedBySubject,
  getTotalStudentCount, getStudentCountBySubject, clearStudents,
  bulkInsertAllocations, getAllAllocations, getAllocationsByHall, clearAllocations,
  bulkInsertUnallocated, getUnallocatedStudents,
  getSubjectPerHall, getHallSummary,
  insertAllocationLog, getLatestLog, getAllLogs,
  getAllUsers, getUserByUsername, createUser, deleteUser, updateUserPassword,
};