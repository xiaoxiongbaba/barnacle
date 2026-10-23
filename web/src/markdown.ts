/**
 * A small Markdown renderer for agents' deliveries: headings, lists, quotes, code blocks, tables, bold,
 * italics, inline code and links. Builds DOM nodes only (never innerHTML), and
 * links open in a new tab with no referrer.
 */

function inline(text: string): Node[] {
  const out: Node[] = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?]))/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    if (m[2] || m[3]) {
      const b = document.createElement("strong");
      b.textContent = m[2] ?? m[3];
      out.push(b);
    } else if (m[4]) {
      const i = document.createElement("em");
      i.textContent = m[4];
      out.push(i);
    } else if (m[5]) {
      const c = document.createElement("code");
      c.textContent = m[5];
      out.push(c);
    } else {
      const a = document.createElement("a");
      a.href = m[7] ?? m[8];
      a.textContent = m[6] ?? m[8];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      out.push(a);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

export function renderMarkdown(src: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "md";
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let list: HTMLUListElement | HTMLOListElement | null = null;
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      const p = document.createElement("p");
      p.append(...inline(para.join(" ")));
      root.append(p);
      para = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flush();
      list = null;
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      const pre = document.createElement("pre");
      pre.textContent = code.join("\n");
      root.append(pre);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      // Tables: the first row is the header when a |---| line follows it.
      flush();
      list = null;
      const rows: string[] = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i].trim());
      i--;
      const isRule = (r: string) => /^\|[\s:|-]+\|$/.test(r);
      const cells = (r: string) => r.slice(1, -1).split("|").map((c) => c.trim());
      const table = document.createElement("table");
      const header = rows.length > 1 && isRule(rows[1]);
      rows.forEach((r, n) => {
        if (isRule(r)) return;
        const tr = document.createElement("tr");
        for (const c of cells(r)) {
          const td = document.createElement(header && n === 0 ? "th" : "td");
          td.append(...inline(c));
          tr.append(td);
        }
        table.append(tr);
      });
      const wrap = document.createElement("div");
      wrap.className = "md__table";
      wrap.append(table);
      root.append(wrap);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      list = null;
      const h = document.createElement(heading[1].length <= 2 ? "h4" : "h5");
      h.append(...inline(heading[2]));
      root.append(h);
    } else if (bullet || numbered) {
      flush();
      const tag = bullet ? "UL" : "OL";
      if (!list || list.tagName !== tag) {
        list = document.createElement(bullet ? "ul" : "ol");
        root.append(list);
      }
      const li = document.createElement("li");
      li.append(...inline((bullet ?? numbered)![1]));
      list.append(li);
    } else if (line.startsWith(">")) {
      flush();
      list = null;
      const q = document.createElement("blockquote");
      q.append(...inline(line.replace(/^>\s?/, "")));
      root.append(q);
    } else if (!line.trim()) {
      flush();
      list = null;
    } else {
      list = null;
      para.push(line.trim());
    }
  }
  flush();
  return root;
}
