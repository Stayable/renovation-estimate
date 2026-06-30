import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const SS_BASE  = "https://api.smartsheet.com/2.0";
const SS_TOKEN = process.env.SMARTSHEET_TOKEN;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!SS_TOKEN) return res.status(500).json({ error: "Server misconfigured: SMARTSHEET_TOKEN is not set." });

  try {
    const { sheetId, rows, report } = req.body;

    // 1. Write the estimate rows to Smartsheet.
    const ssRes = await fetch(`${SS_BASE}/sheets/${sheetId}/rows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SS_TOKEN}`
      },
      body: JSON.stringify(rows)
    });

    const data = await ssRes.json();

    if (!ssRes.ok) {
      return res.status(ssRes.status).json({ error: data.message || "Smartsheet error", detail: data });
    }

    const created    = Array.isArray(data.result) ? data.result : [data.result];
    const count      = created.length;
    const firstRowId = created[0] && created[0].id;

    // 2. Build a PDF of the questions + answers and attach it to the first row.
    let attached = false, attachError = null;
    if (report && firstRowId) {
      try {
        const pdfBytes = await buildEstimatePdf(report);
        const filename = pdfFilename(report);
        const attRes = await fetch(`${SS_BASE}/sheets/${sheetId}/rows/${firstRowId}/attachments`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${SS_TOKEN}`,
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${filename}"`
          },
          body: Buffer.from(pdfBytes)
        });
        if (attRes.ok) {
          attached = true;
        } else {
          const aerr = await attRes.json().catch(() => ({}));
          attachError = aerr.message || `Attachment failed (HTTP ${attRes.status})`;
        }
      } catch (e) {
        attachError = e.message;
      }
    }

    return res.status(200).json({
      success: true,
      resultCode: data.resultCode,
      count,
      attached,
      attachError
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// pdf-lib's standard Helvetica only encodes WinAnsi (CP1252). Keep ASCII +
// Latin-1 + the CP1252 punctuation block; replace anything else (emoji, CJK)
// with "?" so an odd name can't throw and kill the attachment.
const WINANSI_EXTRA = new Set([
  0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022,
  0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178
]);

function clean(s) {
  return Array.from(String(s == null ? "" : s)).map(ch => {
    const c = ch.codePointAt(0);
    if (c === 0x09 || c === 0x0A || c === 0x0D) return " ";
    if (c >= 0x20 && c <= 0x7E) return ch;
    if (c >= 0xA0 && c <= 0xFF) return ch;
    if (WINANSI_EXTRA.has(c)) return ch;
    return "?";
  }).join("");
}

function pdfFilename(report) {
  const safe = s => String(s || "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "room";
  const datePart = (report.date || "").replace(/-/g, "") || "nodate";
  return `CrewTimeEstimate_${safe(report.property)}_${datePart}.pdf`;
}

async function buildEstimatePdf(report) {
  const pdf  = await PDFDocument.create();
  const page = pdf.addPage([612, 792]); // US Letter
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const ink    = rgb(0.102, 0.102, 0.094);
  const muted  = rgb(0.533, 0.529, 0.502);
  const line   = rgb(0.784, 0.776, 0.741);
  const accent = rgb(0.094, 0.373, 0.647);

  const M     = 50;
  const right = 612 - M;
  let   y     = 792 - M;

  const txt = (s, x, yy, size, f = font, color = ink) =>
    page.drawText(clean(s), { x, y: yy, size, font: f, color });

  const txtR = (s, xRight, yy, size, f = font, color = ink) => {
    const str = clean(s);
    const w = f.widthOfTextAtSize(str, size);
    page.drawText(str, { x: xRight - w, y: yy, size, font: f, color });
  };

  const rule = yy => page.drawLine({
    start: { x: M, y: yy }, end: { x: right, y: yy }, thickness: 0.5, color: line
  });

  // Header
  txt("STAYABLE — ROOM RENOVATION", M, y, 9, bold, muted);
  y -= 22;
  txt("Crew Time Estimate", M, y, 20, bold, ink);
  y -= 30;

  // Meta block
  const metaLine = (label, value) => {
    txt(label, M, y, 9, bold, muted);
    txt(value || "—", M + 120, y, 11, font, ink);
    y -= 19;
  };
  metaLine("CREW / ESTIMATOR", report.crew);
  metaLine("PROPERTY / ROOM", report.property);
  metaLine("DATE", report.date);
  metaLine("GENERATED", new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC");
  y -= 6;

  rule(y); y -= 18;

  // Table header
  const cx = { seq: M, task: M + 28, est: 420, hrs: right };
  txt("#",        cx.seq,  y, 8, bold, muted);
  txt("TASK",     cx.task, y, 8, bold, muted);
  txt("ESTIMATE", cx.est,  y, 8, bold, muted);
  txtR("HOURS",   cx.hrs,  y, 8, bold, muted);
  y -= 7;
  rule(y); y -= 16;

  // Task rows (the "questions" + the crew's "answers")
  const tasks = Array.isArray(report.tasks) ? report.tasks : [];
  tasks.forEach(t => {
    const estimate = (t.estimate != null && t.estimate !== "")
      ? `${t.estimate} ${t.unit || ""}`.trim()
      : "—";
    txt(t.seq,  cx.seq,  y, 10, font, muted);
    txt(t.name, cx.task, y, 10, font, ink);
    txt(estimate, cx.est, y, 10, font, ink);
    txtR((t.hours != null && t.hours !== "") ? t.hours : "—", cx.hrs, y, 10, font, ink);
    y -= 17;
  });

  y -= 4;
  rule(y); y -= 22;

  // Totals
  txt("TOTAL HOURS", M, y, 9, bold, muted);
  txtR(`${report.totalHours} hrs`, 290, y, 13, bold, accent);
  txt("ESTIMATED DAYS", 330, y, 9, bold, muted);
  txtR(`${report.totalDays} days`, right, y, 13, bold, accent);

  // Footer
  txt("Generated automatically from the Stayable Room Renovation crew-time quiz.",
      M, 40, 8, font, muted);

  return await pdf.save();
}
