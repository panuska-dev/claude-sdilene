#!/usr/bin/env node
// PreToolUse hook (Workflow, Agent, Task): každý subagent má výslovně zvolený model, ve workflow i effort.
// Proč: agent bez modelu dědí model session a ten bývá nejdražší (skill orchestrace, sekce 4. Model a effort).
// Při dávce desítek agentů bez modelu se tak snadno vyčerpá limit předplatného. Próza ve skillu to nedrží, hook ano.
//
// Co kontroluje:
// - Agent, Task (starý název): zamítne, když tool_input.model chybí nebo je prázdný. Výjimky: subagent_type
//   "fork"; subagent_type s dvojtečkou (agent z pluginu); vlastní typ, jehož definice <name>.md
//   (nebo soubor s frontmatter name) v $CLAUDE_PROJECT_DIR/.claude/agents nebo v <config>/agents
//   (CLAUDE_CONFIG_DIR, jinak ~/.claude) má neprázdný model v YAML frontmatteru (jiný než "inherit").
// - Workflow: zdroj je tool_input.script, jinak soubor tool_input.scriptPath. Každé volání agent( ve skriptu
//   musí mít druhý argument s klíči model a effort. Klíč agentType model nahradí stejně jako subagent_type
//   u Agent (fork, dvojtečka, vlastní typ s modelem v definici); vestavěný typ (general-purpose, Explore) model potřebuje. Tokenizer přeskočí řetězce,
//   šablony, komentáře a regex literály; spread a identifikátor options dohledá jako const/let/var NAME = {...}
//   v témže skriptu. Hledání nezná rozsahy platnosti, proto je jméno neznámé (a povolí se), když ho skript
//   zavádí ještě jinde (parametr, jiná deklarace, destrukturování) nebo objekt po deklaraci mění
//   (NAME.klíč = ..., Object.assign(NAME, ...), NAME = ...). Když je agent ve skriptu lokální jméno
//   (parametr, vlastní funkce), skript se nekontroluje. Objekt předaný cizí funkci nebo jinak
//   předaný dál (fill(NAME), alias) je neznámý a povolí se; getter get model() se bere jako hodnota.
//   Jen tool_input.name (uložený workflow) se nekontroluje.
// - Hodnota modelu se nevaliduje proti seznamu (seznam by zastarával).
//
// Fail-open: chybný vstup, neznámý tvar, výjimka, nečitelný soubor, nedohledatelný spread nebo options
// = bez výstupu a exit 0. Zamítá se jen tehdy, když chyba je jistá.
//
// Na čem závisí: názvy nástrojů Workflow, Agent, Task; pole script, scriptPath, name, model, subagent_type
// a v API workflow funkce agent(prompt, options) s klíči model, effort, agentType. Když se cokoli z toho
// změní, hook mlčí a nic neblokuje; kontrola pak stárne tiše, proto ji drží test (orchestrace-guard.test.mjs).
//
// Vypínač: proměnná prostředí ORCHESTRACE_GUARD=off.
// Vstup: JSON PreToolUse na stdin. Při zamítnutí vypíše JSON s permissionDecision deny.
// Test: node orchestrace-guard.test.mjs (ve složce hooks pluginu; kontroluje i zapojení v hooks.json vedle sebe).
//
// Hook je jeden soubor bez závislostí mimo vestavěné moduly Node.js (funkce isMain je přímo níže).
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Je modul spuštěný přímo (node hook.mjs), ne importovaný? Node dává import.meta.url hlavního modulu jako
// skutečnou cestu (symlinky rozbalené), process.argv[1] ale tak, jak ji volající napsal. Přímé porovnání
// s pathToFileURL(argv[1]) proto selže, když cesta vede přes symlink nebo junction (macOS: tmpdir /var ->
// /private/var): skript pak tiše skončí s kódem 0 a nic nezablokuje. Porovnávají se skutečné cesty obou stran
// (native: i velikost písmen na APFS/NTFS a krátká jména Windows).
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync.native(argv1) === realpathSync.native(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

const MAX_SOURCE = 4_000_000;
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'delete', 'void', 'throw', 'new', 'instanceof', 'yield', 'await']);
const ID_PART = /[\p{ID_Continue}$\u200c\u200d]/u; // stejná definice identifikátoru v tokenizeru i ve vyhledávání
const REGEX_AFTER_PAREN_OF = new Set(['if', 'for', 'while', 'with']);
const REGEX_AFTER_CHAR = '(,=:[!&|?{};+-*%<>~^}';

