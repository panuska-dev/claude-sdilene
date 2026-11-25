#!/usr/bin/env node
// PreToolUse hook (Workflow, Agent, Task): každý subagent má výslovně zvolený model, ve workflow i effort.
// Proč: agent bez modelu dědí model session a ten bývá nejdražší (skill orchestrace, sekce 4. Model a effort).
// Při dávce desítek agentů bez modelu se tak snadno vyčerpá limit předplatného. Próza ve skillu to nedrží, hook ano.
//
// Co kontroluje:
// - Agent, Task (starý název): zamítne, když tool_input.model chybí nebo je prázdný. Výjimky: subagent_type
//   "fork"; subagent_type s dvojtečkou (agent z pluginu); vlastní typ, jehož definice má neprázdný model
//   (jiný než "inherit") v YAML frontmatteru. Definice se hledají tak, jak je hledá Claude Code: identitu
//   určuje frontmatter name (název souboru jen tehdy, když name chybí), prohledávají se všechny
//   .claude/agents od input.cwd nahoru po CLAUDE_PROJECT_DIR (nebo po složku s .git), pak
//   CLAUDE_PROJECT_DIR a <config>/agents (CLAUDE_CONFIG_DIR, jinak ~/.claude), vždy rekurzivně a nejbližší
//   definice vyhrává. Definice z managed settings a z přepínače --agents hook nevidí.
// - Workflow: zdroj je tool_input.script, jinak soubor tool_input.scriptPath. Každé volání agent( ve skriptu
//   musí mít druhý argument s klíči model a effort. Klíč agentType model nahradí stejně jako subagent_type
//   u Agent (fork, dvojtečka, vlastní typ s modelem v definici); vestavěný typ (general-purpose, Explore) model potřebuje.
//   Tokenizer přeskočí řetězce, šablony, komentáře a regex literály; spread a identifikátor options dohledá
//   jako const/let/var NAME = {...} v témže skriptu. Hledání options nezná rozsahy platnosti, proto je jméno
//   neznámé (a povolí se), když ho skript zavádí ještě jinde (parametr, jiná deklarace, destrukturování) nebo
//   objekt po deklaraci mění (NAME.klíč = ..., Object.assign(NAME, ...), NAME = ...). Objekt předaný cizí
//   funkci nebo jinak předaný dál (fill(NAME), alias) je neznámý a povolí se; getter get model() se bere jako
//   hodnota. Prázdná hodnota (undefined, null, void 0, false, '' i prázdná šablona) se bere jako chybějící.
// - Jméno agent zavedené ve skriptu jako lokální vazba (parametr, const/let/function) vypne kontrolu jen
//   uvnitř rozsahu té vazby (tělo funkce, blok, smyčka); var a deklarace na nejvyšší úrovni vypínají celý skript.
// - Vnořený workflow: volání workflow({ scriptPath: 'soubor.js' }) s řetězcovým literálem se zkontroluje
//   jedním zanořením (soubor se čte relativně k cwd, nálezy nesou cestu). Volání podle jména a cesta
//   z proměnné se nekontrolují.
// - agent použitý jako hodnota (alias, callback, pipeline(items, agent), Reflect.apply, .call) a \u escape
//   v identifikátoru se hlásí: kontrola vidí jen přímé volání agent(prompt, { model, effort }).
// - CLAUDE_CODE_SUBAGENT_MODEL_FORCE zapnuté (1, true): Claude model předat nemůže, takže hook model
//   nežádá (u Agent mlčí, ve workflow hlídá jen effort).
// - Hodnota modelu se nevaliduje proti seznamu (seznam by zastarával).
//
// Meze (kontrola je statická, nespouští skript): eval, new Function, globalThis['agent'], vypočtená jména
// a skript sestavený za běhu z textu. Takové obejití hook nevidí.
//
// Fail-open: chybný vstup, neznámý tvar, výjimka, nečitelný soubor, nedohledatelný spread nebo options,
// pole místo objektu v tool_input = bez výstupu a exit 0. Zamítá se jen tehdy, když chyba je jistá.
// Časový rozpočet: při dlouhém skriptu se kontrola po uplynutí rozpočtu zastaví a zamítne, co do té doby
// našla (timeout 10 s v hooks.json by hook ukončil a kontrola by tiše neproběhla).
//
// Na čem závisí: názvy nástrojů Workflow, Agent, Task; pole script, scriptPath, name, model, subagent_type
// a v API workflow funkce agent(prompt, options) s klíči model, effort, agentType a workflow({ scriptPath }).
// Když se cokoli z toho změní, hook mlčí a nic neblokuje; kontrola pak stárne tiše, proto ji drží test
// (orchestrace-guard.test.mjs).
//
// Vypínač: proměnná prostředí ORCHESTRACE_GUARD=off.
// Vstup: JSON PreToolUse na stdin. Při zamítnutí vypíše JSON s permissionDecision deny.
// Test: node orchestrace-guard.test.mjs (ve složce hooks pluginu; kontroluje i zapojení v hooks.json vedle sebe).
//
// Hook je jeden soubor bez závislostí mimo vestavěné moduly Node.js (funkce isMain je přímo níže).
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
const MAX_AGENT_FILES = 2000; // nejvýš tolik souborů .md se při dohledání vlastního typu přečte
const BUDGET_MS = 5000; // časový rozpočet kontroly skriptu, hook má timeout 10 s
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'delete', 'void', 'throw', 'new', 'instanceof', 'yield', 'await']);
const ID_PART = /[\p{ID_Continue}$‌‍]/u; // stejná definice identifikátoru v tokenizeru i ve vyhledávání
const REGEX_AFTER_PAREN_OF = new Set(['if', 'for', 'while', 'with']);
const REGEX_AFTER_CHAR = '(,=:[!&|?{};+-*%<>~^}';

