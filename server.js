// ============================================
// server.js — Exam Alloc API Server
// ============================================

const express     = require("express");
const cors        = require("cors");
const Papa        = require("papaparse");
const fastcsv     = require("fast-csv");
const PDFDocument = require("pdfkit");
const path        = require("path");
const fs          = require("fs");
const db          = require("./db");
const { runAllocationAlgorithm } = require("./allocate");


// ── Admin credentials (can be overridden via reset) ──────────────
const ADMIN_CONFIG_PATH = path.join(__dirname, 'admin.config.json');
function getAdminCreds() {
  try {
    if (fs.existsSync(ADMIN_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(ADMIN_CONFIG_PATH, 'utf8'));
    }
  } catch (e) {}
  return { username: 'admin', password: 'admin123' };
}
const app  = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "Main")));

// ─── CSV Parser Helper ───────────────────────
// Cleans and parses any CSV string robustly
function parseCSV(raw) {
  const cleaned = raw
    .replace(/^\uFEFF/, "")       // remove BOM (Excel files)
    .replace(/\r\n/g, "\n")       // Windows CRLF
    .replace(/\r/g, "\n")         // old Mac CR
    .trim();

  return Papa.parse(cleaned, {
    header:          true,
    skipEmptyLines:  true,
    transformHeader: h => h.trim().toLowerCase().replace(/\s+/g, "_"),
    transform:       v => v.trim(),
  });
}

// ============================================
// HALL ROUTES
// ============================================

