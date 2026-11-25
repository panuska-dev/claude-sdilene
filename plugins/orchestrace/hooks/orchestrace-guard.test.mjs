// Testy orchestrace-guard.mjs (node:test a node:assert, bez závislostí; Node 18 a novější).
// Spuštění z kořene repa: node --test plugins/orchestrace/hooks/orchestrace-guard.test.mjs
//
// Co test nedělá: nepoužívá síť, nezapisuje nic mimo os.tmpdir() (vše se po běhu smaže) a nečte skutečný
// ~/.claude ani skutečné agenty uživatele: CLAUDE_CONFIG_DIR, CLAUDE_PROJECT_DIR, HOME a USERPROFILE míří
// do dočasné složky a proměnné CLAUDE_* a ORCHESTRACE_* z prostředí vývojáře se do podprocesů nepřenášejí.
//
// Co test hlídá:
// - decide() a checkScript(): všechny větve (Agent, Task, vlastní typy, Workflow, agent(), vnořený workflow),
// - mask() a isMain(): pomocné funkce, na kterých kontrola stojí,
// - hook jako proces: příkaz a args přesně podle hooks.json (exec form bez shellu), stdin, stdout, exit kód,
// - zapojení v hooks.json: matcher, exec form, cesta přes ${CLAUDE_PLUGIN_ROOT}, žádné pole shell,
// - fail-open: nic, co hook nepochopí, nesmí zablokovat práci ani shodit proces.
// Když test selže, hláška říká, co se čekalo, co hook udělal a kde opravit.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkScript, decide, isMain, mask } from './orchestrace-guard.mjs';

const HOOK = fileURLToPath(new URL('./orchestrace-guard.mjs', import.meta.url));
const HOOKS_JSON = fileURLToPath(new URL('./hooks.json', import.meta.url));
const HOOKS_DIR = dirname(HOOKS_JSON);
const PLUGIN_ROOT = resolve(HOOKS_DIR, '..');
const KDE = 'plugins/orchestrace/hooks/orchestrace-guard.mjs';
const KDE_JSON = 'plugins/orchestrace/hooks/hooks.json';
const EM_DASH = String.fromCodePoint(0x2014);

const J = (v) => JSON.stringify(v);
const kratce = (v) => {
  let s;
  try { s = typeof v === 'string' ? v : J(v); } catch { s = '[nelze zobrazit]'; }
  if (typeof s !== 'string') s = String(v);
  return s.length > 400 ? `${s.slice(0, 400)}... (${s.length} znaků)` : s;
};

// Porovnání se zprávou v češtině: co se čekalo, co přišlo a kde opravit.
function rovno(got, want, co, kde = KDE) {
  assert.deepStrictEqual(got, want, `${co}\n  dostal: ${kratce(got)}\n  čekal:  ${kratce(want)}\n  Oprava: ${kde} (nebo tento test, když se chování změnilo záměrně)`);
}
function plati(cond, co, kde = KDE) {
  assert.ok(cond, `${co}\n  Oprava: ${kde} (nebo tento test, když se chování změnilo záměrně)`);
}

// Pracovní složka s definicemi agentů. CONFIG je vlastní a skutečný ~/.claude se nečte.
const root = mkdtempSync(join(tmpdir(), 'orchestrace-guard-'));
after(() => { rmSync(root, { recursive: true, force: true }); });
const proj = join(root, 'proj');
const agents = join(proj, '.claude', 'agents');
const cfg = join(root, 'cfg');
const cfgAgents = join(cfg, 'agents');
const home = join(root, 'home');
mkdirSync(join(proj, '.git'), { recursive: true }); // zarážka: hledání .claude/agents od cwd nahoru tu končí
mkdirSync(cfgAgents, { recursive: true });
mkdirSync(join(home, '.claude', 'agents'), { recursive: true });

function soubor(cesta, obsah) {
  mkdirSync(dirname(cesta), { recursive: true });
  writeFileSync(cesta, obsah);
  return cesta;
}
const fm = (...radky) => `---\n${radky.join('\n')}\n---\nTělo\n`;

soubor(join(agents, 'ma-model.md'), '---\nname: ma-model\nmodel: haiku\n---\nTělo\n');
soubor(join(agents, 'bez-modelu.md'), '---\nname: bez-modelu\ndescription: x\n---\nTělo\n');
soubor(join(agents, 'dedi.md'), '---\nname: dedi\nmodel: inherit\n---\nTělo\n');
soubor(join(agents, 'crlf.md'), '---\r\nname: crlf\r\nmodel: "sonnet"\r\n---\r\nTělo\r\n');
soubor(join(agents, 'jiny-soubor.md'), '---\nname: pod-jinym-jmenem\nmodel: opus\n---\n');
soubor(join(agents, 'reviewer.md'), fm('name: reviewer', 'model: haiku'));
soubor(join(agents, 'komentar.md'), fm('name: komentar', 'model: haiku # levný'));
soubor(join(agents, 'prazdny-model.md'), fm('name: prazdny-model', 'model:'));
soubor(join(agents, 'prazdny-uvozovky.md'), fm('name: prazdny-uvozovky', 'model: ""'));
soubor(join(agents, 'velke-inherit.md'), fm('name: velke-inherit', 'model: INHERIT'));
soubor(join(agents, 'velke-klic.md'), fm('name: velke-klic', 'Model: haiku'));
soubor(join(agents, 'modelx.md'), fm('name: modelx', 'modelx: haiku'));
soubor(join(agents, 'odsazeny.md'), fm('name: odsazeny', 'meta:', '  model: haiku'));
soubor(join(agents, 'bez-frontmatteru.md'), 'Žádný frontmatter\nmodel: haiku\n');
soubor(join(agents, 'bez-zavreni.md'), '---\nname: bez-zavreni\nmodel: haiku\nTělo bez uzavření\n');
soubor(join(agents, 'bom.md'), '﻿---\nname: bom\nmodel: opus\n---\n');
soubor(join(agents, 'bez-name.md'), fm('model: haiku'));
soubor(join(agents, 'citovany.md'), fm('name: "citovany"', "model: 'opus'"));
soubor(join(agents, 'jen-txt.txt'), fm('name: jen-txt', 'model: haiku'));
soubor(join(agents, 'tym', 'vnoreny.md'), fm('name: vnoreny', 'model: haiku'));
soubor(join(agents, 'a', 'b', 'c', 'hluboky.md'), fm('name: hluboky', 'model: haiku'));
soubor(join(agents, 'duplikat.md'), fm('name: duplikat', 'description: mělčí soubor bez modelu'));
soubor(join(agents, 'zanoreny', 'duplikat.md'), fm('name: duplikat', 'model: haiku'));
soubor(join(agents, 'projekt-vs-config.md'), fm('name: projekt-vs-config', 'description: bez modelu'));
soubor(join(cfgAgents, 'projekt-vs-config.md'), fm('name: projekt-vs-config', 'model: haiku'));
soubor(join(agents, 'config-bez-modelu.md'), fm('name: config-bez-modelu', 'model: haiku'));
soubor(join(cfgAgents, 'config-bez-modelu.md'), fm('name: config-bez-modelu', 'description: bez modelu'));
soubor(join(cfgAgents, 'z-konfigurace.md'), fm('name: z-konfigurace', 'model: haiku'));
soubor(join(home, '.claude', 'agents', 'z-domova.md'), fm('name: z-domova', 'model: haiku'));

// agenti nad cwd: nejbližší .claude/agents vyhrává, hledání končí u CLAUDE_PROJECT_DIR nebo u složky s .git
soubor(join(proj, 'sub', '.claude', 'agents', 'bliz.md'), fm('name: bliz', 'description: bez modelu'));
soubor(join(agents, 'bliz.md'), fm('name: bliz', 'model: haiku'));
soubor(join(proj, 'sub', '.claude', 'agents', 'jen-v-sub.md'), fm('name: jen-v-sub', 'model: haiku'));
const deep = join(proj, 'sub', 'a', 'b', 'c', 'd');
mkdirSync(deep, { recursive: true });
soubor(join(root, 'outer', '.claude', 'agents', 'nad-gitem.md'), fm('name: nad-gitem', 'model: haiku'));
mkdirSync(join(root, 'outer', 'repo', '.git'), { recursive: true });
mkdirSync(join(root, 'outer', 'repo', 'src'), { recursive: true });
soubor(join(root, 'outer2', '.claude', 'agents', 'nad-projektem.md'), fm('name: nad-projektem', 'model: haiku'));
mkdirSync(join(root, 'outer2', 'proj', 'src'), { recursive: true });
soubor(join(root, 'outer3', '.claude', 'agents', 'nad-worktree.md'), fm('name: nad-worktree', 'model: haiku'));
soubor(join(root, 'outer3', 'wt', '.git'), 'gitdir: /nekam/jinam\n'); // worktree má .git jako soubor
mkdirSync(join(root, 'outer3', 'wt', 'src'), { recursive: true });

const ENV = { CLAUDE_PROJECT_DIR: proj, CLAUDE_CONFIG_DIR: cfg };

// vstupy nástrojů
const agent = (ti, tool = 'Agent') => ({ tool_name: tool, tool_input: ti });
const wf = (script, extra = {}) => ({ tool_name: 'Workflow', tool_input: { script }, ...extra });
const wfPath = (scriptPath, extra = {}) => ({ tool_name: 'Workflow', tool_input: { scriptPath }, ...extra });

function zamitne(input, env = ENV, co = 'Hook měl zamítnout') {
  const r = decide(input, env);
  plati(typeof r === 'string' && r.length > 0, `${co}, ale povolil.\n  Vstup: ${kratce(input)}`);
  return r;
}
function povoli(input, env = ENV, co = 'Hook měl povolit') {
  const r = decide(input, env);
  plati(r === null, `${co}, ale zamítl.\n  Vstup: ${kratce(input)}\n  Důvod: ${kratce(r ?? '')}`);
}
// kontrola jednotlivých řádků: [{ line, missing }] -> ['řádek:chybějící+klíče']
const lines = (script, hasModel = (type) => type === 'reviewer', opts = {}) => checkScript(script, hasModel, opts).map((b) => `${b.line}:${b.missing.join('+')}`);
const kinds = (script) => checkScript(script, () => false).map((b) => `${b.line}:${b.kind ?? 'chybí ' + b.missing.join('+')}`);

// Prostředí podprocesu: bez proměnných CLAUDE_* a ORCHESTRACE_* vývojáře, s domovem v dočasné složce.
function cleanEnv(extra = {}) {
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE_|ORCHESTRACE_)/i.test(k)) base[k] = v;
  return { ...base, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: proj, ...extra };
}

// hooks.json: příkaz a args tak, jak je spustí Claude Code (exec form, bez shellu, ${CLAUDE_PLUGIN_ROOT} dosazený)
function loadHooks() {
  try { return JSON.parse(readFileSync(HOOKS_JSON, 'utf8')); } catch { return null; }
}
const pluginHooks = loadHooks();
const entries = pluginHooks?.hooks?.PreToolUse ?? [];
const entry = entries.find((h) => h.matcher === 'Workflow|Agent|Task');
const handler = entry?.hooks?.find((x) => (x.args ?? []).some((a) => a.endsWith('/hooks/orchestrace-guard.mjs')));
function wiredArgs(rootDir = PLUGIN_ROOT) {
  return (handler?.args ?? []).map((a) => a.split('${CLAUDE_PLUGIN_ROOT}').join(rootDir));
}

// Spustí hook jako proces tak, jak to udělá Claude Code: command a args z hooks.json, shell: false, JSON na stdin.
function spawnHook(input, { env = {}, cwd, rootDir = PLUGIN_ROOT, timeout = 20000 } = {}) {
  plati(handler !== undefined, `V ${KDE_JSON} chybí handler hooku orchestrace-guard.mjs, proces nejde spustit.`, KDE_JSON);
  const stdin = typeof input === 'string' ? input : J(input);
  const r = spawnSync(handler.command, wiredArgs(rootDir), {
    input: stdin, encoding: 'utf8', shell: false, cwd, timeout,
    env: cleanEnv({ CLAUDE_PLUGIN_ROOT: rootDir, ...env }),
  });
  assert.ok(!r.error, `Proces hooku se nespustil nebo vypršel čas (${r.error?.code ?? r.error?.message}). Příkaz: ${handler.command} ${wiredArgs(rootDir).join(' ')}`);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* json zůstane null */ }
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, json };
}
function jeZamitnuti(r) {
  return r.status === 0 && r.stderr === '' && r.json?.hookSpecificOutput?.permissionDecision === 'deny';
}
function mlci(r) {
  return r.status === 0 && r.stdout === '' && r.stderr === '';
}
const popis = (r) => `exit ${r.status}${r.signal ? ` (signál ${r.signal})` : ''}, stdout ${kratce(r.stdout)}, stderr ${kratce(r.stderr)}`;

