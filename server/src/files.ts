import { inflateRawSync } from "node:zlib";
import { extractText as pdfText, getDocumentProxy } from "unpdf";
import { htmlToText } from "./web-tools.js";

/**
 * Files agents read and write: the text inside uploads (PDF, Word, Excel, PowerPoint, plain text,
 * HTML; images are kept for models that can see), and deliveries made as files (Markdown, Word, Excel,
 * CSV). Office files are ZIP packages of XML, read and written here without extra libraries.
 */

const MAX_TEXT = 400_000;

// ---------------------------------------------------------------- ZIP

/** The entries of a ZIP file (stored or deflated). */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, inflateRawSync(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer) {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A ZIP file of the given entries (stored, no compression: office files are small). */
export function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, e.data);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(e.data.length, 20);
    head.writeUInt32LE(e.data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += 30 + name.length + e.data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

// ---------------------------------------------------------------- reading

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

/** Word: paragraphs as lines, tables as "a | b | c" rows. */
function docxText(files: Map<string, Buffer>) {
  const xml = files.get("word/document.xml")?.toString("utf8") ?? "";
  const para = (p: string) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => unescapeXml(m[1])).join("");
  const body = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (tbl) =>
    [...tbl.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)]
      .map((tr) => `<w:p><w:t>${[...tr[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((tc) => tc[0].split("</w:p>").map(para).join(" ").trim()).join(" | ")}</w:t></w:p>`)
      .join(""),
  );
  return body
    .split("</w:p>")
    .map(para)
    .filter((l) => l.trim())
    .join("\n");
}

/** Excel: every sheet as CSV-like rows under its name. */
function xlsxText(files: Map<string, Buffer>) {
  const shared = [...(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1])).join(""),
  );
  const names = [...(files.get("xl/workbook.xml")?.toString("utf8") ?? "").matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => unescapeXml(m[1]));
  const sheets = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
  return sheets
    .map((key, i) => {
      const xml = files.get(key)!.toString("utf8");
      const rows = [...xml.matchAll(/<row[\s>][\s\S]*?<\/row>/g)].map((row) =>
        [...row[0].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
          .map((c) => {
            const type = /t="(\w+)"/.exec(c[1])?.[1];
            const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? "")?.[1] ?? "";
            if (type === "s") return shared[Number(v)] ?? "";
            if (type === "inlineStr") return unescapeXml(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(c[2] ?? "")?.[1] ?? "");
            return unescapeXml(v);
          })
          .join(", "),
      );
      return `## ${names[i] ?? `Sheet ${i + 1}`}\n${rows.join("\n")}`;
    })
    .join("\n\n");
}

/** PowerPoint: the text of each slide. */
function pptxText(files: Map<string, Buffer>) {
  return [...files.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]))
    .map((k, i) => `## Slide ${i + 1}\n${[...files.get(k)!.toString("utf8").matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unescapeXml(m[1])).join("\n")}`)
    .join("\n\n");
}

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const TEXT_TYPES = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "xml", "yaml", "yml", "log", "ini", "toml", "js", "ts", "py", "sql", "srt"]);

export const extOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";

/** A file's media type from its name. */
export function mimeOf(name: string) {
  const ext = extOf(name);
  return (
    IMAGE_TYPES[ext] ??
    {
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      csv: "text/csv",
      md: "text/markdown",
      html: "text/html",
      htm: "text/html",
      json: "application/json",
    }[ext] ??
    (TEXT_TYPES.has(ext) ? "text/plain" : "application/octet-stream")
  );
}

/**
 * What an agent can take in from a file: its text, or that it is an image (for models that can see).
 * Throws with a reason for files it can't read.
 */
