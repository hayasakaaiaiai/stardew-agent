"""Convert downloaded MediaWiki parse JSON into readable Markdown.

usage: python3 -I html2md.py <raw_dir> <out_dir>
Reads <raw_dir>/{en,zh}/<Title>.json, writes <out_dir>/{en,zh}/<Title>.md.
"""
import html
import json
import os
import re
import sys
from html.parser import HTMLParser

VOID = {"br", "img", "hr", "meta", "link", "input", "source", "wbr", "col", "area", "base", "track", "embed", "param"}
SKIP_TAGS = {"script", "style", "img", "audio", "video", "noscript", "sup"}
SKIP_CLASSES = {"toc", "navbox", "mw-editsection", "gallery", "gallerybox", "thumb", "printfooter", "catlinks",
                "mw-empty-elt", "reference", "references", "mw-references-wrap", "toctogglecheckbox"}
QUOTE_TEXT = {"squotetext", "quotetext"}
QUOTE_MARK = {"decorativesquote", "decorativequotemark"}
DROP_SECTIONS ={"Gallery", "Portraits", "History", "References", "画廊", "肖像", "历史", "参考", "参考资料", "版本历史", "肖像画"}


class Node:
    def __init__(self, tag, attrs, parent=None):
        self.tag, self.attrs, self.parent, self.children = tag, dict(attrs), parent, []

    @property
    def classes(self):
        return set((self.attrs.get("class") or "").split())


class TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root", [])
        self.cur = self.root

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.cur)
        self.cur.children.append(node)
        if tag not in VOID:
            self.cur = node

    def handle_startendtag(self, tag, attrs):
        self.cur.children.append(Node(tag, attrs, self.cur))

    def handle_endtag(self, tag):
        node = self.cur
        while node is not self.root and node.tag != tag:
            node = node.parent
        if node is not self.root:
            self.cur = node.parent

    def handle_data(self, data):
        self.cur.children.append(data)


def skipped(node):
    if node.tag in SKIP_TAGS:
        return True
    if node.attrs.get("id") == "toc" or node.classes & SKIP_CLASSES:
        return True
    style = (node.attrs.get("style") or "").replace(" ", "")
    return "display:none" in style


def inline(node):
    """Flatten a subtree to one line of text (used for table cells and headings)."""
    if isinstance(node, str):
        return node
    if skipped(node):
        return ""
    if node.tag == "br":
        return " / "
    parts = [inline(c) for c in node.children]
    sep = " " if node.tag in ("tr", "table", "ul", "ol", "p", "div", "li", "dl", "dd", "dt") else ""
    text = sep.join(p for p in parts if p) if sep else "".join(parts)
    return text


def clean(text):
    return re.sub(r"\s+", " ", text).strip()


def render_table(node):
    rows = []
    for tr in iter_rows(node):
        cells = [c for c in tr.children if isinstance(c, Node) and c.tag in ("th", "td") and not skipped(c)]
        if not cells:
            continue
        row = []
        for c in cells:
            text = clean(inline(c)).replace("|", "\\|")
            row.append(text)
            for _ in range(int(c.attrs.get("colspan", "1") or 1) - 1):
                row.append("")
        rows.append((all(c.tag == "th" for c in cells), row))
    rows = [(h, r) for h, r in rows if any(r)]
    if not rows:
        return ""
    width = max(len(r) for _, r in rows)
    if width == 1:
        return "\n".join(r[0] for _, r in rows)
    out = []
    head_is_th, head = rows[0]
    body = rows[1:] if head_is_th else rows
    if not head_is_th:
        head = [""] * width
    pad = lambda r: r + [""] * (width - len(r))
    out.append("| " + " | ".join(pad(head)) + " |")
    out.append("|" + "---|" * width)
    for _, r in body:
        out.append("| " + " | ".join(pad(r)) + " |")
    return "\n".join(out)


def descendants(node):
    for c in node.children:
        if isinstance(c, Node) and not skipped(c):
            yield c
            yield from descendants(c)


def find(node, pred):
    return next((d for d in descendants(node) if pred(d)), None)


def iter_rows(table):
    for child in table.children:
        if not isinstance(child, Node):
            continue
        if child.tag == "tr":
            yield child
        elif child.tag in ("tbody", "thead", "tfoot"):
            yield from iter_rows(child)