// pseudonáhodný generátor se pevným semínkem: stejná sada vstupů při každém běhu
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// ---------------------------------------------------------------------------------------------------------
// nástroj Agent a Task
// ---------------------------------------------------------------------------------------------------------
const AGENT_ROWS = [
  // [název, tool_input, zamítne?, env (výchozí ENV)]
  ['bez model', { prompt: 'x' }, true],
  ['model prázdný řetězec', { prompt: 'x', model: '' }, true],
  ['model jen mezery', { prompt: 'x', model: '  ' }, true],
  ['model jen bílé znaky (tabulátor, nový řádek)', { prompt: 'x', model: '\t\n' }, true],
  ['model null', { prompt: 'x', model: null }, true],
  ['s model', { prompt: 'x', model: 'sonnet' }, false],
  ['model s mezerami kolem', { prompt: 'x', model: ' haiku ' }, false],
  ['bez effort je v pořádku (effort se u Agent nežádá)', { prompt: 'x', model: 'haiku' }, false],
  ['hodnota modelu se nevaliduje (inherit)', { prompt: 'x', model: 'inherit' }, false],
  ['hodnota modelu se nevaliduje (neznámé jméno)', { prompt: 'x', model: 'neexistujici-model-9' }, false],
  ['model jiného typu (číslo) je neznámý tvar', { prompt: 'x', model: 5 }, false],
  ['model jiného typu (objekt) je neznámý tvar', { prompt: 'x', model: {} }, false],
  ['model false je neznámý tvar', { prompt: 'x', model: false }, false],
  ['general-purpose bez model', { prompt: 'x', subagent_type: 'general-purpose' }, true],
  ['general-purpose s model', { prompt: 'x', subagent_type: 'general-purpose', model: 'haiku' }, false],
  ['Explore bez model', { prompt: 'x', subagent_type: 'Explore' }, true],
  ['Explore s model', { prompt: 'x', subagent_type: 'Explore', model: 'haiku' }, false],
  ['claude-code-guide bez model', { prompt: 'x', subagent_type: 'claude-code-guide' }, true],
  ['claude-code-guide s model', { prompt: 'x', subagent_type: 'claude-code-guide', model: 'haiku' }, false],
  ['fork bez model', { prompt: 'x', subagent_type: 'fork' }, false],
  ['fork s model', { prompt: 'x', subagent_type: 'fork', model: 'opus' }, false],
  ['agent z pluginu (dvojtečka)', { prompt: 'x', subagent_type: 'plugin:reviewer' }, false],
  ['agent z pluginu s víc dvojtečkami', { prompt: 'x', subagent_type: 'a:b:c' }, false],
  ['subagent_type prázdný řetězec se bere jako bez typu', { prompt: 'x', subagent_type: '' }, true],
  ['subagent_type null se bere jako bez typu', { prompt: 'x', subagent_type: null }, true],
  ['subagent_type jiného typu (číslo) je neznámý tvar', { prompt: 'x', subagent_type: 5 }, false],
  ['subagent_type jiného typu (pole) je neznámý tvar', { prompt: 'x', subagent_type: [] }, false],
  ['vlastní typ s model ve frontmatteru', { prompt: 'x', subagent_type: 'ma-model' }, false],
  ['vlastní typ s model, CRLF a uvozovky', { prompt: 'x', subagent_type: 'crlf' }, false],
  ['vlastní typ podle name ve frontmatteru (ne podle názvu souboru)', { prompt: 'x', subagent_type: 'pod-jinym-jmenem' }, false],
  ['název souboru neplatí, když má frontmatter jiné name', { prompt: 'x', subagent_type: 'jiny-soubor' }, true],
  ['vlastní typ bez model', { prompt: 'x', subagent_type: 'bez-modelu' }, true],
  ['vlastní typ s model: inherit', { prompt: 'x', subagent_type: 'dedi' }, true],
  ['vlastní typ s model: INHERIT (velká písmena)', { prompt: 'x', subagent_type: 'velke-inherit' }, true],
  ['vlastní typ s prázdným model:', { prompt: 'x', subagent_type: 'prazdny-model' }, true],
  ['vlastní typ s model: "" (prázdné uvozovky)', { prompt: 'x', subagent_type: 'prazdny-uvozovky' }, true],
  ['vlastní typ s Model: (klíč s velkým M se nebere)', { prompt: 'x', subagent_type: 'velke-klic' }, true],
  ['vlastní typ s klíčem modelx se nebere jako model', { prompt: 'x', subagent_type: 'modelx' }, true],
  ['odsazený model v zanořeném klíči se nebere', { prompt: 'x', subagent_type: 'odsazeny' }, true],
  ['model s komentářem za hodnotou', { prompt: 'x', subagent_type: 'komentar' }, false],
  ['model v jednoduchých uvozovkách a name v uvozovkách', { prompt: 'x', subagent_type: 'citovany' }, false],
  ['soubor bez frontmatteru není agent', { prompt: 'x', subagent_type: 'bez-frontmatteru' }, true],
  ['frontmatter bez uzavření není frontmatter', { prompt: 'x', subagent_type: 'bez-zavreni' }, true],
  ['frontmatter s BOM na začátku souboru', { prompt: 'x', subagent_type: 'bom' }, false],
  ['bez name se identita bere z názvu souboru', { prompt: 'x', subagent_type: 'bez-name' }, false],
  ['soubor jiný než .md se nečte', { prompt: 'x', subagent_type: 'jen-txt' }, true],
  ['agent v podsložce agents/tym', { prompt: 'x', subagent_type: 'vnoreny' }, false],
  ['agent hluboko v podsložkách (bez pevné hloubky)', { prompt: 'x', subagent_type: 'hluboky' }, false],
  ['stejné jméno ve dvou souborech jedné složky: vyhrává mělčí soubor', { prompt: 'x', subagent_type: 'duplikat' }, true],
  ['stejné jméno v projektu a v konfiguraci: vyhrává projekt (bez modelu)', { prompt: 'x', subagent_type: 'projekt-vs-config' }, true],
  ['stejné jméno v projektu a v konfiguraci: vyhrává projekt (s modelem)', { prompt: 'x', subagent_type: 'config-bez-modelu' }, false],
  ['agent jen v konfiguraci (CLAUDE_CONFIG_DIR/agents)', { prompt: 'x', subagent_type: 'z-konfigurace' }, false],
  ['vlastní typ bez definice', { prompt: 'x', subagent_type: 'neexistuje' }, true],
  ['vlastní typ s cestou v názvu', { prompt: 'x', subagent_type: '../x' }, true],
  ['vlastní typ s cestou k existujícímu souboru v názvu', { prompt: 'x', subagent_type: '../agents/ma-model' }, true],
  ['vlastní typ s model, ale volání s prázdným model', { prompt: 'x', subagent_type: 'ma-model', model: '' }, false],
  ['vlastní typ bez model, ale volání s model', { prompt: 'x', subagent_type: 'bez-modelu', model: 'haiku' }, false],
  ['prázdné tool_input (objekt bez polí)', {}, true],
  ['agent z pluginu nepotřebuje definici na disku', { prompt: 'x', subagent_type: 'nikde:nic' }, false, { CLAUDE_CONFIG_DIR: join(root, 'neexistuje') }],
  ['vlastní typ s model, CLAUDE_PROJECT_DIR neexistuje', { prompt: 'x', subagent_type: 'ma-model' }, true, { CLAUDE_PROJECT_DIR: join(root, 'neexistuje'), CLAUDE_CONFIG_DIR: cfg }],
];

for (const tool of ['Agent', 'Task']) {
  describe(`decide: nástroj ${tool}`, () => {
    for (const [name, ti, want, env] of AGENT_ROWS) {
      it(`${name} -> ${want ? 'zamítne' : 'povolí'}`, () => {
        const input = agent(ti, tool);
        if (want) zamitne(input, env ?? ENV); else povoli(input, env ?? ENV);
      });
    }
  });
}

describe('decide: kde se hledají definice agentů (cwd, CLAUDE_PROJECT_DIR, .git)', () => {
  const rows = [
    // [název, subagent_type, cwd, env, zamítne?]
    ['cwd přímo v projektu', 'ma-model', proj, { CLAUDE_CONFIG_DIR: cfg }, false],
    ['cwd hluboko pod projektem, agent v projektu', 'ma-model', deep, { CLAUDE_CONFIG_DIR: cfg }, false],
    ['agent jen v .claude/agents podsložky nad cwd', 'jen-v-sub', deep, { CLAUDE_CONFIG_DIR: cfg }, false],
    ['agent v podsložce se nenajde z cwd o úroveň výš', 'jen-v-sub', proj, { CLAUDE_CONFIG_DIR: cfg }, true],
    ['nejbližší definice vyhrává (bez modelu blíž, s modelem výš)', 'bliz', deep, { CLAUDE_CONFIG_DIR: cfg }, true],
    ['nejbližší definice vyhrává i s CLAUDE_PROJECT_DIR', 'bliz', deep, ENV, true],
    ['hledání nahoru končí u složky s .git (adresář)', 'nad-gitem', join(root, 'outer', 'repo', 'src'), { CLAUDE_CONFIG_DIR: cfg }, true],
    ['hledání nahoru končí u složky s .git (soubor, worktree)', 'nad-worktree', join(root, 'outer3', 'wt', 'src'), { CLAUDE_CONFIG_DIR: cfg }, true],
    ['hledání nahoru končí u CLAUDE_PROJECT_DIR', 'nad-projektem', join(root, 'outer2', 'proj', 'src'), { CLAUDE_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: join(root, 'outer2', 'proj') }, true],
    ['cwd mimo projekt, CLAUDE_PROJECT_DIR přesto dodá agenty', 'ma-model', join(root, 'outer', 'repo', 'src'), ENV, false],
    ['cwd není řetězec (číslo), použije se jen projekt a konfigurace', 'ma-model', 5, ENV, false],
    ['cwd prázdný řetězec, použije se jen projekt a konfigurace', 'ma-model', '', ENV, false],
    ['cwd neexistuje', 'ma-model', join(root, 'neexistuje', 'nikde'), ENV, false],
  ];
  for (const [name, type, cwd, env, want] of rows) {
    it(`${name} -> ${want ? 'zamítne' : 'povolí'}`, () => {
      const input = { ...agent({ prompt: 'x', subagent_type: type }), cwd };
      if (want) zamitne(input, env); else povoli(input, env);
    });
  }

  it('bez CLAUDE_CONFIG_DIR se čte agents z domovské složky (HOME), proces s izolovaným domovem', () => {
    const input = agent({ prompt: 'x', subagent_type: 'z-domova' });
    const r = spawnHook(input, { env: { CLAUDE_CONFIG_DIR: '', CLAUDE_PROJECT_DIR: join(root, 'neexistuje') } });
    plati(mlci(r), `Agent z ~/.claude/agents (HOME ukazuje do dočasné složky) měl projít. ${popis(r)}`);
  });

  it('limit počtu čtených souborů: za MAX_AGENT_FILES (2000) souborů .md se další definice nenajde', () => {
    const big = join(root, 'big-agents');
    for (let i = 0; i < 2000; i++) soubor(join(big, 'agents', `a-${String(i).padStart(4, '0')}.md`), 'bez frontmatteru\n');
    soubor(join(big, 'agents', 'zzz-pozdni.md'), fm('name: zzz-pozdni', 'model: haiku'));
    const env = { CLAUDE_CONFIG_DIR: big, CLAUDE_PROJECT_DIR: join(root, 'neexistuje') };
    const r = zamitne(agent({ prompt: 'x', subagent_type: 'zzz-pozdni' }), env, 'Za limitem souborů se definice nemá najít a typ se bere jako bez modelu');
    plati(r.includes('mezi vlastními agenty nenašel'), `Důvod má říct, že typ nebyl nalezen. Důvod: ${r}`);
  });
});