// Vrátí text stejné délky, kde řetězce, komentáře a regex literály jsou nahrazené mezerami (konce řádků
// zůstávají, takže čísla řádků sedí). Šablonový literál se zruší, jen ${ ... } se změní na ( ... ),
// aby kód uvnitř zůstal vidět a závorky seděly. Vnoření šablon se řeší zásobníkem rámců, ne rekurzí,
// aby hluboce vnořený vstup nevyčerpal zásobník volání.
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

  // rámce: kód (nejvyšší úroveň nebo ${ } šablony) a text šablony
  const frames = [{ tpl: false, inTpl: false, depth: 0, parens: [] }];
  while (i < n) {
    const f = frames[frames.length - 1];
    const c = src[i], d = src[i + 1];
    if (f.tpl) {
      if (c === '\\') { blank(i++); if (i < n) blank(i++); continue; }
      if (c === '`') { blank(i++); frames.pop(); prev = 'val'; continue; }
      if (c === '$' && d === '{') { out[i] = ' '; out[i + 1] = '('; i += 2; frames.push({ tpl: false, inTpl: true, depth: 0, parens: [] }); continue; }
      blank(i++);
      continue;
    }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') blank(i++); continue; }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      while (i < end) blank(i++);
      continue;
    }
    if (c === '"' || c === "'") { skipString(c); prev = 'val'; continue; }
    if (c === '`') { blank(i++); frames.push({ tpl: true }); continue; }
    if (c === '{') { f.depth++; prev = c; i++; continue; }
    if (c === '}') {
      if (f.inTpl && f.depth === 0) { out[i] = ')'; i++; prev = 'val'; frames.pop(); continue; }
      f.depth--; prev = c; i++; continue;
    }
    if (c === '(') { f.parens.push(prev); prev = c; i++; continue; }
    if (c === ')') { prev = REGEX_AFTER_PAREN_OF.has(f.parens.pop()) ? 'if)' : 'val'; i++; continue; }
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