app.get("/api/halls", async (req, res) => {
  try {
    res.json({ success: true, data: await db.getAllHalls() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post("/api/halls", async (req, res) => {
  try {
    const { hall_id, hall_name, capacity, total_rows, total_cols } = req.body;
    if (!hall_id || !capacity || !total_rows || !total_cols)
      return res.status(400).json({ success: false, message: "hall_id, capacity, total_rows, total_cols are required" });
    if (parseInt(total_rows) * parseInt(total_cols) < parseInt(capacity))
      return res.status(400).json({ success: false, message: "total_rows × total_cols must be ≥ capacity" });
    await db.upsertHall(hall_id.trim(), (hall_name || hall_id).trim(), parseInt(capacity), parseInt(total_rows), parseInt(total_cols));
    res.json({ success: true, message: `Hall ${hall_id} saved` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post("/api/halls/csv", async (req, res) => {
  try {
    const raw = req.body.csvData;
    if (!raw || !raw.trim())
      return res.status(400).json({ success: false, message: "No CSV data received." });

    const { data, meta, errors: parseErr } = parseCSV(raw);
    console.log(`[halls/csv] rows=${data.length} headers=${meta.fields}`);

    if (!data.length)
      return res.status(400).json({ success: false, message: `0 rows parsed. Your CSV headers must be: hall_id, hall_name, capacity, total_rows, total_cols. Detected: ${meta.fields}` });

    const halls = [], errors = [];
    for (const row of data) {
      const capacity   = parseInt(row.capacity);
      const total_rows = parseInt(row.total_rows);
      const total_cols = parseInt(row.total_cols);
      const hall_id    = (row.hall_id || "").trim();
      if (!hall_id || isNaN(capacity) || isNaN(total_rows) || isNaN(total_cols)) {
        errors.push(`Skipped invalid row: ${JSON.stringify(row)}`); continue;
      }
      halls.push({ hall_id, hall_name: (row.hall_name || hall_id).trim(), capacity, total_rows, total_cols });
    }

    for (const h of halls)
      await db.upsertHall(h.hall_id, h.hall_name, h.capacity, h.total_rows, h.total_cols);

    res.json({ success: true, message: `${halls.length} halls uploaded successfully`, errors });
  } catch (err) {
    console.error("Hall CSV error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete("/api/halls/:hall_id", async (req, res) => {
  try {
    await db.deleteHall(req.params.hall_id);
    res.json({ success: true, message: `Hall ${req.params.hall_id} deleted` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ============================================
// STUDENT ROUTES
// ============================================

app.get("/api/students", async (req, res) => {
  try {
    const [students, total, bySubject] = await Promise.all([
      db.getAllStudents(), db.getTotalStudentCount(), db.getStudentCountBySubject()
    ]);
    res.json({ success: true, total, bySubject, data: students });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post("/api/students", async (req, res) => {
  try {
    const { student_id, student_name, subject_code } = req.body;
    if (!student_id || !student_name || !subject_code)
      return res.status(400).json({ success: false, message: "student_id, student_name, subject_code required" });
    const result = await db.insertStudent(student_id.trim(), student_name.trim(), subject_code.trim().toUpperCase());
    if (!result.inserted)
      return res.status(409).json({ success: false, message: `Duplicate student ID: ${student_id}` });
    res.json({ success: true, message: "Student added" });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post("/api/students/csv", async (req, res) => {
  try {
    const raw = req.body.csvData;
    if (!raw || !raw.trim())
      return res.status(400).json({ success: false, message: "No CSV data received." });

    const { data, meta } = parseCSV(raw);
    console.log(`[students/csv] rows=${data.length} headers=${meta.fields}`);

    if (!data.length)
      return res.status(400).json({ success: false, message: `0 rows parsed. Your CSV headers must be: student_id, student_name, subject_code. Detected: ${meta.fields}` });

    const students = [], parseErrors = [];
    for (const row of data) {
      const sid  = (row.student_id   || "").trim();
      const name = (row.student_name || "").trim();
      const sub  = (row.subject_code || "").trim();
      if (!sid || !name || !sub) { parseErrors.push(`Missing fields: ${JSON.stringify(row)}`); continue; }
      students.push({ student_id: sid, student_name: name, subject_code: sub.toUpperCase() });
    }

    if (!students.length)
      return res.status(400).json({ success: false, message: `No valid rows found. Detected headers: ${meta.fields}. Required: student_id, student_name, subject_code` });

    const totalCapacity = await db.getTotalCapacity();
    const warning = students.length > totalCapacity
      ? `Warning: ${students.length} students exceed total hall capacity of ${totalCapacity}`
      : null;

    const result = await db.bulkInsertStudents(students);
    res.json({
      success:     true,
      message:     `${result.inserted} students uploaded, ${result.duplicates} duplicates skipped`,
      warning,
      parseErrors,
    });
  } catch (err) {
    console.error("Student CSV error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete("/api/students", async (req, res) => {
  try {
    await db.clearAllocations();
    await db.clearStudents();
    res.json({ success: true, message: "All students and allocations cleared" });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
// ============================================
// AUTH ROUTE
// ============================================
app.post("/api/login", async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password || !role)
      return res.status(400).json({ success: false, message: "username, password, role required" });

    // Admin is hardcoded — not in users table
    if (role === "examination_branch") {
      const adminCreds = getAdminCreds();
    if (username === adminCreds.username && password === adminCreds.password) {
        return res.json({ success: true, role: "examination_branch", username: "admin", redirect: "admin_dashboard.html" });
      }
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    // Coordinator / Invigilator — check users table
    const user = await db.getUserByUsername(username.trim());
    if (!user || user.password !== password || user.role !== role) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const redirect = role === "coordinator" ? "coordinator.html" : "invig_dashboard.html";
    res.json({ success: true, role: user.role, username: user.username, redirect });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================
// LOGIN ROUTE
// ============================================
app.post("/api/login", async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password || !role)
      return res.status(400).json({ success: false, message: "username, password, role required" });

    const user = await db.getUserByUsername(username.trim());

    if (!user || user.password !== password || user.role !== role) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    res.json({ success: true, message: "Login successful", role: user.role, username: user.username });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================
// USER ROUTES
// ============================================

// Get all users
app.get("/api/users", async (req, res) => {
  try {
    const users = await db.getAllUsers();
    res.json({ success: true, data: users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Create user
app.post("/api/users", async (req, res) => {
  try {
    const { username, password, role } = req.body;

    if (!username || !password || !role)
      return res.status(400).json({ success: false, message: "username, password, role required" });

    if (!["coordinator","invigilator"].includes(role))
      return res.status(400).json({ success: false, message: "role must be coordinator or invigilator" });

    if (username.length < 3)
      return res.status(400).json({ success: false, message: "Username must be at least 3 characters" });

    if (password.length < 6)
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });

    const existing = await db.getUserByUsername(username.trim());
    if (existing)
      return res.status(409).json({ success: false, message: "Username already exists" });

    await db.createUser(username.trim(), password, role);
    res.json({ success: true, message: "User created successfully" });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Reset admin password (admin is hardcoded — saved to admin.config.json)
app.post("/api/reset-admin-password", async (req, res) => {
  try {
    const { username, newPassword } = req.body;
    if (!username || !newPassword)
      return res.status(400).json({ success: false, message: "username and newPassword required" });
    if (username.toLowerCase() !== "admin")
      return res.status(400).json({ success: false, message: "This endpoint is for admin only" });
    if (newPassword.length < 6)
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    fs.writeFileSync(ADMIN_CONFIG_PATH, JSON.stringify({ username: "admin", password: newPassword }, null, 2));
    res.json({ success: true, message: "Admin password reset successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Reset password
app.post("/api/reset-password", async (req, res) => {
  try {
    const { username, newPassword } = req.body;
    if (!username || !newPassword)
      return res.status(400).json({ success: false, message: "username and newPassword required" });
    if (newPassword.length < 6)
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    const user = await db.getUserByUsername(username.trim());
    if (!user)
      return res.status(404).json({ success: false, message: "User not found" });
    await db.updateUserPassword(username.trim(), newPassword);
    res.json({ success: true, message: "Password reset successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Delete user
app.delete("/api/users/:id", async (req, res) => {
  try {
    const result = await db.deleteUser(parseInt(req.params.id));
    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, message: "User not found" });
    res.json({ success: true, message: "User deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// ============================================
// ALLOCATION ROUTES
// ============================================

app.post("/api/allocate", async (req, res) => {
  try {
    const startTime     = Date.now();
    const totalStudents = await db.getTotalStudentCount();
    if (!totalStudents) return res.status(400).json({ success: false, message: "No students found." });
    const halls = await db.getAllHalls();
    if (!halls.length) return res.status(400).json({ success: false, message: "No halls found." });

    await db.clearAllocations();
    const groupedStudents = await db.getStudentsGroupedBySubject();
    const { allocations, unallocated, violations } = runAllocationAlgorithm(groupedStudents, halls);

    await db.bulkInsertAllocations(allocations);
    if (unallocated.length) await db.bulkInsertUnallocated(unallocated);

    const duration = Date.now() - startTime;
    const status   = unallocated.length === 0 ? "SUCCESS" : "PARTIAL";
    await db.insertAllocationLog({ total_students: totalStudents, total_allocated: allocations.length, total_unallocated: unallocated.length, constraint_violations: violations, duration_ms: duration, status, message: `Done in ${duration}ms` });

    res.json({ success: true, total_students: totalStudents, total_allocated: allocations.length, total_unallocated: unallocated.length, constraint_violations: violations, duration_ms: duration, status });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get("/api/allocations", async (req, res) => {
  try { res.json({ success: true, data: await db.getAllAllocations() }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get("/api/allocations/hall/:hall_id", async (req, res) => {
  try {
    const hall = await db.getHallById(req.params.hall_id);
    if (!hall) return res.status(404).json({ success: false, message: "Hall not found" });
    const allocations = await db.getAllocationsByHall(req.params.hall_id);
    const grid = Array.from({ length: hall.total_rows }, (_, r) =>
      Array.from({ length: hall.total_cols }, (_, c) => {
        const s = allocations.find(a => a.seat_row === r+1 && a.seat_col === c+1);
        return s ? { occupied:true, student_id:s.student_id, student_name:s.student_name, subject_code:s.subject_code, seat_label:s.seat_label } : { occupied:false };
      })
    );
    res.json({ success: true, hall, grid });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get("/api/allocations/unallocated", async (req, res) => {
  try { const d = await db.getUnallocatedStudents(); res.json({ success:true, total:d.length, data:d }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get("/api/allocations/subject-distribution", async (req, res) => {
  try { res.json({ success: true, data: await db.getSubjectPerHall() }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get("/api/allocations/summary", async (req, res) => {
  try { res.json({ success: true, data: await db.getHallSummary() }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ============================================
// EXPORT ROUTES
// ============================================
app.get("/api/export/pdf", async (req, res) => {
  try {
    const halls = await db.getAllHalls();
    const unallocated = await db.getUnallocatedStudents();
    const logs = await db.getLatestLog();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Seating_Chart_${Date.now()}.pdf`
    );

    const doc = new PDFDocument({
      margin: 30,
      size: "A4",
      layout: "landscape",
    });

    doc.pipe(res);

    const LEFT = 30;
    const BOTTOM = 30;
    let y = LEFT;

    function ensureSpace(h) {
      if (y + h > doc.page.height - BOTTOM) {
        doc.addPage();
        y = LEFT;
      }
    }

    function truncate(str, max) {
      return str.length > max ? str.slice(0, max - 1) + "…" : str;
    }

    // ===== HEADER =====

    doc.fontSize(16)
      .font("Helvetica-Bold")
      .text("Exam Seating Chart", LEFT, y);
    y += 20;

    doc.fontSize(8)
      .font("Helvetica")
      .text(`Generated: ${new Date().toLocaleString()}`, LEFT, y);
    y += 12;

    if (logs) {
      doc.text(
        `Students: ${logs.total_students} | Allocated: ${logs.total_allocated} | Unallocated: ${logs.total_unallocated} | Violations: ${logs.constraint_violations}`,
        LEFT,
        y
      );
      y += 15;
    }

    doc.moveTo(LEFT, y).lineTo(doc.page.width - LEFT, y).stroke();
    y += 15;

    // ===== HALLS =====

    let isFirstHall = true;

for (const hall of halls) {

  // 👉 Every hall starts on new page
  if (!isFirstHall) {
    doc.addPage();
    y = LEFT;
  }
  isFirstHall = false;

  const allocs = await db.getAllocationsByHall(hall.hall_id);

  doc.fontSize(14)
    .font("Helvetica-Bold")
    .text(`Hall: ${hall.hall_id} (${hall.hall_name})`, LEFT, y);
  y += 16;

  doc.fontSize(9)
    .font("Helvetica")
    .text(
      `Capacity: ${hall.capacity} | Rows: ${hall.total_rows} | Cols: ${hall.total_cols} | Filled: ${allocs.length}`,
      LEFT,
      y
    );
  y += 20;

  const seatMap = {};
  for (const a of allocs) {
    seatMap[`${a.seat_row}-${a.seat_col}`] = a;
  }

  const LABEL_W = 20;
  const CELL_H = 28;
  const usableWidth = doc.page.width - LEFT * 2 - LABEL_W - 2;
  const CELL_W = Math.floor(usableWidth / hall.total_cols);

  for (let r = 1; r <= hall.total_rows; r++) {

    doc.fontSize(6)
      .font("Helvetica-Bold")
      .text(`R${r}`, LEFT, y + 10, {
        width: LABEL_W,
        align: "right",
      });

    for (let c = 1; c <= hall.total_cols; c++) {
      const x = LEFT + LABEL_W + 2 + (c - 1) * CELL_W;
      const seat = seatMap[`${r}-${c}`];

      doc.rect(x, y, CELL_W - 2, CELL_H).stroke();

      if (seat) {
        doc.fontSize(6)
          .font("Helvetica-Bold")
          .text(seat.subject_code, x + 2, y + 2, {
            width: CELL_W - 4,
            align: "center",
          });

        doc.fontSize(5)
          .font("Helvetica")
          .text(seat.student_id, x + 2, y + 10, {
            width: CELL_W - 4,
            align: "center",
          });

        doc.fontSize(5)
          .text(seat.student_name.substring(0, 14), x + 2, y + 18, {
            width: CELL_W - 4,
            align: "center",
          });
      }
    }

    y += CELL_H + 2;

    // Prevent overflow inside same hall
    if (y + CELL_H > doc.page.height - 40) {
      doc.addPage();
      y = LEFT;
    }
  }
}


    // ===== UNALLOCATED =====

    if (unallocated.length > 0) {
      doc.addPage();
      y = LEFT;

      doc.fontSize(16)
        .font("Helvetica-Bold")
        .fill("red")
        .text("Unallocated Students", LEFT, y);

      doc.fill("black");
      y += 25;

      for (const u of unallocated) {
        ensureSpace(20);

        doc.fontSize(9)
          .font("Helvetica")
          .text(
            `${u.student_id} | ${u.student_name} | ${u.subject_code}`,
            LEFT,
            y
          );

        y += 20;
      }
    }

    doc.end();

  } catch (err) {
    console.error("PDF error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================
// LOGS
// ============================================
app.get("/api/logs", async (req, res) => {
  try { res.json({ success: true, data: await db.getAllLogs() }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ============================================
// PDF Color Helper
// ============================================
const PDF_COLORS = ["#FFDDC1","#C1E1FF","#C1FFCF","#FFF4C1","#EAC1FF","#FFC1C1","#C1FFF4","#FFE4C1"];
const colorMap = {};
let ci = 0;

function pdfColor(code) {
  if (!colorMap[code]) {
    colorMap[code] = PDF_COLORS[ci++ % PDF_COLORS.length];
  }
  return colorMap[code];
}

// ============================================
// START
// ============================================
app.listen(PORT, () => console.log(`🚀 Server running → http://localhost:${PORT}`));
module.exports = app;