export async function readFile(name: string, data: Buffer): Promise<{ text: string; image: boolean }> {
  const ext = extOf(name);
  if (IMAGE_TYPES[ext]) return { text: "", image: true };
  let text: string;
  if (ext === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const res = await pdfText(pdf, { mergePages: false });
    // PDFs often use Kangxi radicals (⽬) for the ideographs (目); searching needs the ideographs.
    text = (res.text as string[]).map((page, i) => `## Page ${i + 1}\n${page.trim().replace(/[\u2e80-\u2fdf]/g, (c) => c.normalize("NFKC"))}`).join("\n\n");
  } else if (ext === "docx") text = docxText(unzip(data));
  else if (ext === "xlsx") text = xlsxText(unzip(data));
  else if (ext === "pptx") text = pptxText(unzip(data));
  else if (ext === "html" || ext === "htm") {
    const page = htmlToText(data.toString("utf8"));
    text = `${page.title ? `# ${page.title}\n` : ""}${page.text}`;
  } else if (TEXT_TYPES.has(ext)) text = data.toString("utf8");
  else throw new Error(`can't read .${ext || "?"} files (PDF, Word, Excel, PowerPoint, text and images work)`);
  return { text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…(truncated)` : text, image: false };
}

// ---------------------------------------------------------------- writing

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Word runs for a line with **bold** and *italic*. */
function runs(text: string, base = "") {
  const out: string[] = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|`([^`]+)`)/g;
  let last = 0;
  const run = (t: string, props = "") => t && out.push(`<w:r>${base || props ? `<w:rPr>${base}${props}</w:rPr>` : ""}<w:t xml:space="preserve">${escapeXml(t)}</w:t></w:r>`);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    run(text.slice(last, m.index));
    if (m[2]) run(m[2], "<w:b/>");
    else if (m[3]) run(m[3], "<w:i/>");
    else run(m[4], '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
    last = m.index + m[0].length;
  }
  run(text.slice(last));
  return out.join("");
}

/** A Word document from Markdown: headings, paragraphs, bullet and numbered lists, tables, bold and italics. */
export function markdownToDocx(markdown: string): Buffer {
  const body: string[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split("|").map((c) => c.trim()));
      }
      i--;
      const border = '<w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders>';
      body.push(
        `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${border}</w:tblPr>${rows
          .map((r, n) => `<w:tr>${r.map((c) => `<w:tc><w:p>${runs(c, n === 0 ? "<w:b/>" : "")}</w:p></w:tc>`).join("")}</w:tr>`)
          .join("")}</w:tbl><w:p/>`,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (heading) {
      const size = [40, 32, 28, 26, 24, 24][heading[1].length - 1];
      body.push(`<w:p><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>${runs(heading[2], `<w:b/><w:sz w:val="${size}"/>`)}</w:p>`);
    } else if (bullet) body.push(`<w:p><w:pPr><w:ind w:left="360" w:hanging="240"/></w:pPr>${runs(`• ${bullet[1]}`)}</w:p>`);
    else if (numbered) body.push(`<w:p><w:pPr><w:ind w:left="360" w:hanging="300"/></w:pPr>${runs(`${numbered[1]}. ${numbered[2]}`)}</w:p>`);
    else if (line.trim()) body.push(`<w:p>${runs(line.replace(/^>\s?/, ""))}</w:p>`);
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  return zip([
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
    },
    { name: "word/document.xml", data: Buffer.from(document) },
  ]);
}

/** Rows from CSV (quoted fields allowed) or from a Markdown table. */
export function toRows(text: string): string[][] {
  const lines = text.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines.every((l) => /^\s*\|.*\|\s*$/.test(l))) {
    return lines.filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l)).map((l) => l.trim().slice(1, -1).split("|").map((c) => c.trim()));
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const colName = (n: number) => {
  let s = "";
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};

/** An Excel workbook with one sheet; numbers stay numbers, the first row is bold-free headers. */
export function rowsToXlsx(rows: string[][], sheetName = "Sheet1"): Buffer {
  const sheetRows = rows
    .map(
      (r, y) =>
        `<row r="${y + 1}">${r
          .map((v, x) => {
            const ref = `${colName(x)}${y + 1}`;
            const n = v.trim().replace(/,/g, "");
            return n && /^-?\d+(\.\d+)?$/.test(n) ? `<c r="${ref}"><v>${n}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`;
          })
          .join("")}</row>`,
    )
    .join("");
  const safeName = escapeXml(sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet1");
  return zip([
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
    },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`),
    },
  ]);
}

/** Splits text into passages of about `size` characters at paragraph breaks, for the knowledge base. */
export function chunk(text: string, size = 1200): string[] {
  const paras = text.split(/\n{2,}|\n(?=#)/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > size) {
      out.push(cur);
      cur = "";
    }
    if (p.length > size * 1.5) {
      for (let i = 0; i < p.length; i += size) out.push(p.slice(i, i + size));
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}