const EMPTY_VALUE = /^(?:(['"`])\1(?:\s*\+\s*(['"`])\2)*|undefined|null|void\s+0|false)$/;
const esc = (s) => s.replace(/\$/g, '\\$');

// Hodnota klíče: false = prázdná, true = je (neznámá), u agentType jediný řetězcový literál (i šablona bez ${}) jako text.
// maskedValue je text hodnoty z masky; je prázdný jen u samotného řetězce nebo šablony (operátor by v masce zůstal).
function valueOf(key, rawValue, maskedValue) {
  const v = rawValue.replace(/(?:\s*\/\*[\s\S]*?\*\/|\s*\/\/[^\n]*)+\s*$/, '').trim();
  if (EMPTY_VALUE.test(v)) return false;
  if (key !== 'agentType' || maskedValue.trim() !== '') return true;
  const lit = /^(?:(['"])((?:\\.|(?!\1)[^\\\n])*)\1|`((?:\\.|[^\\`$]|\$(?!\{))*)`)/.exec(v);
  return lit ? (lit[2] ?? lit[3]) : true;
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
// mapa otevírací -> zavírací závorka a mapa zavírací -> otevírací.
function structure(m) {
  const inner = new Int32Array(m.length);
  const close = new Map();
  const openOf = new Map();
  const stack = [];
  for (let k = 0; k < m.length; k++) {
    const c = m[k];
    if (c === '(' || c === '[' || c === '{') { inner[k] = stack.length ? stack[stack.length - 1] : -1; stack.push(k); continue; }
    if (c === ')' || c === ']' || c === '}') { const o = stack.pop(); if (o !== undefined) { close.set(o, k); openOf.set(k, o); } }
    inner[k] = stack.length ? stack[stack.length - 1] : -1;
  }
  return { inner, close, openOf };
}

const isSpace = (c) => c !== undefined && /\s/.test(c);

// Konec výrazu (nebo jednoho příkazu), který začíná na from: první čárka, středník nebo neuzavřená zavírací
// závorka na nejvyšší úrovni, nebo konec řádku, za kterým výraz nepokračuje. Vrací index prvního znaku za ním.
function exprEnd(m, from) {
  let depth = 0;
  for (let k = from; k < m.length; k++) {
    const c = m[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return k; depth--; }
    else if (depth === 0 && (c === ',' || c === ';')) return k;
    else if (depth === 0 && c === '\n') {
      let p = k - 1;
      while (p >= from && isSpace(m[p])) p--;
      let q = k + 1;
      while (q < m.length && isSpace(m[q])) q++;
      const last = p >= from ? m[p] : '';
      const next = m[q] ?? '';
      if (last === '' || '+-*/%&|^<>=!?:.,'.includes(last) || '.?:+-*/%&|^<>='.includes(next)) continue;
      return k;
    }
  }
  return m.length;
}

const isForParen = (m, o) => /\bfor\s*(?:await\s*)?$/.test(m.slice(Math.max(0, o - 20), o));

// Rozsah [from, to) platnosti jména vázaného na pozici pos jako deklarace kind (const, let, var, function, class).
// Celý skript, když deklarace není v žádném bloku (nejvyšší úroveň) nebo je to var mimo funkci.
function declRange(ctx, kind, pos) {
  const { m, inner, close, openOf } = ctx;
  const whole = { from: 0, to: m.length };
  const blockEnd = (o) => (close.get(o) ?? m.length - 1) + 1;
  if (kind === 'var') {
    for (let o = inner[pos]; o >= 0; o = inner[o]) {
      if (m[o] !== '{') continue;
      const s0 = Math.max(0, o - 200);
      const before = m.slice(s0, o).trimEnd();
      let fn = before.endsWith('=>');
      if (!fn && before.endsWith(')')) {
        const p = openOf.get(s0 + before.length - 1);
        const word = p === undefined ? undefined : /([\w$]+)\s*\*?\s*$/.exec(m.slice(Math.max(0, p - 60), p))?.[1];
        fn = word !== undefined && !KEYWORD_BEFORE_PARENS.has(word) && word !== 'catch';
      }
      if (fn) return { from: o, to: blockEnd(o) };
    }
    return whole;
  }
  for (let o = inner[pos]; o >= 0; o = inner[o]) {
    if (m[o] === '{') return { from: o, to: blockEnd(o) };
    if (m[o] === '(' && isForParen(m, o)) {
      const e = close.get(o);
      if (e === undefined) return whole;
      let a = e + 1;
      while (isSpace(m[a])) a++;
      return { from: o, to: m[a] === '{' ? blockEnd(a) : exprEnd(m, a) };
    }
  }
  return whole;
}

// Rozsah těla šipkové funkce, které => končí těsně před pozicí a.
function arrowRange(m, close, a) {
  while (isSpace(m[a])) a++;
  if (m[a] === '{') return { from: a, to: (close.get(a) ?? m.length - 1) + 1 };
  return { from: a, to: exprEnd(m, a) };
}

// Místa, kde ve skriptu vzniká nová vazba jména NAME: [{ idx, from, to }], idx je pozice jména
// a [from, to) rozsah, ve kterém vazba platí. Vazba je const/let/var/function/class, parametr funkce nebo
// šipky (včetně destrukturování), parametr catch, destrukturující deklarace a import.
// Hrubé a záměrně přísné: raději označí navíc, protože označené jméno se pak bere jako neznámé a povolí se.
function bindScopes(ctx, name) {
  const { m, inner, close } = ctx;
  const out = [];
  const re = new RegExp(String.raw`(?<!${ID_PART.source}|\.)${esc(name)}(?!${ID_PART.source})`, 'gu');
  for (const hit of m.matchAll(re)) {
    const idx = hit.index;
    const pre = m.slice(Math.max(0, idx - 40), idx);
    const kw = /\b(const|let|var|function|class)\s*\*?\s*$/.exec(pre);
    if (kw) { out.push({ idx, ...declRange(ctx, kw[1], idx - pre.length + kw.index) }); continue; }
    const post = m.slice(idx + name.length, idx + name.length + 20);
    const arrow = /^\s*=>/.exec(post);
    if (arrow) { out.push({ idx, ...arrowRange(m, close, idx + name.length + arrow[0].length) }); continue; }
    for (let o = inner[idx]; o >= 0; o = inner[o]) {
      let range = null;
      if (m[o] === '(') {
        const end = close.get(o);
        if (end !== undefined) {
          let a = end + 1;
          while (isSpace(m[a])) a++;
          if (m[a] === '=' && m[a + 1] === '>') range = arrowRange(m, close, a + 2);
          else if (m[a] === '{') {
            const word = /([\w$]+)\s*\*?\s*$/.exec(m.slice(Math.max(0, o - 60), o))?.[1];
            if (word !== undefined && !KEYWORD_BEFORE_PARENS.has(word)) range = { from: a, to: (close.get(a) ?? m.length - 1) + 1 }; // metoda, function, catch
          }
        }
      } else {
        const s0 = Math.max(0, o - 40);
        const km = /\b(const|let|var)\s*$/.exec(m.slice(s0, o));
        if (km) range = declRange(ctx, km[1], s0 + km.index); // destrukturování
        else if (m[o] === '{' && /\bimport\s*(?:[\w$]+\s*,\s*)?$/.test(m.slice(s0, o))) range = { from: 0, to: m.length };
      }
      if (range) { out.push({ idx, ...range }); break; }
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

// Kde je const/let/var NAME = { ... } (i Object.freeze({ ... })): { open, close } závorek objektu, jinak null.
// Null (neznámé, povolit) je to, když deklarace není právě jedna v celém skriptu, jméno zavádí něco dalšího
// (parametr, jiná deklarace v jiném bloku), nebo se objekt po deklaraci mění či předává dál. Výsledek je pro
// jméno stejný při každém volání, proto se pamatuje (jinak by cena rostla s počtem volání agent).
function declOf(ctx, name) {
  if (ctx.decls.has(name)) return ctx.decls.get(name);
  const found = findDecl(ctx, name);
  ctx.decls.set(name, found);
  return found;
}

function findDecl(ctx, name) {
  const { m } = ctx;
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  const re = new RegExp(String.raw`(?<![\w$.])(?:const|let|var)\s+${esc(name)}\s*=\s*(?:Object\s*\.\s*freeze\s*\(\s*)?\{`, 'g');
  const found = [...m.matchAll(re)];
  if (found.length !== 1) return null;
  const declIdx = found[0].index + /^(?:const|let|var)\s+/.exec(found[0][0])[0].length;
  if (bindScopes(ctx, name).some((b) => b.idx !== declIdx)) return null;
  if (mutated(m, name, declIdx)) return null;
  if (escapes(ctx, name, declIdx)) return null;
  const open = found[0].index + found[0][0].length - 1;
  const close = matching(m, open);
  return close < 0 ? null : { open, close };
}

function resolveObject(ctx, name, seen) {
  if (seen.size > 64) return null; // řetěz spreadů přes desítky konstant: neznámé, ať nevyčerpá zásobník
  const d = declOf(ctx, name);
  return d ? parseObject(ctx, d.open + 1, d.close, seen) : null;
}

// Druh složené závorky { na pozici o: 'class' (tělo třídy), 'object' (objektový literál) nebo 'block'.
function braceKind(m, o) {
  const before = m.slice(Math.max(0, o - 200), o).trimEnd();
  if (/\bclass\b[^{};()]*$/.test(before)) return 'class';
  if (before === '' || before.endsWith('=>') || /\b(?:else|try|finally|do)$/.test(before)) return 'block';
  return ')};{'.includes(before.slice(-1)) ? 'block' : 'object';
}

// První argument volání s hodnotou klíče key jako řetězcovým literálem (nebo šablonou bez ${}) v objektovém literálu.
function stringKey(ctx, from, to, key) {
  const { m, src } = ctx;
  const t = m.slice(from, to).trim();
  const open = from + (to - from - m.slice(from, to).trimStart().length);
  if (!t.startsWith('{') || matching(m, open) !== open + t.length - 1) return null;
  const keyRe = new RegExp(String.raw`^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*(?:${key}|(['"])${key}\1)\s*:\s*(?:(['"])((?:\\.|(?!\2)[^\\\n])*)\2|\`((?:\\.|[^\\\`$]|\$(?!\{))*)\`)\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*)*$`);
  for (const [s, e] of splitTop(m, open + 1, open + t.length - 1)) {
    const hit = keyRe.exec(src.slice(s, e));
    if (hit) return (hit[3] ?? hit[4]).replace(/\\(.)/g, '$1');
  }
  return null;
}

// Nálezy ve skriptu: [{ line, missing: ['model', 'effort'], kind?, file? }].
//  - volání agent( bez modelu nebo effortu: kind chybí, missing je seznam chybějících klíčů,
//  - kind 'value': agent použitý jako hodnota (alias, callback, pipeline(items, agent)),
//  - kind 'escape': \u escape v identifikátoru,
//  - file: cesta vnořeného workflow, ve kterém nález je.
// opts: modelForced (model se nežádá, hlídá se jen effort), loadScript(cesta) -> text nebo null pro workflow({ scriptPath }),
// deadline a nested jsou vnitřní.
export function checkScript(src, typeHasModel = () => false, opts = {}) {
  const deadline = opts.deadline ?? Date.now() + BUDGET_MS;
  const m = mask(src);
  const ctx = { m, src, ...structure(m), decls: new Map() };
  const scopes = bindScopes(ctx, 'agent');
  if (scopes.some((s) => s.from === 0 && s.to >= m.length)) return []; // agent je ve skriptu lokální jméno na nejvyšší úrovni: nejde o API workflow
  const bound = new Set(scopes.map((s) => s.idx));
  const inScope = (idx, list) => list.some((s) => idx >= s.from && idx < s.to);
  const bad = [];
  const breaks = [];
  for (let p = src.indexOf('\n'); p !== -1; p = src.indexOf('\n', p + 1)) breaks.push(p);
  const lineAt = (idx) => {
    let lo = 0, hi = breaks.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (breaks[mid] < idx) lo = mid + 1; else hi = mid; }
    return lo + 1;
  };
  const typeCache = new Map();
  const hasModel = (type) => {
    if (!typeCache.has(type)) typeCache.set(type, Boolean(typeHasModel(type)));
    return typeCache.get(type);
  };
  const idRe = (word) => new RegExp(String.raw`(?<!${ID_PART.source})${word}(?!${ID_PART.source})`, 'gu');
  const prevNonSpace = (idx) => { let b = idx - 1; while (b >= 0 && isSpace(m[b])) b--; return b; };
  const nextNonSpace = (idx) => { let k = idx; while (isSpace(m[k])) k++; return k; };
  // vlastnost (.agent, ?.agent), ne rozbalení (...agent)
  const isProperty = (b) => m[b] === '.' && !(m[b - 1] === '.' && m[b - 2] === '.');

  const escape = /\\u[0-9a-fA-F{]/.exec(m);
  if (escape) bad.push({ line: lineAt(escape.index), missing: [], kind: 'escape' });

  let steps = 0;
  const expired = () => (++steps & 127) === 0 && Date.now() > deadline;

  for (const hit of m.matchAll(idRe('agent'))) {
    if (expired()) return bad;
    const idx = hit.index;
    if (bound.has(idx) || inScope(idx, scopes)) continue;
    const b = prevNonSpace(idx);
    if (isProperty(b)) continue;
    const k = nextNonSpace(idx + 5);
    const line = lineAt(idx);
    if (m[k] !== '(') {
      // agent bez volání: vazba, klíč objektu a typeof se nepočítají, jinak je to hodnota (alias, callback, argument)
      if (m[k] === ':' && (m[b] === '{' || m[b] === ',')) continue;
      if (/\btypeof\s*$/.test(m.slice(Math.max(0, b - 10), b + 1))) continue;
      bad.push({ line, missing: [], kind: 'value' });
      continue;
    }
    if (/(?:\bfunction|\basync|\bclass)\s*\*?\s*$/.test(m.slice(Math.max(0, b - 10), b + 1))) continue;
    const close = matching(m, k);
    if (close < 0) continue;
    const after = nextNonSpace(close + 1);
    if (m[after] === '{') {
      // definice metody agent(...) { ... } je jen v těle třídy nebo objektového literálu hned za začátkem členu
      const o = ctx.inner[idx];
      if (o >= 0 && m[o] === '{' && braceKind(m, o) !== 'block') {
        const before = m.slice(Math.max(0, idx - 40), idx).replace(/(?:\b(?:async|static|get|set)\s+|\*\s*)+$/, '').trimEnd();
        if (before === '' || '{,;}'.includes(before.slice(-1))) continue;
      }
    }
    const args = splitTop(m, k + 1, close);
    const last = args[args.length - 1];
    if (!m.slice(...last).trim() && !/['"`\/]/.test(src.slice(...last))) args.pop(); // prázdný poslední argument (koncová čárka)
    if (args.some(([s, e]) => m.slice(s, e).trim().startsWith('...'))) continue; // argumenty z rozbalení: neznámé
    const need = opts.modelForced ? ['effort'] : ['model', 'effort'];
    if (args.length < 2) { bad.push({ line, missing: need }); continue; }
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
    const typeCovers = typeof type === 'string' ? type === 'fork' || type.includes(':') || hasModel(type) : Boolean(type);
    if (!opts.modelForced && !obj.keys.get('model') && !typeCovers) missing.push('model');
    if (!obj.keys.get('effort')) missing.push('effort');
    if (missing.length && !obj.unknown) bad.push({ line, missing });
  }

  // vnořený workflow: workflow({ scriptPath: 'soubor.js' }) se zkontroluje jedním zanořením (API dovoluje jen jednu úroveň)
  if (typeof opts.loadScript === 'function' && !opts.nested) {
    const wScopes = bindScopes(ctx, 'workflow');
    if (!wScopes.some((s) => s.from === 0 && s.to >= m.length)) {
      const wBound = new Set(wScopes.map((s) => s.idx));
      const seenPaths = new Map();
      for (const hit of m.matchAll(idRe('workflow'))) {
        if (expired()) return bad;
        const idx = hit.index;
        if (wBound.has(idx) || inScope(idx, wScopes)) continue;
        const b = prevNonSpace(idx);
        if (isProperty(b)) continue;
        const k = nextNonSpace(idx + 8);
        if (m[k] !== '(') continue;
        if (/(?:\bfunction|\basync|\bclass)\s*\*?\s*$/.test(m.slice(Math.max(0, b - 10), b + 1))) continue;
        const close = matching(m, k);
        if (close < 0) continue;
        const [fs, fe] = splitTop(m, k + 1, close)[0];
        const path = stringKey(ctx, fs, fe, 'scriptPath');
        if (!path || seenPaths.has(path)) continue;
        let child = null;
        try { child = opts.loadScript(path); } catch { /* nečitelný soubor: neznámé, povolit */ }
        const found = typeof child === 'string' ? checkScript(child, typeHasModel, { ...opts, loadScript: null, nested: true, deadline }) : [];
        seenPaths.set(path, true);
        for (const f of found) bad.push({ ...f, file: path });
      }
    }
  }
  return bad;
}

// Frontmatter agenta: klíč model je neprázdný a není "inherit" (to zdědí model session).
function frontmatter(text) {
  return /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? null;
}
const fmValue = (fm, key) => (new RegExp(`^${key}[ \\t]*:[ \\t]*(.*)$`, 'm').exec(fm)?.[1] ?? '')
  .replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();

const sameDir = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// Složky s definicemi agentů, nejbližší první: .claude/agents od cwd nahoru po CLAUDE_PROJECT_DIR (nebo po složku
// s .git; bez obojího po domovskou složku vyjma), pak CLAUDE_PROJECT_DIR a <config>/agents.
function agentDirs(input, env) {
  const dirs = [];
  const add = (d) => { const r = resolve(d); if (!dirs.some((x) => sameDir(x, r))) dirs.push(r); };
  const project = env.CLAUDE_PROJECT_DIR ? resolve(env.CLAUDE_PROJECT_DIR) : null;
  const home = resolve(homedir());
  if (typeof input.cwd === 'string' && input.cwd) {
    let dir = resolve(input.cwd);
    for (let level = 0; level < 40; level++) {
      add(join(dir, '.claude', 'agents'));
      if (project && sameDir(dir, project)) break;
      if (existsSync(join(dir, '.git'))) break;
      const up = dirname(dir);
      if (up === dir || sameDir(up, home)) break;
      dir = up;
    }
  }
  if (project) add(join(project, '.claude', 'agents'));
  add(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'agents'));
  return dirs;
}

// Všechny .md pod složkou (rekurzivně, bez pevné hloubky), nejvýš MAX_AGENT_FILES souborů celkem.
function scanAgents(dir, index, budget) {
  const queue = [dir];
  while (queue.length && budget.left > 0) {
    const cur = queue.shift();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; } // složka neexistuje nebo je nečitelná
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (budget.left <= 0) break;
      const full = join(cur, e.name);
      if (e.isDirectory()) { queue.push(full); continue; }
      if (!e.name.endsWith('.md')) continue;
      budget.left--;
      try {
        if (statSync(full).size > 1_000_000) continue;
        const fm = frontmatter(readFileSync(full, 'utf8'));
        if (fm === null) continue;
        const name = fmValue(fm, 'name') || basename(e.name, '.md');
        if (index.has(name)) continue; // nejbližší definice vyhrává
        const model = fmValue(fm, 'model');
        index.set(name, { file: full, hasModel: model !== '' && model.toLowerCase() !== 'inherit' });
      } catch { /* soubor se nepodařilo přečíst */ }
    }
  }
}

// Dohledání vlastního typu: lookup(typ) -> { status: 'model' | 'nomodel' | 'missing', file?, dirs }.
// Index definic se sestaví jednou za běh hooku, až když je potřeba.
function makeLookup(input, env) {
  let state = null;
  return (type) => {
    if (!state) {
      const dirs = agentDirs(input, env);
      const index = new Map();
      const budget = { left: MAX_AGENT_FILES };
      for (const d of dirs) scanAgents(d, index, budget);
      state = { dirs, index };
    }
    const hit = state.index.get(type);
    if (!hit) return { status: 'missing', dirs: state.dirs };
    return { status: hit.hasModel ? 'model' : 'nomodel', file: hit.file, dirs: state.dirs };
  };
}

const FIX = "Když je opravdu potřeba model session, napiš jeho alias výslovně (např. model: 'opus'). Volba modelu a effortu: skill orchestrace, sekce 4. Model a effort. Vypnutí kontroly je rozhodnutí uživatele (viz README pluginu).";

// Při zapnutém CLAUDE_CODE_SUBAGENT_MODEL_FORCE model určuje proměnná a Claude ho předat nemůže.
const modelForced = (env) => ['1', 'true', 'yes', 'on'].includes(String(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE ?? '').trim().toLowerCase());
const subagentModel = (env) => String(env.CLAUDE_CODE_SUBAGENT_MODEL ?? '').trim();

function dirList(dirs) {
  const shown = dirs.slice(0, 4).join(', ');
  return dirs.length > 4 ? `${shown} a dalších ${dirs.length - 4}` : shown;
}

function agentReason(ti, input, env, lookup) {
  if (modelForced(env)) return null;
  const model = ti.model;
  if (model !== undefined && model !== null && !(typeof model === 'string' && model.trim() === '')) return null;
  const type = ti.subagent_type;
  let found = null;
  if (type !== undefined && type !== null) {
    if (typeof type !== 'string') return null;
    if (type === 'fork' || type.includes(':')) return null;
    if (type) {
      found = lookup(type);
      if (found.status === 'model') return null;
    }
  }
  // Tři různé texty: vlastní typ s definicí bez modelu, typ bez nalezené definice (vestavěný, nebo vlastní), bez typu.
  // Seznam vestavěných jmen by zastarával, proto jen odkaz na referenci.
  let note = '';
  if (found && found.status === 'nomodel') {
    note = ` Definice agenta „${type}“ (${found.file}) nemá ve frontmatteru model, nebo má inherit. Doplň model do definice, nebo ho předej ve volání.`;
  } else if (found && type !== 'general-purpose') {
    note = ` Typ „${type}“ jsem mezi vlastními agenty nenašel (prohledáno: ${dirList(found.dirs)}). U vestavěného typu zadej model, na kterém má běžet (výchozí modely typů uvádí REFERENCE.md skillu orchestrace; Explore jinak dědí model session). U vlastního typu doplň model do jeho definice, nebo ho předej ve volání.`;
  }
  const sub = subagentModel(env);
  const without = sub
    ? `poběží na modelu z proměnné CLAUDE_CODE_SUBAGENT_MODEL (${sub}), ne na modelu zvoleném pro tento úkol`
    : 'dědí model session a ten bývá nejdražší';
  return `Orchestrace: nástroj ${input.tool_name} bez pole model ${without}. Doplň model, např. model: 'sonnet' (haiku na mechanickou práci, opus na těžký úsudek).${note} ${FIX}`;
}

function describe(b) {
  const where = b.file ? ` v ${b.file}` : '';
  if (b.kind === 'value') return `řádek ${b.line}${where} (agent předán jako hodnota)`;
  if (b.kind === 'escape') return `řádek ${b.line}${where} (\\u escape v identifikátoru)`;
  return `řádek ${b.line}${where} (chybí ${b.missing.join(' a ')})`;
}

function workflowReason(ti, input, env, lookup) {
  const readSource = (path) => {
    const text = readFileSync(resolve(input.cwd || '.', path), 'utf8');
    return text.length > MAX_SOURCE ? null : text;
  };
  let src = null;
  if (typeof ti.script === 'string' && ti.script.trim()) src = ti.script;
  else if (typeof ti.scriptPath === 'string' && ti.scriptPath.trim()) {
    try { src = readSource(ti.scriptPath); } catch { return null; }
  }
  if (src === null || src.length > MAX_SOURCE) return null;
  const bad = checkScript(src, (type) => lookup(type).status === 'model', { modelForced: modelForced(env), loadScript: readSource });
  if (!bad.length) return null;
  const list = bad.slice(0, 10).map(describe).join(', ') + (bad.length > 10 ? ` a dalších ${bad.length - 10}` : '');
  const sub = subagentModel(env);
  const inherit = sub ? 'jinak běží na modelu session nebo na modelu z CLAUDE_CODE_SUBAGENT_MODEL' : 'jinak běží na modelu session';
  const lead = bad.some((b) => !b.kind)
    ? `Orchestrace: ve skriptu workflow nemá každé agent() ${modelForced(env) ? 'effort' : 'model a effort'}, ${inherit}: ${list}. `
    : `Orchestrace: ve skriptu workflow nejde ověřit ${modelForced(env) ? 'effort' : 'model a effort'} u agent(): ${list}. `;
  const value = bad.some((b) => b.kind)
    ? 'agent předávej jen přímým voláním agent(prompt, { model, effort }); alias, callback, pipeline(items, agent) a \\u escape kontrola nevidí. '
    : '';
  return lead
    + "Oprava: const LEVNE = { model: 'haiku', effort: 'medium' } a agent(p, {...LEVNE, schema}). "
    + value
    + `U agentType s modelem v definici agenta (vlastní typ, plugin:x, fork) stačí effort; vestavěné typy (general-purpose, Explore) model potřebují. ${FIX}`;
}

// Důvod zamítnutí, nebo null (povolit). Nikdy nevyhazuje výjimku.
export function decide(input, env = process.env) {
  try {
    if (String(env.ORCHESTRACE_GUARD ?? '').trim().toLowerCase() === 'off') return null;
    const ti = input?.tool_input;
    if (!ti || typeof ti !== 'object' || Array.isArray(ti)) return null;
    const lookup = makeLookup(input, env);
    if (input.tool_name === 'Agent' || input.tool_name === 'Task') return agentReason(ti, input, env, lookup);
    if (input.tool_name === 'Workflow') return workflowReason(ti, input, env, lookup);
    return null;
  } catch { return null; }
}

if (isMain(import.meta.url)) {
  let reason = null;
  // BOM na začátku stdinu (PowerShell 5.1 ho při předání rourou přidává) by JSON.parse shodil a hook by tiše nic nehlídal
  try { reason = decide(JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, ''))); } catch { process.exit(0); }
  if (reason) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n');
  }
  process.exit(0);
}
