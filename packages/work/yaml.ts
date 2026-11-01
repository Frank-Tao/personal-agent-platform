// A deliberately small YAML subset, enough for project charters and plans, with no dependencies.
//
// Supported: nested maps by indentation, block lists ("- x", "- key: v" with continuation lines), flow lists [a, b],
// flow maps { k: v }, quoted strings ('..' and ".."), numbers, true/false/null/~, and # comments.
// Not supported (an error, never a silent guess): multi-line scalars (| >), anchors/aliases, tabs, tags, multi-document files.

export type Yaml = null | boolean | number | string | Yaml[] | { [k: string]: Yaml };

export class YamlError extends Error {
  constructor(message: string, line?: number) {
    super(line ? `YAML line ${line}: ${message}` : `YAML: ${message}`);
  }
}

interface Line {
  indent: number;
  text: string;
  no: number;
}

/** Remove a trailing comment, ignoring # inside quotes. */
function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function scalar(raw: string, no: number): Yaml {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s[0] === '"') {
    if (!s.endsWith('"') || s.length < 2) throw new YamlError('unterminated double-quoted string', no);
    return s.slice(1, -1).replace(/\\(["\\nt])/g, (_m, c) => ({ n: '\n', t: '\t', '"': '"', '\\': '\\' }[c as 'n'] as string));
  }
  if (s[0] === "'") {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError('unterminated single-quoted string', no);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === '|' || s === '>' || s.startsWith('|-') || s.startsWith('>-')) throw new YamlError('multi-line scalars (| >) are not supported; use a quoted string', no);
  if (s[0] === '&' || s[0] === '*' || s[0] === '!') throw new YamlError('anchors, aliases and tags are not supported', no);
  return s;
}

/** [a, "b c", {k: v}] and {k: [1, 2]} (nesting allowed). */
function flow(src: string, no: number): Yaml {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const value = (): Yaml => {
    ws();
    if (src[i] === '[') {
      i++;
      const out: Yaml[] = [];
      for (;;) {
        ws();
        if (src[i] === ']') { i++; return out; }
        out.push(value());
        ws();
        if (src[i] === ',') i++;
        else if (src[i] !== ']') throw new YamlError('expected , or ] in flow list', no);
      }
    }
    if (src[i] === '{') {
      i++;
      const out: { [k: string]: Yaml } = {};
      for (;;) {
        ws();
        if (src[i] === '}') { i++; return out; }
        const key = token(':');
        ws();
        if (src[i] !== ':') throw new YamlError('expected : in flow map', no);
        i++;
        out[String(scalar(key, no))] = value();
        ws();
        if (src[i] === ',') i++;
        else if (src[i] !== '}') throw new YamlError('expected , or } in flow map', no);
      }
    }
    return scalar(token(',]}'), no);
  };
  const token = (stops: string): string => {
    ws();
    const start = i;
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i++];
      while (i < src.length && src[i] !== q) i += q === '"' && src[i] === '\\' ? 2 : 1;
      i++;
      return src.slice(start, i);
    }
    while (i < src.length && !stops.includes(src[i])) i++;
    return src.slice(start, i);
  };
  const v = value();
  ws();
  if (i < src.length) throw new YamlError('trailing text after flow value', no);
  return v;
}

function inline(rest: string, no: number): Yaml {
  const s = rest.trim();
  return s[0] === '[' || s[0] === '{' ? flow(s, no) : scalar(s, no);
}

/** Split "key: value" at the first unquoted colon followed by a space or end of line. */
function splitKey(text: string, no: number): [string, string] {
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === ':' && (i === text.length - 1 || text[i + 1] === ' ')) return [String(scalar(text.slice(0, i), no)), text.slice(i + 1)];
  }
  throw new YamlError(`expected "key: value", got "${text}"`, no);
}

