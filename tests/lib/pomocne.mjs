// Sdílené pomocné funkce testů. Jen vestavěné moduly Node.js, žádná síť, žádný zápis mimo dočasné složky.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { delimiter, join, relative, sep } from 'node:path';
import assert from 'node:assert/strict';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const posix = (p) => p.split(sep).join('/');

// ---------------------------------------------------------------- soubory repa

const PRESKOC_ADRESARE = new Set(['.git', 'node_modules']);

function projdi(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (PRESKOC_ADRESARE.has(e.name)) continue;
    const plna = join(dir, e.name);
    if (e.isDirectory()) projdi(plna, out);
    else if (e.isFile()) out.push(posix(relative(ROOT, plna)));
  }
  return out;
}

// Soubory repa: sledované i nové nesledované (mimo .gitignore), takže test hlídá i to, co se teprve přidá.
// Bez gitu (nebo mimo repozitář) se prochází strom a vynechá se to, co .gitignore obvykle vylučuje.
export function soubory() {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0 && !r.error) {
    return [...new Set(r.stdout.split('\0').filter(Boolean))]
      .filter((f) => existsSync(join(ROOT, f)))
      .sort();
  }
  return projdi(ROOT)
    .filter((f) => !/(^|\/)(\.DS_Store|Thumbs\.db)$/.test(f) && !/\.local\.txt$/.test(f))
    .sort();
}

export const cesta = (rel) => join(ROOT, ...rel.split('/'));
export const existuje = (rel) => existsSync(cesta(rel));
export const ctiBuffer = (rel) => readFileSync(cesta(rel));
export const cti = (rel) => readFileSync(cesta(rel), 'utf8');
export const jeBinarni = (buf) => buf.includes(0);

export function ctiJson(rel) {
  try {
    return JSON.parse(cti(rel));
  } catch (e) {
    assert.fail(`Soubor ${rel} není platný JSON (${e.message}). Oprav syntaxi, nejrychleji přes "node -e \\"JSON.parse(require('fs').readFileSync('${rel}','utf8'))\\"".`);
  }
}

export function jeSlozka(rel) {
  try { return statSync(cesta(rel)).isDirectory(); } catch { return false; }
}

// Selže, když je seznam nálezů neprázdný; zpráva říká, co je špatně, a pod ní vypíše každý nález.
export function nic(zprava, nalezy) {
  if (nalezy.length) assert.fail(`${zprava}\n  - ${nalezy.join('\n  - ')}`);
}

// ---------------------------------------------------------------- zakázané řetězce