def blocks(node, depth=0):
    """Render a subtree as a list of Markdown blocks."""
    if isinstance(node, str):
        return [node]
    if skipped(node):
        return []
    tag = node.tag
    if tag in ("h1", "h2", "h3", "h4", "h5"):
        level = int(tag[1]) + (0 if tag == "h1" else 0)
        return ["\n\n" + "#" * level + " " + clean(inline(node)) + "\n\n"]
    if tag == "table":
        nested = find(node, lambda n: n.tag == "table") is not None
        quote = None if nested else find(node, lambda n: bool(n.classes & QUOTE_TEXT))
        if quote is not None:
            # {{Quote}} templates: a decorative “ cell, the quote, and an optional attribution row.
            text = clean(inline(quote))
            rest = [clean(inline(c)) for c in descendants(node)
                    if c.tag == "td" and not c.classes & (QUOTE_TEXT | QUOTE_MARK)]
            rest = [r for r in rest if r]
            return [f"\n\n> {text}" + (f" {' '.join(rest)}" if rest else "") + "\n\n"] if text else []
        if nested:
            # Layout table that wraps other tables (e.g. per-season schedules): render cells as blocks.
            out = []
            for tr in iter_rows(node):
                for cell in tr.children:
                    if isinstance(cell, Node) and cell.tag in ("th", "td") and not skipped(cell):
                        inner = "".join(b for c in cell.children for b in blocks(c, depth))
                        if cell.tag == "th" and find(cell, lambda n: n.tag == "table") is None:
                            out.append(f"\n\n**{clean(inner)}**\n\n")
                        else:
                            out.append("\n\n" + inner + "\n\n")
            return out
        return ["\n\n" + render_table(node) + "\n\n"]
    if tag in ("ul", "ol"):
        items = []
        for i, li in enumerate(c for c in node.children if isinstance(c, Node) and c.tag == "li"):
            marker = "-" if tag == "ul" else f"{i + 1}."
            inner = []
            nested = []
            for c in li.children:
                if isinstance(c, Node) and c.tag in ("ul", "ol"):
                    nested.append("".join(blocks(c, depth + 1)).rstrip("\n"))
                else:
                    inner.append(inline(c))
            items.append("  " * depth + f"{marker} {clean(''.join(inner))}")
            items.extend(n for n in nested if n.strip())
        return ["\n" + "\n".join(items) + "\n"]
    if tag == "dl":
        lines = []
        for c in node.children:
            if isinstance(c, Node) and c.tag == "dt":
                lines.append(f"**{clean(inline(c))}**")
            elif isinstance(c, Node) and c.tag == "dd":
                lines.append(clean(inline(c)))
        return ["\n\n" + "\n".join(lines) + "\n\n"]
    if tag == "br":
        return ["\n"]
    if tag in ("p", "div", "blockquote", "center", "section"):
        inner = "".join(b for c in node.children for b in blocks(c, depth))
        return ["\n\n" + inner + "\n\n"]
    return ["".join(b for c in node.children for b in blocks(c, depth))]


def drop_sections(md):
    out, dropping = [], False
    for line in md.split("\n"):
        m = re.match(r"^(#{2,5}) (.*)$", line)
        if m:
            if len(m.group(1)) == 2:
                dropping = m.group(2).strip() in DROP_SECTIONS
        if not dropping:
            out.append(line)
    return "\n".join(out)


def tidy(md):
    lines = [re.sub(r"[ \t]+", " ", l).rstrip() for l in md.split("\n")]
    lines = [l.strip() if not l.lstrip().startswith(("-", "|")) and not re.match(r"^\s*\d+\. ", l) else l for l in lines]
    md = "\n".join(lines)
    return re.sub(r"\n{3,}", "\n\n", md).strip() + "\n"


def convert(path, lang):
    data = json.load(open(path))
    parse = data["parse"]
    title = parse["title"]
    rev = parse.get("revid")
    base = "https://stardewvalleywiki.com/" if lang == "en" else "https://zh.stardewvalleywiki.com/"
    builder = TreeBuilder()
    builder.feed(parse["text"])
    body = tidy(drop_sections("".join(blocks(builder.root))))
    header = f"# {title}\n\n> 来源：{base}{title.replace(' ', '_')}（revision {rev}）。许可：CC BY-NC-SA。\n\n"
    return header + body


def main():
    raw, out = sys.argv[1], sys.argv[2]
    for lang in ("en", "zh"):
        os.makedirs(os.path.join(out, lang), exist_ok=True)
        for name in sorted(os.listdir(os.path.join(raw, lang))):
            if not name.endswith(".json"):
                continue
            md = convert(os.path.join(raw, lang, name), lang)
            target = os.path.join(out, lang, name[:-5] + ".md")
            open(target, "w").write(md)
            print(f"{lang}/{name[:-5]}.md {len(md)}")


main()