describe('decide: CLAUDE_CODE_SUBAGENT_MODEL_FORCE a CLAUDE_CODE_SUBAGENT_MODEL', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' true ', 'On']) {
    it(`FORCE=${J(v)}: Agent bez model projde (Claude model předat nemůže)`, () => {
      povoli(agent({ prompt: 'x' }), { ...ENV, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: v });
    });
  }
  for (const v of ['0', 'false', '', 'off', 'no', 'jo', '2']) {
    it(`FORCE=${J(v)}: Agent bez model se stále zamítá`, () => {
      zamitne(agent({ prompt: 'x' }), { ...ENV, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: v });
    });
  }
  it('FORCE: vlastní typ bez modelu projde taky', () => {
    povoli(agent({ prompt: 'x', subagent_type: 'bez-modelu' }), { ...ENV, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
  });
  it('FORCE: Workflow hlídá jen effort (agent bez model, s effort projde)', () => {
    povoli(wf(`agent('p', { effort: 'low' })`), { ...ENV, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
  });
  it('FORCE: Workflow bez effort se zamítne a důvod žádá jen effort', () => {
    const r = zamitne(wf(`agent('p', { model: 'haiku' })`), { ...ENV, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
    plati(r.includes('nemá každé agent() effort,') && r.includes('(chybí effort)') && !r.includes('model a effort'), `Důvod má žádat jen effort. Důvod: ${r}`);
  });
  it('FORCE: agent bez options ve Workflow chce jen effort', () => {
    rovno(lines(`agent('p')`, () => false, { modelForced: true }), ['1:effort'], 'S modelForced se u agent() hlídá jen effort');
  });
  it('bez FORCE: agent bez options chce model i effort', () => {
    rovno(lines(`agent('p')`), ['1:model+effort'], 'Bez modelForced se u agent() hlídá model i effort');
  });
  it('CLAUDE_CODE_SUBAGENT_MODEL: důvod u Agent uvádí proměnnou a její hodnotu, ne dědění modelu session', () => {
    const r = zamitne(agent({ prompt: 'x' }), { ...ENV, CLAUDE_CODE_SUBAGENT_MODEL: 'opus' });
    plati(r.includes('CLAUDE_CODE_SUBAGENT_MODEL (opus)') && !r.includes('dědí model session'), `Důvod má zmínit proměnnou CLAUDE_CODE_SUBAGENT_MODEL (opus). Důvod: ${r}`);
  });
  it('CLAUDE_CODE_SUBAGENT_MODEL jen z mezer se ignoruje', () => {
    const r = zamitne(agent({ prompt: 'x' }), { ...ENV, CLAUDE_CODE_SUBAGENT_MODEL: '   ' });
    plati(r.includes('dědí model session'), `Prázdná proměnná má dát běžný důvod. Důvod: ${r}`);
  });
  it('CLAUDE_CODE_SUBAGENT_MODEL: důvod u Workflow zmiňuje proměnnou', () => {
    const r = zamitne(wf(`agent('p')`), { ...ENV, CLAUDE_CODE_SUBAGENT_MODEL: 'opus' });
    plati(r.includes('modelu z CLAUDE_CODE_SUBAGENT_MODEL'), `Důvod u Workflow má zmínit proměnnou. Důvod: ${r}`);
  });
  it('bez CLAUDE_CODE_SUBAGENT_MODEL důvod u Workflow říká jen model session', () => {
    const r = zamitne(wf(`agent('p')`), ENV);
    plati(r.includes('jinak běží na modelu session:') && !r.includes('CLAUDE_CODE_SUBAGENT_MODEL'), `Důvod nemá zmiňovat proměnnou. Důvod: ${r}`);
  });
});

// ---------------------------------------------------------------------------------------------------------
// text zamítnutí
// ---------------------------------------------------------------------------------------------------------
describe('text zamítnutí Agent a Task', () => {
  it('Agent bez typu: nástroj, příklad, skill, README, bez poznámek o typu', () => {
    const r = zamitne(agent({ prompt: 'x' }));
    for (const kus of ['nástroj Agent bez pole model', "model: 'sonnet'", 'skill orchestrace', 'README pluginu', 'dědí model session']) {
      plati(r.includes(kus), `Důvod má obsahovat „${kus}“. Důvod: ${r}`);
    }
    for (const kus of ['REFERENCE.md', 'Definice agenta', 'prohledáno']) {
      plati(!r.includes(kus), `Důvod bez typu nemá obsahovat „${kus}“. Důvod: ${r}`);
    }
  });
  it('Task: důvod jmenuje nástroj Task', () => {
    plati(zamitne(agent({ prompt: 'x' }, 'Task')).includes('nástroj Task bez pole model'), 'Důvod u Task má jmenovat Task.');
  });
  it('general-purpose: bez poznámky o typu', () => {
    const r = zamitne(agent({ prompt: 'x', subagent_type: 'general-purpose' }));
    plati(!r.includes('REFERENCE.md') && !r.includes('Definice agenta'), `Pro general-purpose se poznámka o typu nepřidává. Důvod: ${r}`);
  });
  it('vestavěný typ bez definice: odkaz na REFERENCE.md a výpis prohledaných složek', () => {
    const r = zamitne(agent({ prompt: 'x', subagent_type: 'claude-code-guide' }));
    for (const kus of ['REFERENCE.md', 'zadej model, na kterém má běžet', 'Typ „claude-code-guide“', 'prohledáno:', agents, cfgAgents]) {
      plati(r.includes(kus), `Důvod má obsahovat „${kus}“. Důvod: ${r}`);
    }
  });
  it('vlastní typ bez modelu: uvádí soubor definice', () => {
    const r = zamitne(agent({ prompt: 'x', subagent_type: 'bez-modelu' }));
    plati(r.includes('Definice agenta „bez-modelu“') && r.includes(join(agents, 'bez-modelu.md')) && r.includes('nemá ve frontmatteru model'), `Důvod má uvést soubor definice. Důvod: ${r}`);
  });
  it('vlastní typ s inherit: důvod zmiňuje inherit', () => {
    plati(zamitne(agent({ prompt: 'x', subagent_type: 'dedi' })).includes('inherit'), 'Důvod pro model: inherit má inherit zmínit.');
  });
  it('výpis prohledaných složek se po čtyřech zkrátí na „a dalších N“', () => {
    const r = zamitne({ ...agent({ prompt: 'x', subagent_type: 'neexistuje' }), cwd: deep }, { CLAUDE_CONFIG_DIR: cfg });
    // deep = proj/sub/a/b/c/d, zarážka .git je v proj: 6 úrovní (d, c, b, a, sub, proj) + config = 7 složek
    plati(r.includes('a dalších 3'), `Z 7 prohledaných složek se ukážou 4 a zbytek je „a dalších 3“. Důvod: ${r}`);
  });
  it('složka se v seznamu neopakuje, když cwd je zároveň CLAUDE_PROJECT_DIR', () => {
    const r = zamitne({ ...agent({ prompt: 'x', subagent_type: 'neexistuje' }), cwd: proj }, ENV);
    const kolik = r.split(resolve(agents)).length - 1;
    rovno(kolik, 1, `Složka ${agents} se má ve výpisu objevit jednou`);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Workflow: volání agent()
// ---------------------------------------------------------------------------------------------------------
const S = 'const S = { type: "object" }\n';
const okCall = `await agent(p, { model: "haiku", effort: "low" })`;
const tpl = [
  'const prompt = `Shrň (část ${x ? \'a\' : `b${c}`}) a { zavři `;',
  "const r = await agent(prompt, { model: 'sonnet', effort: 'medium' })",
  'const q = await agent(`Znovu ${files.map((f) => `- ${f}`).join("\\n")} (konec`, { schema: S })',
].join('\n');
// reálná struktura workflow (pipeline, parallel, map, schema konstanty), všude model a effort
const real = `
const LEVNE = { model: 'haiku', effort: 'medium' }
const SILNE = { model: 'opus', effort: 'high' }
const EXTRACT = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] }
const VERDICT = { type: 'object', properties: { ok: { type: 'boolean' }, note: { type: 'string' } } }

// Fáze 1: seznam souborů
const listing = await agent('Vypiš soubory v C:/x a vrať je podle schématu (zadání obsahuje "agent(" jen jako text).', { ...LEVNE, schema: EXTRACT })

const parts = await pipeline(
  parallel(listing.files.map((f) => () => agent(\`Přečti \${f}\\n(část \${f.length > 3 ? 'dlouhá' : \`krátká \${f}\`})\`, { ...LEVNE, schema: EXTRACT }))),
  async (results) => {
    const merged = results.flatMap((r) => r.files)
    return agent('Syntéza:\\n' + merged.join('\\n'), { model: 'sonnet', effort: 'high' })
  },
)

const checks = await Promise.all(
  [1, 2, 3].map(async (i) => {
    const v = await agent('Ověř ' + i, { ...SILNE, schema: VERDICT })
    return v.ok ? null : v.note
  }),
)
const review = await agent('Revize', { agentType: 'reviewer', effort: 'medium', schema: VERDICT })
const ratio = checks.length / 2 / 3
return { parts, checks, review, ratio }
`;

const SCRIPT_GROUPS = [
  ["základní volání agent() a klíče options", [
    ['agent bez options', `agent('p')`, ['1:model+effort']],
    ['agent s options bez model a effort, číslo řádku', `${S}\nconst r = await agent('p', {schema: S})`, ['3:model+effort']],
    ['model a effort literál', `agent('p', { model: 'haiku', effort: 'low' })`, []],
    ['klíče v uvozovkách', `agent('p', { 'model': 'haiku', "effort": 'low' })`, []],
    ['zkratka {model, effort}', `const model = 'haiku', effort = 'low'\nagent('p', { model, effort })`, []],
    ['chybí jen effort', `agent('p', { model: 'haiku' })`, ['1:effort']],
    ['chybí jen model', `agent('p', { effort: 'low' })`, ['1:model']],
    ['prázdný model je chyba', `agent('p', { model: '', effort: 'low' })`, ['1:model']],
    ['metoda se za klíč nepočítá', `agent('p', { model() { return 1 }, effort: 'low' })`, ['1:model']],
    ['spread konstanty', `const LEVNE = { model: 'haiku', effort: 'low' }\nagent(p, {...LEVNE, schema: S})`, []],
    ['spread konstanty bez effort', `const LEVNE = { model: 'haiku' }\nagent(p, {...LEVNE, schema: S})`, ['2:effort']],
    ['spread přes Object.freeze', `const L = Object.freeze({ model: 'haiku', effort: 'low' })\nagent(p, {...L})`, []],
    ['vnořený spread', `const A = { model: 'haiku' }\nconst B = { ...A, effort: 'low' }\nagent(p, {...B})`, []],
    ['spread nedohledatelný', `agent(p, {...cfg, schema: S})`, []],
    ['spread volání funkce', `agent(p, {...levne(), schema: S})`, []],
    ['spread dvakrát deklarované konstanty', `const L = { model: 'a' }\n{ const L = { model: 'b' } }\nagent(p, {...L})`, []],
    ['spread sám sebe (cyklus)', `const A = { ...A }\nagent(p, {...A})`, []],
    ['options identifikátor dohledatelný bez effort', `const OPT = { model: 'haiku' }\nagent(p, OPT)`, ['2:effort']],
    ['options identifikátor s oběma', `const OPT = { model: 'haiku', effort: 'low' }\nagent(p, OPT)`, []],
    ['options identifikátor nedohledatelný (parametr)', `const f = (p, opts) => agent(p, opts)`, []],
    ['options volání funkce', `agent(p, opts())`, []],
    ['options ternár', `agent(p, deep ? A : B)`, []],
    ['options member', `agent(p, CFG.cheap)`, []],
    ['vypočtený klíč je neznámý', `agent(p, { [k]: 'haiku' })`, []],
    ['argumenty z rozbalení', `agent(...args)`, []],
    ['agentType bez model, s effort', `agent(p, { agentType: 'reviewer', effort: 'medium' })`, []],
    ['agentType bez effort', `agent(p, { agentType: 'reviewer' })`, ['1:effort']],
  ]],
  ["agentType (stejná logika jako subagent_type u Agent)", [
    ['agentType general-purpose bez model', `agent(p, { agentType: "general-purpose", effort: 'low' })`, ['1:model']],
    ['agentType Explore bez model', `agent(p, { agentType: 'Explore', effort: 'low' })`, ['1:model']],
    ['agentType general-purpose s model', `agent(p, { agentType: 'general-purpose', model: 'haiku', effort: 'low' })`, []],
    ['agentType fork bez model', `agent(p, { agentType: 'fork', effort: 'low' })`, []],
    ['agentType z pluginu bez model', `agent(p, { agentType: 'plugin:reviewer', effort: 'low' })`, []],
    ['agentType s klíčem v uvozovkách', `agent(p, { 'agentType': 'Explore', effort: 'low' })`, ['1:model']],
    ['agentType neznámá hodnota (proměnná) se povolí', `agent(p, { agentType: TYPE, effort: 'low' })`, []],
    ['agentType zkratka se povolí', `agent(p, { agentType, effort: 'low' })`, []],
    ['agentType výraz se povolí', `agent(p, { agentType: 'a' + b, effort: 'low' })`, []],
    ['agentType z dohledaného spreadu', `const C = { agentType: 'Explore', effort: 'low' }\nagent(p, { ...C, schema: S })`, ['2:model']],
    ['agentType prázdný řetězec', `agent(p, { agentType: '', effort: 'low' })`, ['1:model']],
    ['agentType s komentářem za hodnotou', `agent(p, { agentType: 'Explore', // levné\n effort: 'low' })`, ['1:model']],
  ]],
  ["koncová čárka a více volání", [
    ['koncová čárka', `agent(p, { model: 'haiku', effort: 'low', },)`, []],
    ['agent bez options s koncovou čárkou', `agent(p,)`, ['1:model+effort']],
    ['víc volání, jedno vadné', `agent('a', { model: 'haiku', effort: 'low' })\nagent('b', { model: 'haiku' })\nagent('c', { model: 'haiku', effort: 'low' })`, ['2:effort']],
    ['více vadných', `agent('a')\n\nagent('b', {})`, ['1:model+effort', '3:model+effort']],
  ]],
  ["parametr funkce stejného jména jako const jinde je neznámý", [
    ['options je parametr obalovací funkce', 'const opts = { schema: S }\nconst first = await agent("a", { ...opts, model: "haiku", effort: "low" })\nasync function ask(p, opts) {\n  return agent(p, opts)\n}', []],
    ['spread parametru šipky', 'const base = { schema: S }\nconst ask = (p, base) => agent(p, { ...base })', []],
    ['spread parametru funkce, const až za ní', "function mk(base) { return (p) => agent(p, { ...base, schema: S }) }\nconst base = { model: 'haiku' }", []],
    ['parametr s jedním jménem v šipce bez závorek', 'const o = { schema: S }\nconst f = o => agent(p, o)', []],
    ['destrukturovaný parametr', 'const o = { schema: S }\nconst f = ({ o }) => agent(p, o)', []],
    ['parametr metody objektu', 'const o = { schema: S }\nconst w = { run(p, o) { return agent(p, o) } }', []],
    ['parametr catch', 'const e = { schema: S }\ntry { x() } catch (e) { agent(p, e) }', []],
    ['destrukturující deklarace', 'const o = { schema: S }\nfunction f(c) { const { o } = c; return agent(p, o) }', []],
    ['jiná deklarace téhož jména v bloku', 'const o = { schema: S }\n{ const o = pick(); agent(p, o) }', []],
    ['jména ve volání a v podmínce nejsou parametr', 'const o = { schema: S }\nif (o.x) { agent(p, o) }\nfoo(o.x)', ['2:model+effort']],
    ['const bez parametru se pořád hlídá', 'const o = { schema: S }\nconst f = (p) => agent(p, o)', ['2:model+effort']],
  ]],
  ["objekt options doplněný po deklaraci je neznámý", [
    ['let doplněné přiřazením klíčů', 'let opts = {}\nopts.model = "haiku"\nopts.effort = "low"\nawait agent("p", opts)', []],
    ['const doplněné přiřazením klíčů', "const o = { schema: S }\no.model = 'haiku'; o.effort = 'low'\nawait agent('p', o)", []],
    ['přiřazení přes závorky a ??=', "const o = { schema: S }\no['model'] ??= 'haiku'\nawait agent('p', o)", []],
    ['Object.assign do options', "const opts = { schema: S }\nObject.assign(opts, { model: 'haiku', effort: 'low' })\nconst r = await agent('p', opts)", []],
    ['přepsání let', "let o = { schema: S }\no = { model: 'haiku', effort: 'low' }\nawait agent('p', o)", []],
    ['delete klíče z options', "const o = { model: 'haiku', effort: 'low' }\ndelete o.model\nawait agent('p', o)", []],
    ['spread změněné konstanty', "const B = { schema: S }\nB.model = 'haiku'\nagent(p, { ...B })", []],
    ['porovnání a čtení klíče není změna', "const o = { schema: S }\nif (o.model == 'x' && o.effort >= 1 && o.n === 2) {}\nawait agent('p', o)", ['3:model+effort']],
    ['arrow za klíčem není přiřazení', "const o = { schema: S }\nconst f = o.h => 1\nawait agent('p', o)", ['3:model+effort']],
  ]],
  ["lokální jméno agent a identifikátory s českými znaky", [
    ['řagent( není agent(', "const řagent = (x) => x\nřagent('p')", []],
    ['přeložagent( není agent(', "const přeložagent = 1; přeložagent('x')", []],
    ['agentř( není agent(', "agentř('p')", []],
    ['agent( za českým slovem a mezerou se počítá', "const čau = 1; agent('p')", ['1:model+effort']],
    ['agent jako parametr callbacku', "steps.forEach((agent) => agent('p'))", []],
    ['agent jako destrukturovaný parametr', "const run = async ({ agent }) => agent('p')", []],
    ['agent jako parametr bez závorek', "steps.map(agent => agent('p'))", []],
    ['agent jako const', "const agent = makeAgent()\nagent('p')", []],
    ['agentName není agent', "const f = async (agentName) => agentName\nagent('p')", ['2:model+effort']],
  ]],
  ["co se nemá počítat jako volání", [
    ['agent( v řetězci', `const s = "agent('p')"; const t = 'agent(x)'`, []],
    ['agent( v šabloně', 'const s = `volej agent(\'p\') takto`', []],
    ['agent( v komentáři //', `// agent('p')\nconst x = 1`, []],
    ['agent( v komentáři /* */', `/* agent('p')\n agent('q') */\nconst x = 1`, []],
    ['.agent(', `ctx.agent('p')\nx\n  .agent('q')\nx?.agent('r')`, []],
    ['myagent( a agent2(', `myagent('p'); agent2('p'); $agent('p'); agent_('p')`, []],
    ['definice funkce agent', `function agent(p) { return p }\nconst o = { agent(p) { return p } }`, []],
    ['agent v regex literálu', `const re = /agent\\(x\\)/g; const y = 1 / 2`, []],
    ['agent( ve ${} šablony se počítá', 'const s = `a ${await agent(\'p\')} b`', ['1:model+effort']],
    ['závorky a čárky v řetězci promptu', `agent('text (bez zavřené, "a" , {', { model: 'haiku', effort: 'low' })`, []],
    ['slovo model v promptu není klíč', `agent('uprav model a effort v souboru', { schema: S })`, ['1:model+effort']],
    ['slovo model v komentáři a řetězci options', `agent(p, { /* model: 'x' */ schema: 'model effort' })`, ['1:model+effort']],
    ['model ve vnořeném objektu není klíč nejvyšší úrovně', `agent(p, { schema: { model: 1, effort: 2 } })`, ['1:model+effort']],
    ['nevyvážené závorky', `agent('p', { model: 'haiku'`, []],
  ]],
  ["šablonový literál s vnořením", [
    ['vnořená šablona, závorky v textu, vadné až třetí volání', tpl, ['3:model+effort']],
    ['čárka v šabloně prvního argumentu', 'agent(`a, b ${f(1, 2)}, c`, { model: "haiku", effort: "low" })', []],
    ['komentář uvnitř options', `agent(p, {\n // effort chybí\n model: 'haiku', // levný\n /* effort: 'low' */\n})`, ['1:effort']],
  ]],
  ["reálná struktura workflow", [
    ['reálný skript se všemi model a effort', real, []],
    ['reálný skript s jedním vadným', real.replace("{ ...SILNE, schema: VERDICT }", '{ schema: VERDICT }'), [`${real.split('\n').findIndex((l) => l.includes("'Ověř '")) + 1}:model+effort`]],
  ]],
  ["regex literál s uvozovkou nebo backtickem za ) a ++", [
    ['regex s backtickem po if (...)', `if (ok) /\`/.test(s)\nconst p = \`Use agent(x) here\`\n${okCall}\n`, []],
    ['regex s uvozovkou po while (...)', `while (x) /"/.test(s)\nconst p = "Use agent(x) here"\n${okCall}\n`, []],
    ['regex s apostrofem po for (...)', `for (const a of b) /'/.test(a)\nconst p = 'Use agent(x) here'\n${okCall}\n`, []],
    ['dělení po i++ a uvozovka', `let r = i++ / 2, q = "/"; const p = "agent(x)"\n${okCall}\n`, []],
    ['dělení po i-- a uvozovka', `let r = i-- / 2, q = "/"; const p = "agent(x)"\n${okCall}\n`, []],
    ['dělení po ) zůstává dělením', `const r = (a + b) / 2, q = "/"; const p = "agent(x)"\n${okCall}\n`, []],
    ['volání po regexu za if se stále hlídá', `if (ok) /\`/.test(s)\nconst p = \`Use agent(x) here\`\nawait agent(p)\n`, ['3:model+effort']],
    ['dělení po zavřené závorce funkce', `const h = f(x) / 2 / 3; const p = "agent(y)"\n${okCall}\n`, []],
  ]],
  ["options předaný dál nebo s getterem", [
    ['options předaný cizí funkci se povolí', `const L = { schema: S }\nfill(L)\nawait agent(p, L)\n`, []],
    ['options přiřazený jinam se povolí', `const L = { schema: S }\nconst M = L\nawait agent(p, M)\nawait agent(p, L)\n`, []],
    ['options v poli se povolí', `const L = { schema: S }\nregister([L])\nawait agent(p, L)\n`, []],
    ['options bez předání dál se stále hlídá', `const L = { schema: S }\nawait agent(p, L)\n`, ['2:model+effort']],
    ['options použitý ve dvou agent() a čtený přes tečku se stále hlídá', `const L = { schema: S }\nconst s = L.schema\nawait agent(a, L)\nawait agent(b, L)\n`, ['3:model+effort', '4:model+effort']],
    ['options předaný jen v nested agent() se stále hlídá', `const L = { schema: S }\nawait Promise.all(xs.map((x) => agent(x, L)))\n`, ['2:model+effort']],
    ['spread options se stále hlídá', `const L = { schema: S }\nawait agent(p, { ...L, effort: 'low' })\n`, ['2:model']],
    ['getter model se bere jako hodnota', `agent(p, { get model() { return 'haiku' }, effort: 'low' })`, []],
    ['getter effort se bere jako hodnota', `agent(p, { model: 'haiku', get effort() { return 'low' } })`, []],
    ['metoda model bez getteru zůstává metodou', `agent(p, { model() { return 'haiku' }, effort: 'low' })`, ['1:model']],
  ]],
];

describe('checkScript: volání agent() ve skriptu workflow', () => {
  for (const [skupina, rows] of SCRIPT_GROUPS) {
    describe(skupina, () => {
      for (const [name, script, want] of rows) {
        it(name, () => {
          rovno(lines(script), want, `Skript:\n${script}\n  Nálezy ve tvaru řádek:chybějící klíče se liší.`);
        });
      }
    });
  }
});

describe('checkScript: prázdné hodnoty klíčů se berou jako chybějící', () => {
  const prazdne = ['undefined', 'null', 'void 0', 'false', "''", '""', '``', "'' + ''", "'' /* x */"];
  for (const v of prazdne) {
    it(`model: ${v}`, () => {
      rovno(lines(`agent(p, { model: ${v}, effort: 'low' })`), ['1:model'], `Prázdný model (${v}) se má brát jako chybějící`);
    });
    it(`effort: ${v}`, () => {
      rovno(lines(`agent(p, { model: 'haiku', effort: ${v} })`), ['1:effort'], `Prázdný effort (${v}) se má brát jako chybějící`);
    });
  }
  const neprazdne = ["'haiku'", 'MODEL', 'x ? "a" : "b"', 'cfg.model', "'' + x", 'fn()', '0', '"  "'];
  for (const v of neprazdne) {
    it(`hodnota ${v} se bere jako přítomná`, () => {
      rovno(lines(`agent(p, { model: ${v}, effort: ${v} })`), [], `Hodnota ${v} není prázdná a hook ji nemá zamítnout`);
    });
  }
});

describe('checkScript: agentType, fork, plugin a vlastní typy s model v definici', () => {
  const rows = [
    ['agentType s typem, který model v definici má (reviewer): stačí effort', `agent(p, { agentType: 'reviewer', effort: 'low' })`, []],
    ['agentType reviewer bez effort', `agent(p, { agentType: 'reviewer' })`, ['1:effort']],
    ['agentType v šabloně bez ${} se čte jako text', 'agent(p, { agentType: `Explore`, effort: "low" })', ['1:model']],
    ['agentType v šabloně s ${} je neznámý, povolí se', 'agent(p, { agentType: `Explore${x}`, effort: "low" })', []],
    ['agentType s apostrofem v řetězci', `agent(p, { agentType: "it's", effort: 'low' })`, ['1:model']],
    ['agentType null se bere jako chybějící', `agent(p, { agentType: null, effort: 'low' })`, ['1:model']],
    ['agentType undefined se bere jako chybějící', `agent(p, { agentType: undefined, effort: 'low' })`, ['1:model']],
    ['agentType nahrazuje model i při chybějícím effort (chybí jen effort)', `agent(p, { agentType: 'fork' })`, ['1:effort']],
  ];
  for (const [name, script, want] of rows) it(name, () => rovno(lines(script), want, `Skript: ${script}`));
  it('checkScript bez callbacku typeHasModel: žádný vlastní typ nemá model', () => {
    rovno(checkScript(`agent(p, { agentType: 'reviewer', effort: 'low' })`).map((b) => b.missing.join('+')), ['model'], 'Výchozí typeHasModel říká, že typ model nemá');
  });
  it('typeHasModel se ptá jednou na typ, i když se typ použije vícekrát', () => {
    const ptal = [];
    checkScript(`agent(a, { agentType: 'x', effort: 'low' })\nagent(b, { agentType: 'x', effort: 'low' })\nagent(c, { agentType: 'y', effort: 'low' })`, (t) => { ptal.push(t); return true; });
    rovno(ptal, ['x', 'y'], 'Dotaz na definici typu se má pamatovat (každý typ jednou)');
  });
  it('typeHasModel vrací nepravdivou hodnotu jiného typu (0, "") a bere se jako nemá', () => {
    rovno(checkScript(`agent(p, { agentType: 'x', effort: 'low' })`, () => 0).length, 1, 'Nepravdivá hodnota znamená, že typ model nemá');
  });
});

describe('checkScript: agent použitý jako hodnota a \\u escape (kontrola je nevidí, proto je hlásí)', () => {
  const rows = [
    ['alias const a = agent', 'const a = agent', ['1:value']],
    ['callback xs.map(agent)', 'xs.map(agent)', ['1:value']],
    ['pipeline(items, agent)', 'pipeline(items, agent)', ['1:value']],
    ['Reflect.apply(agent, ...)', 'Reflect.apply(agent, null, [p])', ['1:value']],
    ['agent.call(...)', 'agent.call(null, p)', ['1:value']],
    ['druhý řádek', 'const x = 1\nconst a = agent', ['2:value']],
    ['typeof agent se nepočítá', "if (typeof agent === 'function') {}", []],
    ['klíč objektu agent: se nepočítá', 'const o = { agent: 1, b: 2 }', []],
    ['klíč objektu agent: za čárkou se nepočítá', 'const o = { b: 2, agent: 1 }', []],
    ['\\u escape v identifikátoru (agent\\u0061 se navíc čte jako hodnota agent)', "agent\\u0061('p')", ['1:escape', '1:value']],
    ['\\u{...} escape v identifikátoru', "ag\\u{65}nt('p')", ['1:escape']],
    ['\\u escape v řetězci je v pořádku', 'const s = "\\u0041"', []],
    ['\\u escape v komentáři je v pořádku', '// \\u0041\nconst x = 1', []],
  ];
  for (const [name, script, want] of rows) it(name, () => rovno(kinds(script), want, `Skript: ${script}`));
});

describe('checkScript: časový rozpočet a velikost', () => {
  const MNOHO = Array.from({ length: 400 }, () => `agent('p')`).join('\n');
  it('po uplynutí rozpočtu se kontrola zastaví a vrátí, co našla (ne celých 400)', () => {
    const nalezy = checkScript(MNOHO, () => false, { deadline: Date.now() - 1 });
    plati(nalezy.length < 400, `Při uplynulém rozpočtu měla kontrola skončit dřív. Nálezů: ${nalezy.length}`);
  });
  it('s dostatečným rozpočtem se najde všech 400 volání', () => {
    rovno(checkScript(MNOHO, () => false).length, 400, 'Bez uplynutí rozpočtu se mají najít všechna volání');
  });
  it('při uplynulém rozpočtu hook přesto zamítá podle nálezů (nepovolí vše)', () => {
    // rozpočet se v decide() nastaví sám; tady se jen ověří, že 400 vadných volání zamítnutí vyvolá
    zamitne(wf(MNOHO));
  });
  it('skript přes 4 000 000 znaků se nekontroluje (povolí se)', () => {
    povoli(wf(`agent('p')\n${' '.repeat(4_000_000)}`), ENV, 'Příliš velký skript se má povolit');
  });
  it('skript těsně do limitu se ještě kontroluje', () => {
    zamitne(wf(`agent('p')\n${' '.repeat(3_900_000)}`), ENV, 'Skript pod limitem se má zkontrolovat');
  });
});

// ---------------------------------------------------------------------------------------------------------
// Workflow: vstup nástroje (script, scriptPath, nested workflow)
// ---------------------------------------------------------------------------------------------------------
const GOOD = `agent('p', { model: 'haiku', effort: 'low' })\n`;
const BAD = `agent('p', { schema: S })\n`;
const nest = join(root, 'nest');
soubor(join(nest, 'bad.js'), BAD);
soubor(join(nest, 'good.js'), GOOD);
soubor(join(nest, 'sub', 'bad2.js'), `const x = 1\n${BAD}`);
soubor(join(nest, 'chain.js'), `await workflow({ scriptPath: 'bad.js' })\n${GOOD}`);
soubor(join(nest, 'typed.js'), `agent(p, { agentType: 'ma-model', effort: 'low' })\n`);
soubor(join(nest, 'forced-child.js'), `agent(p, { effort: 'low' })\n`);
soubor(join(nest, 'velky.js'), `agent('p')\n${' '.repeat(4_000_001)}`);
mkdirSync(join(nest, 'adresar.js'), { recursive: true });
const abs = (p) => join(nest, p).replace(/\\/g, '/');
const WF_ENV = { ...ENV, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '' };

describe('decide: Workflow, script a scriptPath', () => {
  const rows = [
    // [název, vstup, zamítne?, env]
    ['script vadný', wf(`agent('p')`), true],
    ['script v pořádku', wf(GOOD), false],
    ['script prázdný řetězec', wf(''), false],
    ['script jen bílé znaky', wf('  \n\t '), false],
    ['script není řetězec (číslo)', { tool_name: 'Workflow', tool_input: { script: 5 } }, false],
    ['script není řetězec (objekt)', { tool_name: 'Workflow', tool_input: { script: { a: 1 } } }, false],
    ['scriptPath vadný soubor (absolutní)', wfPath(join(nest, 'bad.js')), true],
    ['scriptPath soubor v pořádku (absolutní)', wfPath(join(nest, 'good.js')), false],
    ['scriptPath relativně k cwd', wfPath('bad.js', { cwd: nest }), true],
    ['scriptPath relativně k cwd, podsložka', wfPath('sub/bad2.js', { cwd: nest }), true],
    ['scriptPath relativně s ../ k cwd', wfPath('../bad.js', { cwd: join(nest, 'sub') }), true],
    ['scriptPath v pořádku relativně k cwd', wfPath('good.js', { cwd: nest }), false],
    ['scriptPath nečitelný (neexistuje)', wfPath(join(nest, 'neni.js')), false],
    ['scriptPath je adresář', wfPath(join(nest, 'adresar.js')), false],
    ['scriptPath prázdný řetězec', wfPath(''), false],
    ['scriptPath jen mezery', wfPath('   '), false],
    ['scriptPath není řetězec', { tool_name: 'Workflow', tool_input: { scriptPath: 5 } }, false],
    ['scriptPath soubor přes 4 MB se nekontroluje', wfPath(join(nest, 'velky.js')), false],
    ['jen name uloženého workflow', { tool_name: 'Workflow', tool_input: { name: 'ulozeny' } }, false],
    ['script má přednost před scriptPath (script v pořádku, soubor vadný)', { tool_name: 'Workflow', tool_input: { script: GOOD, scriptPath: join(nest, 'bad.js') } }, false],
    ['script má přednost před scriptPath (script vadný, soubor v pořádku)', { tool_name: 'Workflow', tool_input: { script: `agent('p')`, scriptPath: join(nest, 'good.js') } }, true],
    ['prázdný script se bere jako chybějící a použije se scriptPath', { tool_name: 'Workflow', tool_input: { script: '  ', scriptPath: join(nest, 'bad.js') } }, true],
    ['vnořený workflow: vadný potomek', wf(`await workflow({ scriptPath: 'bad.js' })`, { cwd: nest }), true],
    ['vnořený workflow: potomek v pořádku', wf(`await workflow({ scriptPath: 'good.js' })`, { cwd: nest }), false],
    ['vnořený workflow: absolutní cesta', wf(`await workflow({ scriptPath: '${abs('bad.js')}' })`), true],
    ['vnořený workflow: cesta v dvojitých uvozovkách', wf(`await workflow({ scriptPath: "bad.js" })`, { cwd: nest }), true],
    ['vnořený workflow: cesta v šabloně bez ${}', wf('await workflow({ scriptPath: `bad.js` })', { cwd: nest }), true],
    ['vnořený workflow: klíč scriptPath v uvozovkách', wf(`await workflow({ 'scriptPath': 'bad.js' })`, { cwd: nest }), true],
    ['vnořený workflow: další klíče v options', wf(`await workflow({ args: [1], scriptPath: 'bad.js' })`, { cwd: nest }), true],
    ['vnořený workflow: jen jedno zanoření (vnuk se nekontroluje)', wf(`await workflow({ scriptPath: 'chain.js' })`, { cwd: nest }), false],
    ['vnořený workflow: potomek s agentType s modelem v definici', wf(`await workflow({ scriptPath: 'typed.js' })`, { cwd: nest }), false],
    ['vnořený workflow: potomek nečitelný', wf(`await workflow({ scriptPath: 'neni.js' })`, { cwd: nest }), false],
    ['vnořený workflow: potomek přes 4 MB se nekontroluje', wf(`await workflow({ scriptPath: 'velky.js' })`, { cwd: nest }), false],
    ['vnořený workflow: cesta z proměnné se nekontroluje', wf(`const p = 'bad.js'\nawait workflow({ scriptPath: p })`, { cwd: nest }), false],
    ['vnořený workflow: cesta spojená z řetězců se nekontroluje', wf(`await workflow({ scriptPath: 'ba' + 'd.js' })`, { cwd: nest }), false],
    ['vnořený workflow: volání podle jména se nekontroluje', wf(`await workflow({ name: 'bad' })`, { cwd: nest }), false],
    ['vnořený workflow: volání s řetězcem místo objektu se nekontroluje', wf(`await workflow('bad.js')`, { cwd: nest }), false],
    ['vnořený workflow: workflow( v řetězci se nepočítá', wf(`const s = "workflow({ scriptPath: 'bad.js' })"`, { cwd: nest }), false],
    ['vnořený workflow: workflow( v komentáři se nepočítá', wf(`// workflow({ scriptPath: 'bad.js' })\nconst x = 1`, { cwd: nest }), false],
    ['vnořený workflow: .workflow( je vlastnost, ne API', wf(`await ctx.workflow({ scriptPath: 'bad.js' })`, { cwd: nest }), false],
    ['vnořený workflow: lokální funkce workflow vypíná kontrolu', wf(`function workflow(o) { return o }\nawait workflow({ scriptPath: 'bad.js' })`, { cwd: nest }), false],
    ['vnořený workflow: lokální const workflow vypíná kontrolu', wf(`const workflow = mk()\nawait workflow({ scriptPath: 'bad.js' })`, { cwd: nest }), false],
    ['vnořený workflow: stejná cesta dvakrát se hlásí jednou, ale hlásí se', wf(`await workflow({ scriptPath: 'bad.js' })\nawait workflow({ scriptPath: 'bad.js' })`, { cwd: nest }), true],
    ['vnořený workflow: forced model, potomek jen s effort', wf(`await workflow({ scriptPath: 'forced-child.js' })`, { cwd: nest }), false, { ...ENV, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }],
    ['vnořený workflow: bez forced model potomek bez modelu zamítne', wf(`await workflow({ scriptPath: 'forced-child.js' })`, { cwd: nest }), true, WF_ENV],
  ];
  for (const [name, input, want, env] of rows) {
    it(`${name} -> ${want ? 'zamítne' : 'povolí'}`, () => {
      if (want) zamitne(input, env ?? ENV); else povoli(input, env ?? ENV);
    });
  }
  it('vnořený workflow: nález nese cestu souboru a řádek v něm', () => {
    const r = zamitne(wf(`await workflow({ scriptPath: 'sub/bad2.js' })`, { cwd: nest }));
    plati(r.includes('řádek 2 v sub/bad2.js (chybí model a effort)'), `Nález z vnořeného workflow má nést cestu a řádek. Důvod: ${r}`);
  });
  it('vnořený workflow: cesta se hlásí jednou, i když ji skript volá dvakrát', () => {
    const r = zamitne(wf(`await workflow({ scriptPath: 'bad.js' })\nawait workflow({ scriptPath: 'bad.js' })`, { cwd: nest }));
    rovno(r.split('v bad.js').length - 1, 1, 'Soubor bad.js se má ve výčtu nálezů objevit jednou');
  });
  it('vnořený workflow přes checkScript a loadScript: nález má file, vnuk se nenačítá', () => {
    const nactene = [];
    const mapa = { 'a.js': `workflow({ scriptPath: 'b.js' })\nagent('x')`, 'b.js': 'agent("y")' };
    const nalezy = checkScript(`workflow({ scriptPath: 'a.js' })`, () => false, { loadScript: (p) => { nactene.push(p); return mapa[p] ?? null; } });
    rovno([nactene, nalezy.map((b) => `${b.file}:${b.line}`)], [['a.js'], ['a.js:2']], 'Načíst se má jen a.js a nález nese file a řádek');
  });
  it('loadScript, který vyhodí výjimku, se bere jako nečitelný soubor (povolí se)', () => {
    rovno(checkScript(`workflow({ scriptPath: 'a.js' })`, () => false, { loadScript: () => { throw new Error('nelze číst'); } }), [], 'Výjimka při čtení potomka se nesmí šířit');
  });
  it('loadScript vrací null: potomek se přeskočí', () => {
    rovno(checkScript(`workflow({ scriptPath: 'a.js' })`, () => false, { loadScript: () => null }), [], 'null z loadScript znamená nečitelný soubor');
  });
  it('bez loadScript se vnořené workflow nekontroluje', () => {
    rovno(checkScript(`workflow({ scriptPath: 'a.js' })`, () => false), [], 'Bez loadScript není co číst');
  });
});

describe('decide: text zamítnutí Workflow', () => {
  it('uvádí řádek, příklad opravy, skill, vestavěné typy a nemá em dash', () => {
    const r = zamitne(wf(`const x = 1\nagent('p', { schema: S })`));
    for (const kus of ['řádek 2', '(chybí model a effort)', 'LEVNE', 'skill orchestrace', "model: 'opus'", 'general-purpose, Explore']) {
      plati(r.includes(kus), `Důvod má obsahovat „${kus}“. Důvod: ${r}`);
    }
    plati(!r.includes(EM_DASH), 'Důvod nesmí obsahovat em dash.');
  });
  it('chybí jen effort: jmenuje jen effort', () => {
    plati(zamitne(wf(`agent('p', { model: 'haiku' })`)).includes('(chybí effort)'), 'Důvod má říct, že chybí effort.');
  });
  it('chybí jen model: jmenuje jen model', () => {
    plati(zamitne(wf(`agent('p', { effort: 'low' })`)).includes('(chybí model)'), 'Důvod má říct, že chybí model.');
  });
  it('víc nálezů se spojí čárkou a čísla řádků sedí', () => {
    const r = zamitne(wf(`agent('a')\n\nagent('b', {})`));
    plati(r.includes('řádek 1 (chybí model a effort), řádek 3 (chybí model a effort)'), `Důvod má vyjmenovat oba řádky. Důvod: ${r}`);
  });
  it('víc než 10 nálezů se zkrátí na „a dalších N“', () => {
    const r = zamitne(wf(Array.from({ length: 12 }, () => `agent('p')`).join('\n')));
    plati(r.includes('řádek 10 (chybí model a effort) a dalších 2') && !r.includes('řádek 11'), `Výčet se má zkrátit po 10 nálezech. Důvod: ${r}`);
  });
  it('přesně 10 nálezů se vypíše celých', () => {
    const r = zamitne(wf(Array.from({ length: 10 }, () => `agent('p')`).join('\n')));
    plati(r.includes('řádek 10') && !r.includes('a dalších'), `Deset nálezů se vejde bez zkrácení. Důvod: ${r}`);
  });
  it('agent jako hodnota: formulace „nejde ověřit“ a rada o přímém volání', () => {
    const r = zamitne(wf('const a = agent'));
    for (const kus of ['nejde ověřit model a effort u agent()', 'řádek 1 (agent předán jako hodnota)', 'jen přímým voláním agent(prompt, { model, effort })']) {
      plati(r.includes(kus), `Důvod má obsahovat „${kus}“. Důvod: ${r}`);
    }
  });
  it('\\u escape: formulace „nejde ověřit“ a popis nálezu', () => {
    const r = zamitne(wf("agent\\u0061('p')"));
    plati(r.includes('řádek 1 (\\u escape v identifikátoru)') && r.includes('nejde ověřit'), `Důvod má popsat escape. Důvod: ${r}`);
  });
  it('smíšené nálezy (chybí klíč i hodnota): použije se „nemá každé agent()“ a rada o hodnotách', () => {
    const r = zamitne(wf(`agent('p')\nconst a = agent`));
    plati(r.includes('nemá každé agent() model a effort') && r.includes('jen přímým voláním'), `Důvod má obsahovat obě rady. Důvod: ${r}`);
  });
  it('zamítnutí agentType general-purpose zmiňuje vestavěné typy', () => {
    const r = zamitne(wf(`await agent(p, { agentType: 'Explore', effort: 'low' })`));
    plati(r.includes('general-purpose, Explore'), `Důvod má zmínit vestavěné typy. Důvod: ${r}`);
  });
});

const wfType = (type, extra = '') => wf(`await agent(p, { agentType: '${type}', effort: 'low'${extra} })`);
describe('decide: Workflow agentType proti definicím na disku', () => {
  const rows = [
    ['general-purpose bez model', wfType('general-purpose'), true],
    ['general-purpose s model', wfType('general-purpose', ", model: 'haiku'"), false],
    ['Explore bez model', wfType('Explore'), true],
    ['vlastní typ s model v definici', wfType('ma-model'), false],
    ['vlastní typ bez model v definici', wfType('bez-modelu'), true],
    ['vlastní typ s model: inherit', wfType('dedi'), true],
    ['vlastní typ bez definice', wfType('neexistuje'), true],
    ['vlastní typ s cestou v názvu', wfType('../ma-model'), true],
    ['fork', wfType('fork'), false],
    ['agent z pluginu', wfType('plugin:reviewer'), false],
    ['vlastní typ z konfigurace', wfType('z-konfigurace'), false],
    ['vlastní typ v podsložce agents', wfType('vnoreny'), false],
  ];
  for (const [name, input, want] of rows) {
    it(`${name} -> ${want ? 'zamítne' : 'povolí'}`, () => { if (want) zamitne(input); else povoli(input); });
  }
  it('definice se čtou z cwd a jejích rodičů i u Workflow', () => {
    povoli({ ...wf(`agent(p, { agentType: 'jen-v-sub', effort: 'low' })`), cwd: deep }, { CLAUDE_CONFIG_DIR: cfg });
  });
});

describe('decide: konkrétní zamítnutí z reálných skriptů', () => {
  it('reálný skript se všemi model a effort projde', () => povoli(wf(real)));
  it('reálný skript s jedním vadným volání zamítne a uvede jeho řádek', () => {
    const bad = real.replace('{ ...SILNE, schema: VERDICT }', '{ schema: VERDICT }');
    const radek = bad.split('\n').findIndex((l) => l.includes("'Ověř '")) + 1;
    const r = zamitne(wf(bad));
    plati(r.includes(`řádek ${radek} (chybí model a effort)`), `Důvod má uvést řádek ${radek}. Důvod: ${r}`);
  });
  it('regex po if nezpůsobí falešné zamítnutí', () => {
    povoli(wf(`if (ok) /\`/.test(s)\nconst p = \`Use agent(x) here\`\n${okCall}\n`));
  });
  it('options předaný funkci projde', () => povoli(wf('const L = { schema: S }\nfill(L)\nawait agent(p, L)\n')));
});

describe('decide: CRLF a BOM ve skriptu workflow', () => {
  it('CRLF konce řádků: čísla řádků sedí', () => {
    rovno(lines(`const x = 1\r\nconst y = 2\r\nagent('p')\r\n`), ['3:model+effort'], 'Se CRLF se řádky mají počítat stejně jako s LF');
  });
  it('CRLF uvnitř options', () => {
    rovno(lines(`agent(p, {\r\n  model: 'haiku',\r\n  effort: 'low',\r\n})\r\n`), [], 'Options přes víc řádků s CRLF jsou v pořádku');
  });
  it('CRLF a komentář // končí na \\r\\n', () => {
    rovno(lines(`// agent('p')\r\nagent('q', { model: 'haiku', effort: 'low' })\r\n`), [], 'Komentář má skončit na konci řádku s CRLF');
  });
  it('BOM na začátku skriptu nevadí', () => {
    rovno(lines(`\ufeffagent('p')`), ['1:model+effort'], 'BOM před kódem nesmí kontrolu vyřadit');
  });
  it('skript ze souboru s BOM a CRLF se zkontroluje', () => {
    const f = soubor(join(nest, 'bom-crlf.js'), `\ufeffconst x = 1\r\nagent('p')\r\n`);
    const r = zamitne(wfPath(f));
    plati(r.includes('řádek 2'), `Soubor s BOM a CRLF má nahlásit řádek 2. Důvod: ${r}`);
  });
});

// ---------------------------------------------------------------------------------------------------------
// obecné: vypínač, neznámé tvary, fail-open
// ---------------------------------------------------------------------------------------------------------
describe('decide: vypínač ORCHESTRACE_GUARD', () => {
  for (const v of ['off', 'OFF', 'Off', ' off ', '\toff\n']) {
    it(`ORCHESTRACE_GUARD=${J(v)} vypne kontrolu Agent i Workflow`, () => {
      povoli(agent({ prompt: 'x' }), { ...ENV, ORCHESTRACE_GUARD: v });
      povoli(wf(`agent('p')`), { ORCHESTRACE_GUARD: v });
    });
  }
  for (const v of ['on', '', '0', 'false', 'no', 'offf', 'of', '1']) {
    it(`ORCHESTRACE_GUARD=${J(v)} kontrolu nevypíná`, () => {
      zamitne(agent({ prompt: 'x' }), { ...ENV, ORCHESTRACE_GUARD: v });
      zamitne(wf(`agent('p')`), { ...ENV, ORCHESTRACE_GUARD: v });
    });
  }
  it('vypínač působí i na Task', () => povoli(agent({ prompt: 'x' }, 'Task'), { ...ENV, ORCHESTRACE_GUARD: 'off' }));
  it('vypínač působí i na špatný vstup bez chyby', () => povoli(null, { ORCHESTRACE_GUARD: 'off' }));
});

describe('decide: jiné nástroje a neznámé tvary vstupu (fail-open)', () => {
  const rows = [
    ['jiný nástroj (Bash) s textem agent(', { tool_name: 'Bash', tool_input: { command: "agent('p')" } }],
    ['jiný nástroj (Write) se skriptem', { tool_name: 'Write', tool_input: { file_path: 'a.js', content: "agent('p')" } }],
    ['jiný nástroj (Read)', { tool_name: 'Read', tool_input: { file_path: 'a.js' } }],
    ['malá písmena v názvu nástroje (agent)', { tool_name: 'agent', tool_input: { prompt: 'x' } }],
    ['malá písmena v názvu nástroje (workflow)', { tool_name: 'workflow', tool_input: { script: "agent('p')" } }],
    ['jiný nástroj s příponou (AgentX)', { tool_name: 'AgentX', tool_input: { prompt: 'x' } }],
    ['chybí tool_name', { tool_input: { prompt: 'x' } }],
    ['tool_name není řetězec', { tool_name: 5, tool_input: { prompt: 'x' } }],
    ['tool_name null', { tool_name: null, tool_input: { prompt: 'x' } }],
    ['Agent bez tool_input', { tool_name: 'Agent' }],
    ['Workflow bez tool_input', { tool_name: 'Workflow' }],
    ['tool_input je řetězec', { tool_name: 'Agent', tool_input: 'x' }],
    ['tool_input je číslo', { tool_name: 'Agent', tool_input: 7 }],
    ['tool_input je null', { tool_name: 'Agent', tool_input: null }],
    ['tool_input je pole (Agent)', { tool_name: 'Agent', tool_input: [] }],
    ['tool_input je pole (Workflow)', { tool_name: 'Workflow', tool_input: [{ script: "agent('p')" }] }],
    ['tool_input je true', { tool_name: 'Workflow', tool_input: true }],
    ['prázdný objekt', {}],
    ['null na vstupu', null],
    ['undefined na vstupu', undefined],
    ['řetězec na vstupu', 'Agent'],
    ['číslo na vstupu', 42],
    ['pole na vstupu', [{ tool_name: 'Agent', tool_input: { prompt: 'x' } }]],
  ];
  for (const [name, input] of rows) it(`${name} -> povolí`, () => povoli(input));

  it('výjimka při čtení vstupu (getter) se spolkne a povolí', () => {
    const jed = { get tool_input() { throw new Error('boom'); }, tool_name: 'Agent' };
    povoli(jed);
  });
  it('výjimka u tool_name (Proxy) se spolkne a povolí', () => {
    povoli(new Proxy({}, { get() { throw new Error('boom'); } }));
  });
  it('cyklický vstup nevadí', () => {
    const o = { tool_name: 'Agent', tool_input: { prompt: 'x', model: 'haiku' } };
    o.self = o;
    povoli(o);
  });
  it('decide bez druhého argumentu čte process.env a vrací null nebo řetězec', () => {
    const r = decide({ tool_name: 'Bash', tool_input: {} });
    rovno(r, null, 'Jiný nástroj se má povolit i s výchozím prostředím');
  });
  it('decide nikdy nevyhodí výjimku na pseudonáhodných vstupech (pevné semínko)', () => {
    const rand = rng(12345);
    const hodnoty = [null, undefined, 0, 1, -1, '', 'x', [], {}, true, false, NaN, 'agent(', { a: 1 }, [1, 2]];
    const pick = () => hodnoty[Math.floor(rand() * hodnoty.length)];
    for (let i = 0; i < 300; i++) {
      const input = { tool_name: rand() < 0.3 ? 'Workflow' : rand() < 0.5 ? 'Agent' : 'Task', cwd: pick(), tool_input: { script: pick(), scriptPath: pick(), model: pick(), subagent_type: pick(), prompt: pick() } };
      const r = decide(input, { ...ENV, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: pick(), CLAUDE_CODE_SUBAGENT_MODEL: pick(), ORCHESTRACE_GUARD: pick() });
      plati(r === null || typeof r === 'string', `decide vrátil neplatnou hodnotu pro vstup ${kratce(input)}: ${kratce(r)}`);
    }
  });
});

describe('mask: tokenizér, který ze skriptu odstraní řetězce, komentáře a regex literály', () => {
  const VZORKY = [
    '', 'a', "agent('p')", 'x = "a\\"b"', "x = 'a\\'b'", 'x = `a${b}c`', 'x = `a${`b${c}`}c`', '// komentář\nx', '/* a\nb */ x',
    'x = /a[/]b/g', 'x = a / b / c', 'if (x) /y/.test(z)', 'x = "neukončený', 'x = `neukončená', '/* neukončený',
    "x = 'a\\\nb'", 'x = "řetězec s českými znaky ěščř"', 'a\r\nb\r\n', 'x = `\r\n${a}\r\n`', "i++ / 2 + '/'", '${}', '`${`', '{{{{', '))))',
  ];
  for (const v of VZORKY) {
    it(`zachová délku a konce řádků: ${J(v)}`, () => {
      const m = mask(v);
      rovno([m.length, m.split('\n').length, m.split('\r').length], [v.length, v.split('\n').length, v.split('\r').length], `mask musí vrátit text stejné délky se stejnými konci řádků, aby seděla čísla řádků. Vstup: ${J(v)}`);
    });
  }
  const rows = [
    ['řetězec v apostrofech je prázdný', "x = 'agent(p)'", (m) => !m.includes('agent') && m.startsWith('x = ')],
    ['řetězec v uvozovkách je prázdný', 'x = "agent(p)"', (m) => !m.includes('agent')],
    ['řetězec s escapovanou uvozovkou je celý prázdný', 'x = "a\\"agent("; y', (m) => !m.includes('agent') && m.endsWith('; y')],
    ['komentář // se zruší do konce řádku, další řádek zůstane', '// agent(p)\nz = 1', (m) => !m.includes('agent') && m.endsWith('\nz = 1')],
    ['komentář /* */ se zruší včetně nových řádků uvnitř (zůstanou)', '/* agent(\n) */ z', (m) => !m.includes('agent') && m.includes('\n') && m.endsWith(' z')],
    ['text šablony se zruší, ${ } se změní na ( )', 'x = `a${agent(1)}b`', (m) => m.includes('(agent(1))') && !m.includes('${') && !m.includes('`')],
    ['vnořená šablona: kód ve vnořeném ${} zůstane', 'x = `a${`b${agent(2)}`}`', (m) => m.includes('agent(2)')],
    ['regex literál se zruší', 'x = /agent\\(/g', (m) => !m.includes('agent')],
    ['regex s lomítkem ve třídě znaků', 'x = /[/agent]/g; y', (m) => !m.includes('agent') && m.endsWith('; y')],
    ['dělení není regex', 'x = a / agent / c', (m) => m.includes('agent')],
    ['dělení po zavřené závorce není regex', 'x = (a) / agent / c', (m) => m.includes('agent')],
    ['regex po if (...) je regex', 'if (x) /agent/.test(s)', (m) => !m.includes('agent')],
    ['dělení po i++', 'i++ / agent / 2', (m) => m.includes('agent')],
    ['kód mimo řetězce zůstane beze změny', 'const a = agent(p, { model })', (m) => m === 'const a = agent(p, { model })'],
    ['neukončený řetězec končí s koncem řádku (kód na dalším řádku zůstane)', 'x = "abc\nagent(p)', (m) => m.endsWith('\nagent(p)')],
    ['neukončený /* komentář zruší zbytek', 'a /* agent(', (m) => !m.includes('agent')],
    ['řetězec s \\r\\n za zpětným lomítkem (pokračování řádku)', 'x = "a\\\r\nagent"; y', (m) => !m.includes('agent') && m.endsWith('; y')],
  ];
  for (const [name, vstup, platne] of rows) {
    it(name, () => {
      const m = mask(vstup);
      plati(platne(m), `Vstup: ${J(vstup)}\n  Výstup masky: ${J(m)}`);
    });
  }
  it('hluboce vnořené šablony nevyčerpají zásobník volání (rámce na zásobníku, ne rekurze)', () => {
    const hloubka = 20000;
    const vstup = '`${'.repeat(hloubka) + 'agent(1)' + '}`'.repeat(hloubka);
    const m = mask(vstup);
    rovno(m.length, vstup.length, 'Maska má mít délku vstupu i při hlubokém vnoření');
  });
  it('pseudonáhodné vstupy z tokenů JavaScriptu (pevné semínko): délka masky vždy sedí a decide nevyhodí výjimku', () => {
    const rand = rng(777);
    const tok = ["'", '"', '`', '/', '\\', '${', '}', '{', '(', ')', '[', ']', '\n', '\r\n', ' ', '*', '+', '-', '=', 'agent', 'workflow', 'model', 'effort', ',', ':', ';', '.', '=>', '...', 'const ', 'let ', 'if', 'u0061', 'š', 'agentType', '//', '/*', '*/'];
    for (let i = 0; i < 500; i++) {
      let s = '';
      const n = 1 + Math.floor(rand() * 40);
      for (let k = 0; k < n; k++) s += tok[Math.floor(rand() * tok.length)];
      const m = mask(s);
      rovno(m.length, s.length, `mask změnila délku pro vstup ${J(s)}`);
      const r = decide(wf(s), ENV);
      plati(r === null || typeof r === 'string', `decide vrátil neplatnou hodnotu pro skript ${J(s)}`);
    }
  });
  it('každá předpona reálného skriptu se zpracuje bez výjimky (zkrácený skript je běžný vstup při psaní)', () => {
    for (let n = 0; n <= real.length; n += 11) {
      const kus = real.slice(0, n);
      const m = mask(kus);
      rovno(m.length, kus.length, `mask změnila délku pro předponu délky ${n}`);
      const r = decide(wf(kus), ENV);
      plati(r === null || typeof r === 'string', `decide vrátil neplatnou hodnotu pro předponu délky ${n}`);
    }
  });
  it('hluboké vnoření závorek a složených závorek se zpracuje bez výjimky', () => {
    for (const z of ['(', '[', '{']) {
      const kus = z.repeat(30000) + "agent('p')";
      const r = decide(wf(kus), ENV);
      plati(r === null || typeof r === 'string', `decide vrátil neplatnou hodnotu pro ${z.repeat(3)}... (30000 úrovní)`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// isMain: je modul spuštěný přímo?
// ---------------------------------------------------------------------------------------------------------
describe('isMain: porovnání skutečných cest (symlink, junction, relativní cesta)', () => {
  const metaUrl = pathToFileURL(HOOK).href;
  it('stejná cesta -> true', () => rovno(isMain(metaUrl, HOOK), true, 'Přímé spuštění se má poznat'));
  it('jiný soubor -> false', () => rovno(isMain(metaUrl, fileURLToPath(import.meta.url)), false, 'Import z jiného skriptu není přímé spuštění'));
  it('prázdný argv1 -> false', () => rovno(isMain(metaUrl, ''), false, 'Bez argv[1] se hook nespouští'));
  it('undefined argv1 se bere z process.argv[1] (spustil ho test runner, ne hook) -> false', () => rovno(isMain(metaUrl, undefined), false, 'Test runner není hook'));
  it('argv1 nedohledatelný soubor -> false', () => rovno(isMain(metaUrl, join(root, 'neexistuje.mjs')), false, 'Nečitelná cesta nesmí vyhodit výjimku'));
  it('metaUrl nedohledatelný soubor -> false', () => rovno(isMain(pathToFileURL(join(root, 'neexistuje.mjs')).href, HOOK), false, 'Nečitelná cesta nesmí vyhodit výjimku'));
  it('metaUrl není URL -> false', () => rovno(isMain('neni-url', HOOK), false, 'Chybný metaUrl nesmí vyhodit výjimku'));
  it('relativní cesta k témuž souboru -> true', () => {
    const rel = join('.', 'orchestrace-guard.mjs');
    const puvodni = process.cwd();
    try { process.chdir(HOOKS_DIR); rovno(isMain(metaUrl, rel), true, 'Relativní cesta k témuž souboru se má poznat'); } finally { process.chdir(puvodni); }
  });
  it('cesta s ./ a ../ uprostřed -> true', () => {
    rovno(isMain(metaUrl, join(HOOKS_DIR, '..', 'hooks', '.', 'orchestrace-guard.mjs')), true, 'Normalizace cesty se má poznat');
  });
  it('symlink nebo junction na složku s hookem -> true', (t) => {
    const link = join(root, 'link-hooks');
    try { symlinkSync(HOOKS_DIR, link, 'junction'); } catch (e) { return t.skip(`symlink ani junction nejde vytvořit (${e.code})`); }
    rovno(isMain(metaUrl, join(link, 'orchestrace-guard.mjs')), true, 'Cesta přes symlink nebo junction se má rozbalit na skutečnou');
  });
  it('symlink na soubor hooku -> true', (t) => {
    const link = join(root, 'link-soubor.mjs');
    try { symlinkSync(HOOK, link, 'file'); } catch (e) { return t.skip(`symlink na soubor nejde vytvořit (${e.code})`); }
    rovno(isMain(metaUrl, link), true, 'Symlink na soubor hooku se má rozbalit na skutečnou cestu');
  });
});

// ---------------------------------------------------------------------------------------------------------
// hook jako proces (příkaz a args z hooks.json, exec form, bez shellu)
// ---------------------------------------------------------------------------------------------------------
describe('hook jako proces: stdin JSON, stdout JSON, exit kód', () => {
  it('Agent bez model: přesný tvar zamítnutí, exit 0, prázdný stderr', () => {
    const r = spawnHook(agent({ prompt: 'x' }));
    plati(jeZamitnuti(r), `Čekalo se zamítnutí s exit 0 a prázdným stderr. ${popis(r)}`);
    const out = r.json.hookSpecificOutput;
    rovno(Object.keys(r.json), ['hookSpecificOutput'], 'Výstup má mít jediný klíč hookSpecificOutput');
    rovno(Object.keys(out).sort(), ['hookEventName', 'permissionDecision', 'permissionDecisionReason'], 'hookSpecificOutput má mít přesně tři pole');
    rovno([out.hookEventName, out.permissionDecision, typeof out.permissionDecisionReason], ['PreToolUse', 'deny', 'string'], 'Pole zamítnutí mají jiné hodnoty');
    rovno(r.stdout.endsWith('\n') && r.stdout.trimEnd().split('\n').length === 1, true, 'Výstup má být jeden řádek JSON zakončený novým řádkem');
  });
  it('důvod z procesu je stejný jako z decide()', () => {
    const input = agent({ prompt: 'x', subagent_type: 'bez-modelu' });
    const r = spawnHook(input);
    rovno(r.json?.hookSpecificOutput?.permissionDecisionReason, decide(input, { CLAUDE_PROJECT_DIR: proj, CLAUDE_CONFIG_DIR: cfg }), 'Proces a decide() mají dát stejný důvod');
  });
  it('Task bez model zamítne', () => plati(jeZamitnuti(spawnHook(agent({ prompt: 'x' }, 'Task'))), 'Task bez model měl být zamítnut.'));
  it('Agent s model projde bez výstupu', () => {
    const r = spawnHook(agent({ prompt: 'x', model: 'sonnet' }));
    plati(mlci(r), `Agent s model měl projít mlčky. ${popis(r)}`);
  });
  it('Workflow inline script bez model zamítne a uvede řádek', () => {
    const r = spawnHook(wf("agent('p', { schema: S })"));
    plati(jeZamitnuti(r) && r.stdout.includes('řádek 1'), `Workflow měl být zamítnut s řádkem 1. ${popis(r)}`);
  });
  it('Workflow agentType general-purpose zamítne a uvede chybějící model', () => {
    const r = spawnHook(wf('await agent(p, { agentType: "general-purpose", effort: "low" })\n'));
    plati(jeZamitnuti(r) && r.stdout.includes('řádek 1 (chybí model)'), `Čekalo se zamítnutí s „řádek 1 (chybí model)“. ${popis(r)}`);
  });
  it('Workflow v pořádku projde', () => {
    const r = spawnHook(wf(GOOD));
    plati(mlci(r), `Workflow v pořádku měl projít mlčky. ${popis(r)}`);
  });
  it('Workflow scriptPath absolutní', () => {
    plati(jeZamitnuti(spawnHook(wfPath(join(nest, 'bad.js')))), 'Vadný soubor workflow měl být zamítnut.');
    plati(mlci(spawnHook(wfPath(join(nest, 'good.js')))), 'Soubor workflow v pořádku měl projít.');
  });
  it('Workflow scriptPath relativně k cwd z payloadu', () => {
    plati(jeZamitnuti(spawnHook(wfPath('bad.js', { cwd: nest }))), 'Relativní scriptPath se má číst od cwd z payloadu.');
  });
  it('Workflow scriptPath relativně k pracovní složce procesu (payload bez cwd)', () => {
    plati(jeZamitnuti(spawnHook(wfPath('bad.js'), { cwd: nest })), 'Bez cwd v payloadu se relativní cesta čte od pracovní složky procesu.');
  });
  it('vnořený workflow přes proces', () => {
    plati(jeZamitnuti(spawnHook(wf(`await workflow({ scriptPath: 'bad.js' })`, { cwd: nest }))), 'Vnořený workflow měl být zamítnut.');
  });
  it('vlastní typ s model v definici (agenti z CLAUDE_PROJECT_DIR) projde', () => {
    plati(mlci(spawnHook(agent({ prompt: 'x', subagent_type: 'ma-model' }))), 'Typ s model v definici měl projít.');
  });
  it('payload s cwd: agenti se hledají od cwd nahoru', () => {
    const r = spawnHook({ ...agent({ prompt: 'x', subagent_type: 'jen-v-sub' }), cwd: deep }, { env: { CLAUDE_PROJECT_DIR: '' } });
    plati(mlci(r), `Agent z .claude/agents nad cwd měl projít. ${popis(r)}`);
  });
  it('FORCE v prostředí procesu: Agent bez model projde', () => {
    plati(mlci(spawnHook(agent({ prompt: 'x' }), { env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } })), 'S FORCE měl Agent projít.');
  });
  it('CLAUDE_CODE_SUBAGENT_MODEL v prostředí procesu se objeví v důvodu', () => {
    const r = spawnHook(agent({ prompt: 'x' }), { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' } });
    plati(jeZamitnuti(r) && r.json.hookSpecificOutput.permissionDecisionReason.includes('CLAUDE_CODE_SUBAGENT_MODEL (opus)'), `Důvod má zmínit proměnnou. ${popis(r)}`);
  });
  for (const v of ['off', 'OFF', ' Off ']) {
    it(`ORCHESTRACE_GUARD=${J(v)} v prostředí procesu: bez výstupu`, () => {
      const r = spawnHook(agent({ prompt: 'x' }), { env: { ORCHESTRACE_GUARD: v } });
      plati(mlci(r), `Vypínač měl hook ztišit. ${popis(r)}`);
    });
  }
  it('ORCHESTRACE_GUARD=on kontrolu nevypíná', () => {
    plati(jeZamitnuti(spawnHook(agent({ prompt: 'x' }), { env: { ORCHESTRACE_GUARD: 'on' } })), 'Hodnota on nesmí kontrolu vypnout.');
  });
  it('vstup s BOM (PowerShell 5.1 ho přidává při předání rourou) zamítne', () => {
    const r = spawnHook('\ufeff' + J(agent({ prompt: 'x' })));
    plati(jeZamitnuti(r), `Vstup s BOM měl být zamítnut. ${popis(r)}`);
  });
  it('JSON s CRLF a odsazením zamítne', () => {
    const r = spawnHook(JSON.stringify(agent({ prompt: 'x' }), null, 2).replace(/\n/g, '\r\n') + '\r\n');
    plati(jeZamitnuti(r), `Pěkně formátovaný JSON s CRLF měl být zamítnut. ${popis(r)}`);
  });
  it('JSON s češtinou a emoji v promptu zamítne (UTF-8 na stdin)', () => {
    const r = spawnHook(agent({ prompt: 'Přeložit řetězec ěščřžýáíé ' + String.fromCodePoint(0x1F600) }));
    plati(jeZamitnuti(r), `UTF-8 vstup měl být zamítnut. ${popis(r)}`);
  });
  it('velký vstup (4,5 MB skript) projde a hook doběhne', () => {
    const r = spawnHook(wf(`agent('p')\n${' '.repeat(4_500_000)}`));
    plati(mlci(r), `Příliš velký skript měl projít mlčky. ${popis(r)}`);
  });
  const mlcky = [
    ['neplatný JSON', 'není json'],
    ['prázdný vstup', ''],
    ['jen bílé znaky', '  \n\t '],
    ['jen BOM', '\ufeff'],
    ['ořezaný JSON', '{"tool_name":"Agent","tool_input":{"prompt":'],
    ['JSON null', 'null'],
    ['JSON pole', '[]'],
    ['JSON řetězec', '"Agent"'],
    ['JSON číslo', '123'],
    ['JSON true', 'true'],
    ['prázdný objekt', '{}'],
    ['jiný nástroj (Bash)', J({ tool_name: 'Bash', tool_input: { command: 'ls' } })],
    ['Agent s tool_input jako pole', J({ tool_name: 'Agent', tool_input: [] })],
    ['Agent s tool_input jako řetězec', J({ tool_name: 'Agent', tool_input: 'x' })],
    ['dva JSON objekty za sebou', J(agent({ prompt: 'x' })) + J(agent({ prompt: 'x' }))],
  ];
  for (const [name, vstup] of mlcky) {
    it(`fail-open: ${name} -> exit 0, bez výstupu`, () => {
      const r = spawnHook(vstup);
      plati(mlci(r), `Hook měl vstup tiše povolit (exit 0, prázdný stdout i stderr). ${popis(r)}`);
    });
  }
  it('invalidní bajty UTF-8 na vstupu: exit 0 a hook nespadne', () => {
    const r = spawnSync(handler.command, wiredArgs(), { input: Buffer.from([0xff, 0xfe, 0x7b, 0x80, 0x7d]), shell: false, env: cleanEnv({ CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }), timeout: 20000 });
    rovno([r.status, r.stdout.length], [0, 0], 'Poškozený vstup má skončit exit 0 bez výstupu');
  });
  it('hook doběhne v časovém limitu z hooks.json', () => {
    const limit = (handler?.timeout ?? 10) * 1000;
    const zacatek = Date.now();
    const r = spawnHook(wf(real), { timeout: limit });
    const trvani = Date.now() - zacatek;
    plati(r.status === 0 && trvani < limit, `Hook má doběhnout do ${limit} ms (timeout v ${KDE_JSON}); trvalo ${trvani} ms, ${popis(r)}`, KDE_JSON);
  });
  it('import modulu hook nespustí (nečte stdin, nevolá exit, nic nevypisuje)', () => {
    const kod = 'import(process.env.HOOK_URL).then(() => { process.stdout.write("naimportovano\\n"); })';
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', kod], {
      input: J(agent({ prompt: 'x' })), encoding: 'utf8', shell: false, timeout: 20000,
      env: cleanEnv({ HOOK_URL: pathToFileURL(HOOK).href }),
    });
    rovno([r.status, r.stdout, r.stderr], [0, 'naimportovano\n', ''], 'Importovaný modul nesmí spustit hlavní část (isMain)');
  });
  it('spuštění přes symlink nebo junction na složku hooks zamítá (isMain rozbalí cestu)', (t) => {
    const link = join(root, 'link-proces');
    try { symlinkSync(HOOKS_DIR, link, 'junction'); } catch (e) { return t.skip(`symlink ani junction nejde vytvořit (${e.code})`); }
    const r = spawnSync(handler.command, [join(link, 'orchestrace-guard.mjs')], { input: J(agent({ prompt: 'x' })), encoding: 'utf8', shell: false, env: cleanEnv(), timeout: 20000 });
    plati(r.status === 0 && r.stdout.includes('"permissionDecision":"deny"'), `Přes symlink nebo junction měl hook zamítnout (jinak by ticho znamenalo, že nic nehlídá). exit ${r.status}, stdout ${kratce(r.stdout)}`);
  });
  it('spuštění s relativní cestou z pracovní složky hooks zamítá', () => {
    const r = spawnSync(handler.command, ['./orchestrace-guard.mjs'], { input: J(agent({ prompt: 'x' })), encoding: 'utf8', shell: false, cwd: HOOKS_DIR, env: cleanEnv(), timeout: 20000 });
    plati(r.status === 0 && r.stdout.includes('"permissionDecision":"deny"'), `Relativní cesta měla zamítnout. exit ${r.status}, stdout ${kratce(r.stdout)}`);
  });
  it('kořen pluginu s mezerami a českou diakritikou (exec form bez shellu)', () => {
    const koren = join(root, 'Složka s mezerou', 'Příliš žluťoučký plugin');
    mkdirSync(join(koren, 'hooks'), { recursive: true });
    copyFileSync(HOOK, join(koren, 'hooks', 'orchestrace-guard.mjs'));
    copyFileSync(HOOKS_JSON, join(koren, 'hooks', 'hooks.json'));
    const r = spawnHook(agent({ prompt: 'x' }), { rootDir: koren });
    plati(jeZamitnuti(r), `Hook v cestě s mezerami a diakritikou měl zamítnout. ${popis(r)}`, KDE_JSON);
    plati(mlci(spawnHook(agent({ prompt: 'x', model: 'haiku' }), { rootDir: koren })), 'Hook v cestě s mezerami měl povolit Agent s model.');
  });
  it('hook je jeden soubor: spustí se zkopírovaný samotný do prázdné složky (bez závislostí)', () => {
    const sam = join(root, 'jen-hook');
    mkdirSync(sam, { recursive: true });
    copyFileSync(HOOK, join(sam, 'orchestrace-guard.mjs'));
    const r = spawnSync(handler.command, [join(sam, 'orchestrace-guard.mjs')], { input: J(agent({ prompt: 'x' })), encoding: 'utf8', shell: false, env: cleanEnv(), timeout: 20000 });
    plati(r.status === 0 && r.stdout.includes('"permissionDecision":"deny"'), `Hook nesmí záviset na dalších souborech (viz hlavička hooku). exit ${r.status}, stderr ${kratce(r.stderr)}`);
  });
});

// ---------------------------------------------------------------------------------------------------------
// zapojení: hooks.json
// ---------------------------------------------------------------------------------------------------------
describe('zapojení v hooks.json', () => {
  it('hooks.json je platný JSON objekt', () => {
    plati(pluginHooks !== null && typeof pluginHooks === 'object' && !Array.isArray(pluginHooks), `${KDE_JSON} se nepodařilo přečíst jako JSON objekt.`, KDE_JSON);
  });
  it('událost je jen PreToolUse a je jeden záznam', () => {
    rovno([Object.keys(pluginHooks?.hooks ?? {}), entries.length], [['PreToolUse'], 1], 'V hooks.json má být jedna událost PreToolUse s jedním záznamem', KDE_JSON);
  });
  it('matcher je přesně Workflow|Agent|Task', () => {
    rovno(entry?.matcher, 'Workflow|Agent|Task', 'Matcher musí pokrýt nástroje Workflow, Agent a Task (Task je starý název Agent)', KDE_JSON);
  });
  it('matcher je seznam přesných názvů nástrojů (jen písmena a |)', () => {
    const names = (entry?.matcher ?? '').split('|');
    rovno([/^[A-Za-z|]+$/.test(entry?.matcher ?? ''), [...names].sort()], [true, ['Agent', 'Task', 'Workflow']], 'Matcher jen z písmen a svislítek je podle dokumentace seznam přesných názvů nástrojů', KDE_JSON);
  });
  it('záznam má jediný handler typu command', () => {
    rovno([entry?.hooks?.length, handler?.type], [1, 'command'], 'Záznam má mít jeden handler typu command', KDE_JSON);
  });
  it('exec form: command je jen node a args je pole s jednou cestou přes ${CLAUDE_PLUGIN_ROOT}', () => {
    rovno([handler?.command, handler?.args], ['node', ['${CLAUDE_PLUGIN_ROOT}/hooks/orchestrace-guard.mjs']], 'Handler má být exec form: command node a args s cestou přes ${CLAUDE_PLUGIN_ROOT} (funguje bez Git Bash i s mezerami v cestě)', KDE_JSON);
  });
  it('command neobsahuje mezery ani metaznaky shellu (jinak by to byla shell form)', () => {
    plati(typeof handler?.command === 'string' && /^[A-Za-z0-9_.-]+$/.test(handler.command), `command „${handler?.command}“ má být jen název programu bez argumentů.`, KDE_JSON);
  });
  it('args nejsou ve tvaru, který potřebuje shell (bez uvozovek, ;, |, &, >, <, $(...)', () => {
    for (const a of handler?.args ?? []) plati(!/["'`;|&<>]|\$\(/.test(a), `Argument „${a}“ obsahuje znak, který by potřeboval shell.`, KDE_JSON);
  });
  it('bez pole shell', () => {
    plati(handler !== undefined && !('shell' in handler), 'Handler nesmí mít pole shell (hook běží jako přímý proces, bez Git Bash).', KDE_JSON);
  });
  it('bez pole if a async (hook má být synchronní a bez podmínek)', () => {
    plati(handler !== undefined && !('if' in handler) && !('async' in handler), 'Handler nemá mít pole if ani async, jinak se kontrola může minout.', KDE_JSON);
  });
  it('timeout je číslo větší než časový rozpočet kontroly (5 s) a nejvýš minuta', () => {
    plati(typeof handler?.timeout === 'number' && handler.timeout > 5 && handler.timeout <= 60, `timeout ${J(handler?.timeout)} má být číslo v sekundách nad 5 a do 60 (rozpočet kontroly skriptu je 5 s).`, KDE_JSON);
  });
  it('description je neprázdný řetězec bez em dash', () => {
    plati(typeof pluginHooks?.description === 'string' && pluginHooks.description.trim() !== '' && !pluginHooks.description.includes(EM_DASH), 'description v hooks.json má být neprázdný text bez em dash.', KDE_JSON);
  });
  it('soubor hooks.json nemá CRLF ani BOM', () => {
    const txt = readFileSync(HOOKS_JSON, 'utf8');
    plati(!txt.includes('\r') && !txt.startsWith('\ufeff'), 'hooks.json má mít konce řádků LF a žádný BOM.', KDE_JSON);
  });
  it('cesta po dosazení kořene pluginu míří na hook, který test zkouší', () => {
    const wired = wiredArgs()[0] ?? '';
    plati(existsSync(wired), `Po dosazení ${'${CLAUDE_PLUGIN_ROOT}'} neexistuje soubor ${wired}.`, KDE_JSON);
    rovno(realpathSync.native(wired), realpathSync.native(HOOK), 'Cesta z hooks.json má vést na orchestrace-guard.mjs vedle hooks.json', KDE_JSON);
  });
  it('hook začíná shebangem a je ES modul (.mjs)', () => {
    const prvni = readFileSync(HOOK, 'utf8').split('\n')[0];
    rovno([prvni, HOOK.endsWith('.mjs')], ['#!/usr/bin/env node', true], 'Hook má být .mjs se shebangem env node');
  });
  it('hooks.json z kopie pluginu v jiné složce funguje stejně (cesta jen přes kořen pluginu)', () => {
    const kopie = join(root, 'kopie-pluginu');
    mkdirSync(join(kopie, 'hooks'), { recursive: true });
    copyFileSync(HOOK, join(kopie, 'hooks', 'orchestrace-guard.mjs'));
    plati(jeZamitnuti(spawnHook(agent({ prompt: 'x' }), { rootDir: kopie })), 'Zkopírovaný plugin měl hook spustit přes ${CLAUDE_PLUGIN_ROOT}.', KDE_JSON);
  });
});