// Vrátí text stejné délky, kde řetězce, komentáře a regex literály jsou nahrazené mezerami (konce řádků
// zůstávají, takže čísla řádků sedí). Šablonový literál se zruší, jen ${ ... } se změní na ( ... ),
// aby kód uvnitř zůstal vidět a závorky seděly.
export function mask(src) {
  const n = src.length;
  const out = src.split('');
  let i = 0;
  let prev = ''; // poslední významný token: slovo, jeden znak, nebo 'val' po literálu
  const blank = (k) => { if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };
  const isId = (c) => c !== undefined && (ID_PART.test(c) || (c >= '\ud800' && c <= '\udfff'));
  const regexAllowed = () => prev === '' || prev === 'if)' || (REGEX_AFTER_WORD.has(prev)) || (prev.length === 1 && REGEX_AFTER_CHAR.includes(prev));

  function skipString(q) {
    blank(i++);
    while (i < n && src[i] !== q && src[i] !== '\n') {
      if (src[i] === '\\') {
        blank(i++);
        if (src[i] === '\r' && src[i + 1] === '\n') i++;
        if (i >= n) break;
      }
      blank(i++);
    }
    if (i < n && src[i] === q) blank(i++);
  }

  function skipTemplate() {
    blank(i++);
    while (i < n) {
      const c = src[i];
      if (c === '\\') { blank(i++); if (i < n) blank(i++); continue; }
      if (c === '`') { blank(i++); return; }
      if (c === '$' && src[i + 1] === '{') { out[i] = ' '; out[i + 1] = '('; i += 2; code(true); continue; }
      blank(i++);
    }
  }

  function regexEnd(start) {
    let j = start + 1, inClass = false;
    while (j < n) {
      const ch = src[j];
      if (ch === '\n') return -1;
      if (ch === '\\') { if (src[j + 1] === '\n') return -1; j += 2; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) { j++; while (isId(src[j])) j++; return j; }
      j++;
    }
    return -1;
  }

  function code(inTpl) {
    let depth = 0;
    const parens = []; // slovo před každou otevřenou závorkou: za if (...), for (...), while (...) může začít regex
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') blank(i++); continue; }
      if (c === '/' && d === '*') {
        const e = src.indexOf('*/', i + 2);
        const end = e < 0 ? n : e + 2;
        while (i < end) blank(i++);
        continue;
      }
      if (c === '"' || c === "'") { skipString(c); prev = 'val'; continue; }
      if (c === '`') { skipTemplate(); prev = 'val'; continue; }
      if (c === '{') { depth++; prev = c; i++; continue; }
      if (c === '}') {
        if (inTpl && depth === 0) { out[i] = ')'; i++; prev = 'val'; return; }
        depth--; prev = c; i++; continue;
      }
      if (c === '(') { parens.push(prev); prev = c; i++; continue; }
      if (c === ')') { prev = REGEX_AFTER_PAREN_OF.has(parens.pop()) ? 'if)' : 'val'; i++; continue; }
      // i++ / 2: postfix je vždy před dělením a prefix před regexem nedává smysl; prev se nemění
      if ((c === '+' || c === '-') && d === c) { i += 2; continue; }
      if (c === '/') {
        if (regexAllowed()) {
          const end = regexEnd(i);
          if (end > 0) { for (; i < end; i++) blank(i); prev = 'val'; continue; }
        }
        prev = c; i++; continue;
      }
      if (/\s/.test(c)) { i++; continue; }
      if (isId(c)) {
        let j = i;
        while (j < n && isId(src[j])) j++;
        prev = src.slice(i, j);
        i = j;
        continue;
      }
      prev = c; i++;
    }
  }

  code(false);
  return out.join('');
}

// Index závorky, která uzavírá otevírací závorku na pozici open; -1 při nevyvážených závorkách.
function matching(m, open) {
  let depth = 0;
  for (let k = open; k < m.length; k++) {
    const c = m[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (--depth === 0) return k; }
  }
  return -1;
}

// Rozsahy [od, do) částí oddělených čárkou na nejvyšší úrovni uvnitř (from, to).
function splitTop(m, from, to) {
  const parts = [];
  let depth = 0, start = from;
  for (let k = from; k < to; k++) {
    const c = m[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push([start, k]); start = k + 1; }
  }
  parts.push([start, to]);
  return parts;
}