export function parseYaml(src: string): Yaml {
  const lines: Line[] = [];
  src.split('\n').forEach((raw, idx) => {
    if (/^\t/.test(raw) || /^ *\t/.test(raw)) throw new YamlError('tabs are not allowed for indentation', idx + 1);
    const t = stripComment(raw.replace(/\r$/, '')).trimEnd();
    if (!t.trim()) return;
    lines.push({ indent: t.length - t.trimStart().length, text: t.trimStart(), no: idx + 1 });
  });
  if (!lines.length) return null;
  let pos = 0;

  const block = (indent: number): Yaml => (lines[pos].text.startsWith('- ') || lines[pos].text === '-' ? list(indent) : map(indent));

  function map(indent: number): Yaml {
    const out: { [k: string]: Yaml } = {};
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith('- ')) {
      const ln = lines[pos];
      const [key, rest] = splitKey(ln.text, ln.no);
      if (key in out) throw new YamlError(`duplicate key "${key}"`, ln.no);
      pos++;
      if (rest.trim() !== '') out[key] = inline(rest, ln.no);
      else if (pos < lines.length && (lines[pos].indent > indent || (lines[pos].indent === indent && lines[pos].text.startsWith('- ')))) out[key] = block(lines[pos].indent);
      else out[key] = null;
    }
    if (pos < lines.length && lines[pos].indent > indent) throw new YamlError('unexpected indentation', lines[pos].no);
    return out;
  }

  function list(indent: number): Yaml {
    const out: Yaml[] = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith('- ') || lines[pos].text === '-')) {
      const ln = lines[pos];
      const rest = ln.text === '-' ? '' : ln.text.slice(2);
      if (rest.trim() === '') {
        pos++;
        out.push(pos < lines.length && lines[pos].indent > indent ? block(lines[pos].indent) : null);
      } else if (/^[^\s"'\[{][^:]*:(\s|$)/.test(rest) || /^["'][^"']*["']:(\s|$)/.test(rest)) {
        // "- key: value" opens a map whose further keys line up two columns in
        const item = indent + 2;
        lines[pos] = { indent: item, text: rest, no: ln.no };
        out.push(map(item));
      } else {
        pos++;
        out.push(inline(rest, ln.no));
      }
    }
    return out;
  }

  const result = block(lines[0].indent);
  if (pos < lines.length) throw new YamlError('could not parse this line', lines[pos].no);
  return result;
}

/* ---------- writer ---------- */

const PLAIN = /^[A-Za-z0-9_./~@$%^&*()+=<>?;|-][^#:\[\]{},"']*$/;

function str(s: string): string {
  if (s === '') return '""';
  const risky = !PLAIN.test(s) || /^(true|false|null|~)$/i.test(s) || /^-?\d+(\.\d+)?$/.test(s) || /^\s|\s$/.test(s) || s.includes(': ') || s.includes(' #') || s.startsWith('- ') || s.startsWith('-') || /^[*&!|>%@`]/.test(s);
  if (!risky) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}

const isScalar = (v: Yaml): v is null | boolean | number | string => v === null || typeof v !== 'object';
const scal = (v: null | boolean | number | string) => (v === null ? 'null' : typeof v === 'string' ? str(v) : String(v));

/** Short lists of scalars are written inline ([a, b]); everything else as blocks. */
export function stringifyYaml(v: Yaml, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (isScalar(v)) return pad + scal(v) + '\n';
  if (Array.isArray(v)) {
    if (!v.length) return pad + '[]\n';
    return v.map((item) => {
      if (isScalar(item)) return `${pad}- ${scal(item)}\n`;
      const inner = stringifyYaml(item, indent + 2);
      return `${pad}- ${inner.slice(indent + 2)}`;
    }).join('');
  }
  const entries = Object.entries(v);
  if (!entries.length) return pad + '{}\n';
  return entries.map(([k, val]) => {
    const key = /^[A-Za-z0-9_-]+$/.test(k) ? k : str(k);
    if (isScalar(val)) return `${pad}${key}: ${scal(val)}\n`;
    if (Array.isArray(val)) {
      if (!val.length) return `${pad}${key}: []\n`;
      if (val.every(isScalar) && val.map((x) => scal(x as string)).join(', ').length < 70) return `${pad}${key}: [${val.map((x) => scal(x as string)).join(', ')}]\n`;
      return `${pad}${key}:\n${stringifyYaml(val, indent + 2)}`;
    }
    if (!Object.keys(val).length) return `${pad}${key}: {}\n`;
    return `${pad}${key}:\n${stringifyYaml(val, indent + 2)}`;
  }).join('');
}
