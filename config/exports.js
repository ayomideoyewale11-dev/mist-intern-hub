// Builds the PDF report behind the "Download" links on the Archive and
// intern history pages. Kept out of the routes so both pages produce
// exactly the same layout.
const PDFDocument = require("pdfkit");
const { taskStatus } = require("./taskStatus");
const { fmt } = require("./format");
const STATUS_WORD = {
  open: "Open",
  overdue: "Overdue",
  submitted: "Submitted",
};
const MINISTRY = "Lagos State Ministry of Innovation, Science & Technology";
const WIN_ANSI_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

// PDFKit's built-in fonts use WinAnsi. Keep supported characters intact and
// render other code points visibly as ASCII so user-entered Unicode cannot
// break PDF generation or silently become an unsupported glyph.
function pdfText(value) {
  return Array.from(String(value ?? ""), (character) => {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === 9 ||
      codePoint === 10 ||
      codePoint === 13 ||
      (codePoint >= 0x20 && codePoint <= 0x7e) ||
      (codePoint >= 0xa0 && codePoint <= 0xff) ||
      WIN_ANSI_EXTRAS.has(codePoint)
    ) {
      return character;
    }
    return `[U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}]`;
  }).join("");
}

// Oldest-due first inside each intern, interns A to Z.
function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const an = (a.assignedTo?.name || "").toLowerCase();
    const bn = (b.assignedTo?.name || "").toLowerCase();
    return an.localeCompare(bn) || new Date(a.dueDate) - new Date(b.dueDate);
  });
}

function countStatuses(tasks) {
  const c = { open: 0, overdue: 0, submitted: 0 };
  tasks.forEach((t) => {
    c[taskStatus(t)] += 1;
  });
  return c;
}

function summaryLine(tasks) {
  const c = countStatuses(tasks);
  const n = tasks.length;
  return `${n} ${n === 1 ? "task" : "tasks"}: ${c.open} open, ${c.overdue} overdue, ${c.submitted} submitted`;
}

/* PDF report: a header, a summary line, then one table per intern.
   `groups` is [{ name, email, tasks }]. */
function streamReportPdf(res, { filename, title, subtitle, groups }) {
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true });
  doc.pipe(res);

  const left = 40;
  const width = doc.page.width - 80;
  const cols = [
    { label: "Task", w: Math.round(width * 0.42) },
    { label: "Due date", w: Math.round(width * 0.16) },
    { label: "Status", w: Math.round(width * 0.16) },
  ];
  cols.push({
    label: "Submitted",
    w: width - cols.reduce((s, c) => s + c.w, 0),
  });
  const bottom = () => doc.page.height - 60;

  const allTasks = groups.flatMap((g) => g.tasks);

  // ----- header -----
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#6B6B6B")
    .text(MINISTRY, left, 40, { width });
  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fillColor("#000")
    .text(pdfText(title), { width });
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#6B6B6B")
    .text(`${pdfText(subtitle)}   |   Generated ${fmt(new Date())}`, { width });
  doc.moveDown(0.6);
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor("#000")
    .text(summaryLine(allTasks), { width });
  doc.moveDown(0.8);

  const drawTableHead = () => {
    const y = doc.y;
    doc.rect(left, y, width, 20).fill("#000");
    let x = left;
    cols.forEach((c) => {
      doc
        .font("Helvetica-Bold")
        .fontSize(9)
        .fillColor("#fff")
        .text(c.label, x + 6, y + 6, { width: c.w - 12, lineBreak: false });
      x += c.w;
    });
    doc.y = y + 20;
  };

  if (!allTasks.length) {
    doc
      .font("Helvetica")
      .fontSize(11)
      .fillColor("#6B6B6B")
      .text("No tasks to show.");
  }

  groups.forEach((g) => {
    if (!g.tasks.length) return;
    if (doc.y + 70 > bottom()) doc.addPage();

    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor("#000")
      .text(pdfText(g.name || "Unknown"), left, doc.y, { width });
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#6B6B6B")
      .text(`${g.email ? `${pdfText(g.email)}   |   ` : ""}${summaryLine(g.tasks)}`, {
        width,
      });
    doc.moveDown(0.4);
    drawTableHead();

    g.tasks.forEach((t, i) => {
      const submitted = Boolean(t.submission?.submittedAt);
      const status = taskStatus(t);
      const cells = [
        pdfText(t.title),
        fmt(t.dueDate),
        STATUS_WORD[status],
        submitted ? fmt(t.submission.submittedAt) : "-",
      ];
      const extra = [];
      if (t.submission?.feedback?.text)
        extra.push(pdfText(`Feedback: ${t.submission.feedback.text}`));
      if (t.submission?.note) extra.push(pdfText(`Note: ${t.submission.note}`));
      if (t.submission?.link) extra.push(pdfText(`Link: ${t.submission.link}`));

      doc.font("Helvetica").fontSize(10);
      const heights = cells.map((c, k) =>
        doc.heightOfString(String(c), { width: cols[k].w - 12 }),
      );
      doc.fontSize(9);
      const extraH = extra.length
        ? doc.heightOfString(extra.join("\n"), { width: width - 12 }) + 4
        : 0;
      const rowH = Math.max(...heights) + 12 + extraH;

      if (doc.y + rowH > bottom()) {
        doc.addPage();
        drawTableHead();
      }

      const y = doc.y;
      if (i % 2 === 1) doc.rect(left, y, width, rowH).fill("#F6F2F0");
      let x = left;
      cells.forEach((c, k) => {
        const colour =
          k === 2
            ? status === "overdue"
              ? "#A8391E"
              : status === "submitted"
                ? "#137333"
                : "#000"
            : "#000";
        doc
          .font(
            k === 0
              ? "Helvetica-Bold"
              : k === 2
                ? "Helvetica-Bold"
                : "Helvetica",
          )
          .fontSize(10)
          .fillColor(colour)
          .text(String(c), x + 6, y + 6, { width: cols[k].w - 12 });
        x += cols[k].w;
      });
      if (extra.length) {
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor("#444")
          .text(extra.join("\n"), left + 6, y + 6 + Math.max(...heights) + 2, {
            width: width - 12,
          });
      }
      doc
        .moveTo(left, y + rowH)
        .lineTo(left + width, y + rowH)
        .lineWidth(0.5)
        .strokeColor("#D9D2CF")
        .stroke();
      doc.y = y + rowH;
    });
    doc.moveDown(1.2);
  });

  // ----- footer on every page -----
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0;
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#6B6B6B")
      .text(
        `${MINISTRY}   |   Page ${i + 1} of ${range.count}`,
        left,
        doc.page.height - 36,
        { width, align: "center", lineBreak: false },
      );
  }

  doc.end();
}

module.exports = { streamReportPdf, sortTasks, pdfText };