const EMPTY_VALUE = /^(?:(['"])\1|undefined|null)$/;
const esc = (s) => s.replace(/\$/g, '\\$');

// Hodnota klíče: false = prázdná, true = je (neznámá), u agentType jediný řetězcový literál jako text.
// maskedValue je text hodnoty z masky; je prázdný jen u samotného řetězce (operátor by v masce zůstal).
function valueOf(key, rawValue, maskedValue) {
  const v = rawValue.trim();
  if (EMPTY_VALUE.test(v)) return false;
  if (key !== 'agentType' || maskedValue.trim() !== '') return true;
  return /^(['"])((?:\\.|(?!\1)[^\\\n])*)\1/.exec(v)?.[2] ?? true;
}

// Klíče objektového literálu mezi závorkami (from, to) bez nich: { keys: Map(klíč -> má hodnotu), unknown }.
function parseObject(ctx, from, to, seen) {
  const { m, src } = ctx;
  const keys = new Map();
  let unknown = false;
  for (const [s, e] of splitTop(m, from, to)) {
    const mt = m.slice(s, e);
    const t = mt.trim();
    if (!t) continue;
    const lead = s + (mt.length - mt.trimStart().length);
    let mm;
    if (t.startsWith('...')) {
      const id = /^\.\.\.\s*([A-Za-z_$][\w$]*)$/.exec(t)?.[1];
      const sub = id && !seen.has(id) ? resolveObject(ctx, id, new Set([...seen, id])) : null;
      if (!sub) { unknown = true; continue; }
      for (const [k, v] of sub.keys) keys.set(k, v);
      if (sub.unknown) unknown = true;
    } else if ((mm = /^([A-Za-z_$][\w$]*)\s*:/.exec(t))) {
      keys.set(mm[1], valueOf(mm[1], src.slice(lead + mm[0].length, e), m.slice(lead + mm[0].length, e)));
    } else if (/^[A-Za-z_$][\w$]*$/.test(t)) {
      keys.set(t, true);
    } else if ((mm = /^get\s+([A-Za-z_$][\w$]*)\s*\(/.exec(t))) {
      keys.set(mm[1], true); // getter vrací hodnotu klíče
    } else if (/^(?:async\s+|set\s+)?\*?\s*[A-Za-z_$][\w$]*\s*\(/.test(t)) {
      continue; // metoda
    } else if (t.startsWith(':')) {
      // klíč v uvozovkách: v masce je prázdný, čte se z originálu
      const sm = /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*(['"])((?:\\.|(?!\1)[^\\\n])*)\1\s*:([\s\S]*)$/.exec(src.slice(s, e));
      if (!sm) { unknown = true; continue; }
      keys.set(sm[2], valueOf(sm[2], sm[3], t.slice(1)));
    } else if (/^\d/.test(t)) {
      continue; // číselný klíč
    } else {
      unknown = true; // [vypočtený] klíč a cokoli neznámého
    }
  }
  return { keys, unknown };
}

const KEYWORD_BEFORE_PARENS = new Set(['if', 'for', 'while', 'switch', 'with', 'await']);

// Pro každou pozici nejbližší otevřenou závorku, která ji obklopuje (u závorky samotné tu rodičovskou),
// a mapa otevírací -> zavírací závorka.
function structure(m) {
  const inner = new Int32Array(m.length);
  const close = new Map();
  const stack = [];
  for (let k = 0; k < m.length; k++) {
    const c = m[k];
    if (c === '(' || c === '[' || c === '{') { inner[k] = stack.length ? stack[stack.length - 1] : -1; stack.push(k); continue; }
    if (c === ')' || c === ']' || c === '}') { const o = stack.pop(); if (o !== undefined) close.set(o, k); }
    inner[k] = stack.length ? stack[stack.length - 1] : -1;
  }
  return { inner, close };
}

// Pozice výskytů identifikátoru NAME, které ho ve skriptu zavádějí jako novou proměnnou: const/let/var/function/class,
// parametr funkce nebo šipky (včetně destrukturování), parametr catch, destrukturující deklarace.
// Hrubé a záměrně přísné: raději označí navíc, protože označené jméno se pak bere jako neznámé a povolí se.
function binders(ctx, name) {
  const { m, inner, close } = ctx;
  const out = [];
  for (const hit of m.matchAll(new RegExp(String.raw`(?<![\w$.])${esc(name)}(?![\w$])`, 'g'))) {
    const idx = hit.index;
    if (/\b(?:const|let|var|function|class)\s*\*?\s*$/.test(m.slice(Math.max(0, idx - 40), idx))) { out.push(idx); continue; }
    if (/^\s*=>/.test(m.slice(idx + name.length, idx + name.length + 20))) { out.push(idx); continue; }
    for (let o = inner[idx]; o >= 0; o = inner[o]) {
      let bound = false;
      if (m[o] === '(') {
        const end = close.get(o);
        if (end !== undefined) {
          let a = end + 1;
          while (/\s/.test(m[a] ?? '')) a++;
          if (m[a] === '=' && m[a + 1] === '>') bound = true;
          else if (m[a] === '{') {
            const word = /([\w$]+)\s*\*?\s*$/.exec(m.slice(Math.max(0, o - 60), o))?.[1];
            bound = word !== undefined && !KEYWORD_BEFORE_PARENS.has(word); // metoda, function, catch
          }
        }
      } else if (/\b(?:const|let|var)\s*$/.test(m.slice(Math.max(0, o - 40), o))) bound = true; // destrukturování
      if (bound) { out.push(idx); break; }
    }
  }
  return out;
}

// Objekt NAME ve skriptu měnit: NAME.klíč = ..., NAME[k] ||= ..., NAME = ..., delete NAME.klíč, NAME.klíč++,
// Object.assign(NAME, ...). Pak literál v deklaraci neříká, co v objektu při volání je.
function mutated(m, name, declIdx) {
  const n = esc(name);
  const assign = String.raw`(?:[-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)?=(?![=>])`;
  const path = String.raw`(?:\s*(?:\.\s*[\w$]+|\[[^\]\n]*\]))`;
  const patterns = [
    new RegExp(String.raw`(?<![\w$.])${n}${path}*\s*${assign}`, 'g'),
    new RegExp(String.raw`(?<![\w$.])${n}${path}*\s*(?:\+\+|--)`, 'g'),
    new RegExp(String.raw`\bdelete\s+${n}(?![\w$])`, 'g'),
    new RegExp(String.raw`\bObject\s*\.\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)\s*\(\s*${n}(?![\w$])`, 'g'),
  ];
  return patterns.some((re) => [...m.matchAll(re)].some((h) => h.index !== declIdx));
}

// Objekt NAME ve skriptu uniká: je použitý jinak než jako deklarace, rozbalení ...NAME, čtení NAME.klíč
// nebo options volání agent(x, NAME). Cizí funkce (fill(NAME)), přiřazení, pole apod. ho mohou doplnit,
// takže literál v deklaraci neříká, co v objektu při volání je.
function escapes(ctx, name, declIdx) {
  const { m, inner } = ctx;
  for (const hit of m.matchAll(new RegExp(String.raw`(?<![\w$.])${esc(name)}(?![\w$])`, 'g'))) {
    const idx = hit.index;
    if (idx === declIdx) continue;
    const before = m.slice(Math.max(0, idx - 200), idx).trimEnd();
    const after = m.slice(idx + name.length, idx + name.length + 200).trimStart();
    if (before.endsWith('...')) continue;
    if (/^(?:\?\.|\.|\[)/.test(after)) continue;
    if (before.endsWith(',') && /^[,)]/.test(after)) {
      const o = inner[idx];
      if (o >= 0 && m[o] === '(' && /(?<![\w$.])agent\s*$/.test(m.slice(Math.max(0, o - 20), o))) continue;
    }
    return true;
  }
  return false;
}

// const/let/var NAME = { ... } (i Object.freeze({ ... })) právě jednou v celém skriptu, jinak null.
// Null (neznámé, povolit) je i tehdy, když jméno ve skriptu zavádí něco dalšího (parametr, jiná deklarace v jiném bloku)
// nebo se objekt po deklaraci mění či předává dál; hledání nezná rozsahy platnosti, takže při pochybnosti mlčí.
function resolveObject(ctx, name, seen) {
  const { m } = ctx;
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  const re = new RegExp(String.raw`(?<![\w$.])(?:const|let|var)\s+${esc(name)}\s*=\s*(?:Object\s*\.\s*freeze\s*\(\s*)?\{`, 'g');
  const found = [...m.matchAll(re)];
  if (found.length !== 1) return null;
  const declIdx = found[0].index + /^(?:const|let|var)\s+/.exec(found[0][0])[0].length;
  if (binders(ctx, name).some((b) => b !== declIdx)) return null;
  if (mutated(m, name, declIdx)) return null;
  if (escapes(ctx, name, declIdx)) return null;
  const open = found[0].index + found[0][0].length - 1;
  const close = matching(m, open);
  if (close < 0) return null;
  return parseObject(ctx, open + 1, close, seen);
}

// Volání agent( jako samostatný identifikátor: [{ line, missing: ['model', 'effort'] }].
export function checkScript(src, typeHasModel = () => false) {
  const m = mask(src);
  const ctx = { m, src, ...structure(m) };
  if (binders(ctx, 'agent').length) return []; // agent je ve skriptu lokální jméno (parametr, vlastní funkce): nejde o API workflow
  const bad = [];
  const breaks = [];
  for (let p = src.indexOf('\n'); p !== -1; p = src.indexOf('\n', p + 1)) breaks.push(p);
  const lineAt = (idx) => {
    let lo = 0, hi = breaks.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (breaks[mid] < idx) lo = mid + 1; else hi = mid; }
    return lo + 1;
  };
  const re = new RegExp(String.raw`(?<!${ID_PART.source})agent(?!${ID_PART.source})`, 'gu');
  for (const hit of m.matchAll(re)) {
    const idx = hit.index;
    let k = idx + 5;
    while (/\s/.test(m[k] ?? '')) k++;
    if (m[k] !== '(') continue;
    let b = idx - 1;
    while (b >= 0 && /\s/.test(m[b])) b--;
    if (m[b] === '.') continue; // .agent( nebo ?.agent(
    if (/(?:\bfunction|\basync|\bclass)\s*\*?\s*$/.test(m.slice(Math.max(0, b - 10), b + 1))) continue;
    const close = matching(m, k);
    if (close < 0) continue;
    let after = close + 1;
    while (/\s/.test(m[after] ?? '')) after++;
    if (m[after] === '{') continue; // definice metody agent(...) { ... }
    const args = splitTop(m, k + 1, close);
    const last = args[args.length - 1];
    if (!m.slice(...last).trim() && !/['"`\/]/.test(src.slice(...last))) args.pop(); // prázdný poslední argument (koncová čárka)
    if (args.some(([s, e]) => m.slice(s, e).trim().startsWith('...'))) continue; // argumenty z rozbalení: neznámé
    const line = lineAt(idx);
    if (args.length < 2) { bad.push({ line, missing: ['model', 'effort'] }); continue; }
    const [os, oe] = args[1];
    const opt = m.slice(os, oe).trim();
    const open = os + (oe - os - m.slice(os, oe).trimStart().length);
    let obj = null;
    if (opt.startsWith('{') && matching(m, open) === open + opt.length - 1) {
      obj = parseObject(ctx, open + 1, open + opt.length - 1, new Set());
    } else if (/^[A-Za-z_$][\w$]*$/.test(opt)) {
      obj = resolveObject(ctx, opt, new Set([opt]));
    }
    if (!obj) continue; // výraz, import, parametr: neznámé, povolit
    const missing = [];
    const type = obj.keys.get('agentType');
    // agentType: fork, plugin:x a vlastní typ s modelem v definici model nahradí; vestavěný (general-purpose, Explore) běží na modelu session
    const typeCovers = typeof type === 'string' ? type === 'fork' || type.includes(':') || typeHasModel(type) : Boolean(type);
    if (!obj.keys.get('model') && !typeCovers) missing.push('model');
    if (!obj.keys.get('effort')) missing.push('effort');
    if (missing.length && !obj.unknown) bad.push({ line, missing });
  }
  return bad;
}

// Frontmatter agenta: klíč model je neprázdný a není "inherit" (to zdědí model session).
function frontmatter(text) {
  return /^\ufeff?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? null;
}
const fmValue = (fm, key) => (new RegExp(`^${key}[ \\t]*:[ \\t]*(.*)$`, 'm').exec(fm)?.[1] ?? '')
  .replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();

function definitionHasModel(file) {
  const fm = frontmatter(readFileSync(file, 'utf8'));
  if (fm === null) return false;
  const model = fmValue(fm, 'model');
  return model !== '' && model.toLowerCase() !== 'inherit';
}

function mdFiles(dir, depth = 0, acc = []) {
  if (depth > 3 || acc.length > 500) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) mdFiles(join(dir, e.name), depth + 1, acc);
    else if (e.name.endsWith('.md')) acc.push(join(dir, e.name));
  }
  return acc;
}

// true: vlastní typ má definici s modelem. První nalezená definice rozhoduje (projekt před uživatelem).
function agentDefinedWithModel(type, input, env) {
  const project = env.CLAUDE_PROJECT_DIR || input.cwd;
  const config = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const dirs = [project && join(project, '.claude', 'agents'), join(config, 'agents')].filter(Boolean);
  for (const dir of dirs) {
    try {
      if (/[\\/]|\.\./.test(type)) continue;
      try { return definitionHasModel(join(dir, `${type}.md`)); } catch { /* soubor tohoto jména není */ }
      for (const f of mdFiles(dir)) {
        const fm = frontmatter(readFileSync(f, 'utf8'));
        if (fm !== null && fmValue(fm, 'name') === type) return definitionHasModel(f);
      }
    } catch { /* složka neexistuje nebo je nečitelná */ }
  }
  return false;
}

const FIX = "Když je opravdu potřeba model session, napiš jeho alias výslovně (např. model: 'opus'). Volba modelu a effortu: skill orchestrace, sekce 4. Model a effort. Vypnutí kontroly je rozhodnutí uživatele (viz README pluginu).";

function agentReason(ti, input, env) {
  const model = ti.model;
  if (model !== undefined && model !== null && !(typeof model === 'string' && model.trim() === '')) return null;
  const type = ti.subagent_type;
  if (type !== undefined && type !== null) {
    if (typeof type !== 'string') return null;
    if (type === 'fork' || type.includes(':')) return null;
    if (type && agentDefinedWithModel(type, input, env)) return null;
  }
  // Vestavěné typy mají vlastní výchozí model; seznam jmen by zastarával, proto jen odkaz na referenci.
  const builtin = typeof type === 'string' && type && type !== 'general-purpose'
    ? ' U vestavěného typu zadej model, na kterém má běžet (výchozí modely typů uvádí REFERENCE.md skillu orchestrace; Explore jinak dědí model session).'
    : '';
  return `Orchestrace: nástroj ${input.tool_name} bez pole model dědí model session a ten bývá nejdražší. Doplň model, např. model: 'sonnet' (haiku na mechanickou práci, opus na těžký úsudek).${builtin} ${FIX}`;
}

function workflowReason(ti, input, env) {
  let src = null;
  if (typeof ti.script === 'string' && ti.script.trim()) src = ti.script;
  else if (typeof ti.scriptPath === 'string' && ti.scriptPath.trim()) {
    try { src = readFileSync(resolve(input.cwd || '.', ti.scriptPath), 'utf8'); } catch { return null; }
  }
  if (src === null || src.length > MAX_SOURCE) return null;
  const bad = checkScript(src, (type) => agentDefinedWithModel(type, input, env));
  if (!bad.length) return null;
  const list = bad.slice(0, 10).map((b) => `řádek ${b.line} (chybí ${b.missing.join(' a ')})`).join(', ')
    + (bad.length > 10 ? ` a dalších ${bad.length - 10}` : '');
  return `Orchestrace: ve skriptu workflow nemá každé agent() model a effort, jinak běží na modelu session: ${list}. `
    + "Oprava: const LEVNE = { model: 'haiku', effort: 'medium' } a agent(p, {...LEVNE, schema}). "
    + `U agentType s modelem v definici agenta (vlastní typ, plugin:x, fork) stačí effort; vestavěné typy (general-purpose, Explore) model potřebují. ${FIX}`;
}

// Důvod zamítnutí, nebo null (povolit). Nikdy nevyhazuje výjimku.
export function decide(input, env = process.env) {
  try {
    if (String(env.ORCHESTRACE_GUARD ?? '').trim().toLowerCase() === 'off') return null;
    const ti = input?.tool_input;
    if (!ti || typeof ti !== 'object') return null;
    if (input.tool_name === 'Agent' || input.tool_name === 'Task') return agentReason(ti, input, env);
    if (input.tool_name === 'Workflow') return workflowReason(ti, input, env);
    return null;
  } catch { return null; }
}

if (isMain(import.meta.url)) {
  let reason = null;
  // BOM na začátku stdinu (PowerShell 5.1 ho při předání rourou přidává) by JSON.parse shodil a hook by tiše nic nehlídal
  try { reason = decide(JSON.parse(readFileSync(0, 'utf8').replace(/^\ufeff/, ''))); } catch { process.exit(0); }
  if (reason) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n');
  }
  process.exit(0);
}