// Formát souboru: prázdné řádky a řádky začínající # se přeskočí. "re: výraz" je regulární výraz (bez ohledu na
// velikost písmen, unicode), "povol: výraz" je výjimka (shoda, kterou výraz pokrývá, se ignoruje), cokoli
// jiného je doslovný text bez ohledu na velikost písmen.
export function parsujZakazane(text, zdroj) {
  const vzory = [];
  const povolene = [];
  text.split(/\r?\n/).forEach((surovy, i) => {
    const radek = surovy.trim();
    if (!radek || radek.startsWith('#')) return;
    const misto = `${zdroj}:${i + 1}`;
    const zkompiluj = (vyraz) => {
      try { return new RegExp(vyraz, 'iu'); } catch (e) {
        return assert.fail(`${misto}: neplatný regulární výraz "${vyraz}" (${e.message}). Oprav ho, nebo ho zapiš jako doslovný text bez "re:".`);
      }
    };
    if (radek.startsWith('re:')) vzory.push({ misto, text: radek, re: zkompiluj(radek.slice(3).trim()) });
    else if (radek.startsWith('povol:')) povolene.push(zkompiluj(radek.slice(6).trim()));
    else vzory.push({ misto, text: radek, re: zkompiluj(radek.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
  });
  return { vzory, povolene };
}

export function najdiZakazane(text, { vzory, povolene }) {
  const nalezy = [];
  text.split('\n').forEach((radek, i) => {
    for (const v of vzory) {
      const re = new RegExp(v.re.source, 'giu');
      for (const m of radek.matchAll(re)) {
        if (povolene.some((p) => p.test(m[0]))) continue;
        nalezy.push({ radek: i + 1, vzor: v.text, shoda: m[0] });
      }
    }
  });
  return nalezy;
}

// ---------------------------------------------------------------- frontmatter a markdown

// Frontmatter SKILL.md: první řádek musí být ---, hodnoty jsou jednořádkové (nebo odsazené pokračování).
export function parsujFrontmatter(text) {
  if (!text.startsWith('---\n')) return { chyba: 'první řádek souboru není "---" (frontmatter musí začínat na řádku 1)' };
  const radky = text.split('\n');
  const konec = radky.indexOf('---', 1);
  if (konec < 0) return { chyba: 'frontmatter nemá uzavírací řádek "---"' };
  const data = {};
  let klic = null;
  for (let i = 1; i < konec; i++) {
    const r = radky[i];
    if (!r.trim()) continue;
    const m = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(r);
    if (m && !/^\s/.test(r)) {
      klic = m[1];
      let v = (m[2] ?? '').trim();
      if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
      data[klic] = v;
    } else if (klic && /^\s/.test(r)) {
      data[klic] = `${data[klic]} ${r.trim()}`.trim();
    } else {
      return { chyba: `řádek ${i + 1} frontmatteru není ve tvaru "klíč: hodnota": ${r}` };
    }
  }
  return { data, telo: radky.slice(konec + 1).join('\n'), delkaFrontmatteru: konec + 1 };
}

// Odstraní bloky kódu ohrazené ``` nebo ~~~ (řádky nahradí prázdnými, aby čísla řádků zůstala).
export function bezBlokuKodu(text) {
  let uvnitr = null;
  return text.split('\n').map((r) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(r);
    if (m) {
      if (!uvnitr) uvnitr = m[1][0];
      else if (uvnitr === m[1][0]) uvnitr = null;
      return '';
    }
    return uvnitr ? '' : r;
  }).join('\n');
}

// Kotva nadpisu podle pravidel GitHubu: malá písmena, bez interpunkce, mezery na pomlčky.
export function kotva(nadpis) {
  return nadpis
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

export function nadpisy(text) {
  const kotvy = new Set();
  const videno = new Map();
  const seznam = [];
  bezBlokuKodu(text).split('\n').forEach((r, i) => {
    const m = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(r);
    if (!m) return;
    const zaklad = kotva(m[2]);
    const n = videno.get(zaklad) ?? 0;
    videno.set(zaklad, n + 1);
    kotvy.add(n ? `${zaklad}-${n}` : zaklad);
    seznam.push({ uroven: m[1].length, text: m[2], radek: i + 1 });
  });
  return { kotvy, seznam };
}

// Odkazy [text](cíl) mimo bloky kódu a mimo inline kód.
export function odkazyMd(text) {
  const out = [];
  bezBlokuKodu(text).split('\n').forEach((r, i) => {
    const bezKodu = r.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length));
    for (const m of bezKodu.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push({ cil: m[1], radek: i + 1 });
  });
  return out;
}

// Texty v inline kódu (mezi zpětnými apostrofy), mimo bloky kódu.
export function inlineKod(text) {
  const out = [];
  bezBlokuKodu(text).split('\n').forEach((r, i) => {
    for (const m of r.matchAll(/`([^`]+)`/g)) out.push({ text: m[1], radek: i + 1 });
  });
  return out;
}

// ---------------------------------------------------------------- spouštění procesů

// Prostředí bez čehokoli, co by ovlivnilo výsledek: proměnné CLAUDE*/ANTHROPIC* (například CLAUDE_CODE_PLUGIN_DIRS
// nebo CLAUDE_CODE_SUBAGENT_MODEL z okolní session), ORCHESTRACE_GUARD, NODE_TEST_CONTEXT z běhu node --test a GIT_*
// (pod pre-commit hookem míří GIT_DIR a GIT_INDEX_FILE na skutečné repo a dočasné repozitáře v testech by sahaly na něj).
export function cistyEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC|ORCHESTRACE|NODE_TEST|GIT_)/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

// Pojistka proti zaseknutí, ne odhad délky běhu.
export const LIMIT_PROCESU_MS = 180_000;

export function najdiClaude() {
  const pripony = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const p of pripony) {
      const kandidat = join(dir, `claude${p}`);
      try { if (statSync(kandidat).isFile()) return kandidat; } catch { /* další */ }
    }
  }
  return null;
}

// Spustí claude bez shellu (na Windows přes cmd.exe jen u .cmd/.bat obálky, jinak by Node vrátil EINVAL).
export function spustClaude(claude, args, { env, cwd, input } = {}) {
  const opts = { env, cwd, input, encoding: 'utf8', timeout: LIMIT_PROCESU_MS, maxBuffer: 256 * 1024 * 1024 };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(claude)) {
    const radek = [claude, ...args].map((a) => `"${a.replace(/"/g, '""')}"`).join(' ');
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${radek}"`], { ...opts, windowsVerbatimArguments: true });
  }
  return spawnSync(claude, args, opts);
}

// ---------------------------------------------------------------- manifesty

export function nactiMarketplace() {
  return ctiJson('.claude-plugin/marketplace.json');
}

// Pluginy z marketplace.json: { name, slozka (relativní od kořene repa, s lomítky) }.
export function pluginy() {
  const mp = nactiMarketplace();
  assert.ok(Array.isArray(mp.plugins), 'marketplace.json nemá pole "plugins".');
  return mp.plugins.map((p) => ({ name: p.name, source: p.source, slozka: String(p.source).replace(/^\.\//, '').replace(/\/$/, '') }));
}

// ---------------------------------------------------------------- spuštění hooku jako Claude Code

export const HOOK_REL = 'plugins/orchestrace/hooks/orchestrace-guard.mjs';
export const HOOK = cesta(HOOK_REL);

let prostredi = null;
// Prázdná konfigurace a prázdný projekt v dočasné složce: hook nikdy nečte skutečný ~/.claude ani .claude/agents repa.
export function prazdneProstredi() {
  if (!prostredi) {
    const koren = mkdtempSync(join(tmpdir(), 'claude-sdilene-test-'));
    const cfg = join(koren, 'cfg');
    const proj = join(koren, 'proj');
    mkdirSync(cfg, { recursive: true });
    mkdirSync(proj, { recursive: true });
    process.on('exit', () => { try { rmSync(koren, { recursive: true, force: true }); } catch { /* dočasná složka */ } });
    prostredi = { koren, cfg, proj };
  }
  return prostredi;
}

// Spustí hook přes stdin (JSON PreToolUse) v čistém prostředí, vrátí i rozparsovaný výstup.
export function spustHook(vstup, env = {}, hook = HOOK) {
  const { cfg, proj } = prazdneProstredi();
  const text = typeof vstup === 'string' ? vstup : JSON.stringify(vstup);
  const r = spawnSync(process.execPath, [hook], {
    input: text, encoding: 'utf8', cwd: proj, timeout: LIMIT_PROCESU_MS, maxBuffer: 256 * 1024 * 1024,
    env: cistyEnv({ CLAUDE_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: proj, ...env }),
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* prázdný výstup je v pořádku */ }
  const out = json?.hookSpecificOutput;
  return {
    status: r.status, signal: r.signal, error: r.error, stdout: r.stdout, stderr: r.stderr,
    deny: out?.permissionDecision === 'deny', reason: out?.permissionDecisionReason ?? '', hookEventName: out?.hookEventName,
  };
}
