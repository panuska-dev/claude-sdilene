// E2E instalace v čistém profilu Claude Code: claude plugin validate, marketplace add, install, kontrola
// nainstalovaných souborů, spuštění nainstalovaného hooku podle hooks.json, spuštění hooku skutečným Claude Code
// (claude -p proti falešnému API, tests/lib/falesne-api.mjs), disable/enable, update, uninstall.
// Spuštění: node --test tests/instalace.test.mjs (nebo npm test; mimo npm run test:rychle).
//
// Izolace: CLAUDE_CONFIG_DIR, HOME, USERPROFILE, APPDATA, LOCALAPPDATA a XDG_* míří do dočasné složky, z prostředí se
// odstraní všechny proměnné CLAUDE*, ANTHROPIC* a ORCHESTRACE* (například CLAUDE_CODE_PLUGIN_DIRS z okolní session by
// jinak do profilu přimíchalo cizí pluginy). Skutečný ~/.claude se nečte ani nezapisuje. Bez sítě, bez přihlášení:
// marketplace se přidává z lokální složky (kopie souborů repa v tmp, cesta s mezerou a diakritikou).
//
// Chybí-li claude CLI: lokálně se testy přeskočí s hláškou, při CI=true selžou (v CI se nesmí nic tiše přeskočit).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LIMIT_PROCESU_MS, cistyEnv, ctiJson, najdiClaude, nic, pluginy, posix, soubory, spustClaude, cesta } from './lib/pomocne.mjs';
import { spustFalesneApi, spustProces, textVysledku } from './lib/falesne-api.mjs';

const jeCI = String(process.env.CI ?? '').toLowerCase() === 'true';
const claude = najdiClaude();
const mp = ctiJson('.claude-plugin/marketplace.json');
// Všechny pluginy z marketplace.json: nový plugin se tu ověří bez úpravy testu (validate, install, soubory, details, start hooku).
const PLUGINY = pluginy().map((p) => ({ ...p, id: `${p.name}@${mp.name}`, manifest: ctiJson(`${p.slozka}/.claude-plugin/plugin.json`) }));
const ORCHESTRACE = PLUGINY.find((p) => p.name === 'orchestrace');
const IDS = PLUGINY.map((p) => p.id);

const ZPRAVA_CHYBI = 'Claude Code CLI (příkaz "claude") není v PATH. Nainstaluj ho podle https://code.claude.com/docs/en/setup a spusť test znovu; E2E instalace bez něj neběží.';

const stav = { tmp: null, kopie: null, env: null, proj: null, instalace: {} };

// vrací true, když lze pokračovat; bez claude lokálně přeskočí, v CI selže
function pripraveno(t) {
  if (claude && stav.env) return true;
  if (!claude) {
    assert.ok(!jeCI, `CI=true, ale ${ZPRAVA_CHYBI} V CI se tento test nesmí přeskočit; doplň instalaci Claude Code do workflow.`);
    t.skip(ZPRAVA_CHYBI);
    return false;
  }
  assert.fail('Příprava izolovaného profilu selhala (viz předchozí test).');
  return false;
}

function cl(...args) {
  const r = spustClaude(claude, args, { env: stav.env, cwd: stav.proj });
  return { ...r, vystup: `${r.stdout ?? ''}${r.stderr ?? ''}`, popis: `claude ${args.join(' ')}` };
}

function uspech(r) {
  assert.equal(r.status, 0, `${r.popis} skončil s kódem ${r.status}${r.error ? ` (${r.error.message})` : ''}.\n${r.vystup.slice(0, 1500)}`);
  return r;
}

function ctiSeznam() {
  const r = uspech(cl('plugin', 'list', '--json'));
  try { return JSON.parse(r.stdout); } catch { return assert.fail(`${r.popis} nevrátil platný JSON:\n${r.stdout.slice(0, 600)}`); }
}

const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

function souboryVeSlozce(dir, zaklad = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const plna = join(dir, e.name);
    if (e.isDirectory()) souboryVeSlozce(plna, zaklad, out);
    else out.push(posix(relative(zaklad, plna)));
  }
  return out.sort();
}

const pod = (cestaA, cestaB) => {
  const a = realpathSync.native(cestaA);
  const b = realpathSync.native(cestaB);
  return a === b || a.startsWith(b + sep);
};

describe('E2E instalace v čistém profilu', () => {
  before(() => {
    if (!claude) return;
    const tmp = mkdtempSync(join(tmpdir(), 'claude-sdilene-e2e-'));
    const home = join(tmp, 'home');
    const cfg = join(tmp, 'cfg');
    const kopie = join(tmp, 'zdroj s mezerou a diakritikou', 'claude-sdilene');
    const proj = join(tmp, 'projekt');
    for (const d of [home, cfg, proj, join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local'), join(home, '.config'), join(home, '.local', 'share'), join(home, '.cache')]) mkdirSync(d, { recursive: true });
    // kopie souborů repa (sledovaných i nových mimo .gitignore): zkouší se to, co se bude commitovat
    for (const f of soubory()) {
      const cil = join(kopie, ...f.split('/'));
      mkdirSync(dirname(cil), { recursive: true });
      copyFileSync(cesta(f), cil);
    }
    stav.tmp = tmp;
    stav.kopie = kopie;
    stav.proj = proj;
    stav.env = cistyEnv({
      CLAUDE_CONFIG_DIR: cfg, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CACHE_HOME: join(home, '.cache'),
      DISABLE_AUTOUPDATER: '1',
    });
  });

  after(() => {
    if (stav.tmp) rmSync(stav.tmp, { recursive: true, force: true });
  });

  it('claude CLI je dostupné a profil je izolovaný od okolní session', (t) => {
    if (!pripraveno(t)) return;
    const v = uspech(cl('--version'));
    assert.match(v.stdout, /\d+\.\d+\.\d+/, `claude --version nevrátil číslo verze: ${v.stdout.slice(0, 120)}`);
    assert.ok(pod(stav.env.CLAUDE_CONFIG_DIR, stav.tmp), 'Konfigurace profilu není v dočasné složce.');
    nic('V prostředí podprocesu zůstaly proměnné, které by přenesly cizí konfiguraci:', Object.keys(stav.env).filter((k) => /^(ANTHROPIC|ORCHESTRACE|NODE_TEST)/i.test(k) || (/^CLAUDE/i.test(k) && k !== 'CLAUDE_CONFIG_DIR')));
    assert.deepEqual(ctiSeznam(), [], 'Čistý profil nemá mít žádný plugin (cizí plugin by znamenal únik konfigurace z okolí).');
  });

  it('claude plugin validate --strict projde pro marketplace i pro plugin', (t) => {
    if (!pripraveno(t)) return;
    const a = uspech(cl('plugin', 'validate', stav.kopie, '--strict'));
    assert.match(a.vystup, /Validation passed/, `validate marketplace: chybí "Validation passed":\n${a.vystup.slice(0, 800)}`);
    for (const p of PLUGINY) {
      const b = uspech(cl('plugin', 'validate', join(stav.kopie, ...p.slozka.split('/')), '--strict'));
      assert.match(b.vystup, /Validation passed/, `validate plugin ${p.name}: chybí "Validation passed":\n${b.vystup.slice(0, 800)}`);
    }
  });

  it('claude plugin marketplace add <složka> zaregistruje marketplace se jménem z marketplace.json', (t) => {
    if (!pripraveno(t)) return;
    uspech(cl('plugin', 'marketplace', 'add', stav.kopie));
    const r = uspech(cl('plugin', 'marketplace', 'list', '--json'));
    const seznam = JSON.parse(r.stdout);
    assert.deepEqual(seznam.map((m) => m.name), [mp.name], `Po přidání má být registrovaný jen marketplace ${mp.name}, je: ${r.stdout.slice(0, 400)}`);
  });

  it('claude plugin install nainstaluje každý plugin ve správné verzi a povolený', (t) => {
    if (!pripraveno(t)) return;
    for (const p of PLUGINY) uspech(cl('plugin', 'install', p.id));
    const seznam = ctiSeznam();
    assert.deepEqual(seznam.map((x) => x.id).sort(), [...IDS].sort(), `Po instalaci mají být nainstalované právě pluginy z marketplace.json, je: ${JSON.stringify(seznam.map((x) => x.id))}`);
    for (const p of PLUGINY) {
      const x = seznam.find((s) => s.id === p.id);
      assert.equal(x.enabled, true, `Plugin ${p.id} po instalaci není povolený.`);
      assert.equal(x.scope, 'user', 'Instalace z příkazové řádky má být v rozsahu user (README).');
      assert.equal(x.version, p.manifest.version, `Nainstalovaná verze ${x.version} pluginu ${p.name} se liší od version v plugin.json (${p.manifest.version}).`);
      assert.ok(existsSync(x.installPath), `Cesta instalace ${x.installPath} neexistuje.`);
      assert.ok(pod(x.installPath, stav.tmp), `Plugin ${p.name} se nainstaloval mimo dočasný profil (${x.installPath}); test by sahal na skutečný profil.`);
      stav.instalace[p.name] = x.installPath;
    }
  });

  it('nainstalované soubory každého pluginu jsou stejné jako soubory v repu (obsah i seznam)', (t) => {
    if (!pripraveno(t)) return;
    for (const p of PLUGINY) {
      const kam = stav.instalace[p.name];
      assert.ok(kam, `Instalace pluginu ${p.name} v předchozím testu neproběhla.`);
      const zdroj = join(stav.kopie, ...p.slozka.split('/'));
      const ocekavane = souboryVeSlozce(zdroj);
      const nainstalovane = souboryVeSlozce(kam);
      // plugin musí mít aspoň manifest a README, jinak by se kopírovalo naprázdno
      for (const povinny of ['.claude-plugin/plugin.json', 'README.md']) assert.ok(ocekavane.includes(povinny), `Plugin ${p.name} v repu nemá ${povinny}.`);
      nic(`${p.name}: v repu jsou, ale nenainstalovaly se:`, ocekavane.filter((f) => !nainstalovane.includes(f)));
      nic(`${p.name}: nainstalovalo se něco, co v repu není:`, nainstalovane.filter((f) => !ocekavane.includes(f)));
      nic(`${p.name}: obsah se po instalaci liší od repa:`, ocekavane.filter((f) => nainstalovane.includes(f) && hash(join(zdroj, f)) !== hash(join(kam, f))));
      // totéž proti skutečnému pracovnímu stromu, ne jen proti kopii
      const repo = cesta(p.slozka);
      nic(`${p.name}: obsah nainstalované kopie se liší od pracovního stromu repa:`, ocekavane.filter((f) => hash(join(repo, f)) !== hash(join(kam, f))));
    }
  });

  it('claude plugin details vidí skilly a hooky každého pluginu (počty se berou z obsahu pluginu)', (t) => {
    if (!pripraveno(t)) return;
    for (const p of PLUGINY) {
      const kam = stav.instalace[p.name];
      const r = uspech(cl('plugin', 'details', p.name));
      const skilly = existsSync(join(kam, 'skills')) ? readdirSync(join(kam, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
      assert.match(r.vystup, new RegExp(`Skills \\(${skilly.length}\\)`), `${p.name}: Claude Code hlásí jiný počet skillů než ${skilly.length} (${skilly.join(', ')}); chybný frontmatter SKILL.md?\n${r.vystup.slice(0, 900)}`);
      for (const s of skilly) assert.ok(r.vystup.includes(s), `${p.name}: Claude Code nenačetl skill ${s} (chybný frontmatter SKILL.md?):\n${r.vystup.slice(0, 900)}`);
      const hooksJson = join(kam, 'hooks', 'hooks.json');
      const udalosti = existsSync(hooksJson) ? Object.keys(JSON.parse(readFileSync(hooksJson, 'utf8')).hooks) : [];
      // "Hooks (N)" je počet událostí, za ním jsou jejich názvy
      assert.match(r.vystup, new RegExp(`Hooks \\(${udalosti.length}\\)`), `${p.name}: Claude Code hlásí jiný počet událostí hooků než ${udalosti.length} (${udalosti.join(', ')}); chybný hooks.json?\n${r.vystup.slice(0, 900)}`);
      for (const u of udalosti) assert.ok(r.vystup.includes(u), `${p.name}: Claude Code nenačetl hook ${u} (chybný hooks.json?):\n${r.vystup.slice(0, 900)}`);
    }
  });

  it('hooky každého pluginu se spustí podle hooks.json (bez shellu) a při nepodstatném vstupu skončí kódem 0', (t) => {
    if (!pripraveno(t)) return;
    for (const p of PLUGINY) {
      const kam = stav.instalace[p.name];
      const hooksJson = join(kam, 'hooks', 'hooks.json');
      if (!existsSync(hooksJson)) continue;
      const hj = JSON.parse(readFileSync(hooksJson, 'utf8'));
      let pocet = 0;
      for (const [udalost, skupiny] of Object.entries(hj.hooks)) {
        for (const h of skupiny.flatMap((s) => s.hooks ?? [])) {
          pocet++;
          const r = spustHookZHooksJson(kam, h, { tool_name: 'NeexistujiciNastroj', tool_input: {} });
          assert.equal(r.error, undefined, `${p.name} ${udalost}: hook se nepodařilo spustit (${r.error?.message}); chybí soubor nebo program?`);
          assert.equal(r.status, 0, `${p.name} ${udalost}: hook skončil s kódem ${r.status}, stderr "${(r.stderr ?? '').slice(0, 200)}".`);
        }
      }
      assert.ok(pocet >= 1, `${p.name}: hooks.json nemá žádný handler.`);
    }
  });

  // hook spuštěný stejně jako Claude Code: bez shellu, ${CLAUDE_PLUGIN_ROOT} dosazené do command a args
  function spustHookZHooksJson(koren, h, vstup, extra = {}) {
    const nahrad = (s) => s.split('${CLAUDE_PLUGIN_ROOT}').join(koren);
    // "node" se nahradí právě běžícím Node.js: matice v CI zkouší konkrétní verze a hook musí běžet na nich
    const prikaz = h.command === 'node' ? process.execPath : nahrad(h.command);
    return spawnSync(prikaz, (h.args ?? []).map(nahrad), {
      input: JSON.stringify(vstup), encoding: 'utf8', cwd: stav.proj, timeout: LIMIT_PROCESU_MS, maxBuffer: 64 * 1024 * 1024,
      env: { ...stav.env, CLAUDE_PLUGIN_ROOT: koren, CLAUDE_PROJECT_DIR: stav.proj, ...extra },
    });
  }

  describe('plugin orchestrace: nainstalovaný hook zamítá podle pravidel README', { skip: ORCHESTRACE ? false : 'plugin orchestrace není v marketplace' }, () => {
    const spustNainstalovany = (vstup, extra = {}) => {
      const kam = stav.instalace.orchestrace;
      const hj = JSON.parse(readFileSync(join(kam, 'hooks', 'hooks.json'), 'utf8'));
      const r = spustHookZHooksJson(kam, hj.hooks.PreToolUse[0].hooks[0], vstup, extra);
      let json = null;
      try { json = JSON.parse(r.stdout); } catch { /* prázdný výstup je v pořádku */ }
      return { status: r.status, error: r.error, stdout: r.stdout, stderr: r.stderr, deny: json?.hookSpecificOutput?.permissionDecision === 'deny', reason: json?.hookSpecificOutput?.permissionDecisionReason ?? '' };
    };

    it('zamítne Agent bez model', (t) => {
      if (!pripraveno(t)) return;
      const r = spustNainstalovany({ tool_name: 'Agent', tool_input: { prompt: 'x' } });
      assert.deepEqual([r.status, r.deny], [0, true], `Nainstalovaný hook nezamítl Agent bez model (kód ${r.status}, stdout "${r.stdout.slice(0, 120)}", stderr "${r.stderr.slice(0, 200)}", chyba ${r.error?.message}).`);
      assert.match(r.reason, /Orchestrace/, 'Hláška nainstalovaného hooku nezačíná "Orchestrace".');
    });

    it('povolí Agent s model (bez výstupu)', (t) => {
      if (!pripraveno(t)) return;
      const r = spustNainstalovany({ tool_name: 'Agent', tool_input: { prompt: 'x', model: 'sonnet' } });
      assert.deepEqual([r.status, r.stdout], [0, ''], `Nainstalovaný hook měl Agent s model pustit, ale stdout je "${r.stdout.slice(0, 120)}", stderr "${r.stderr.slice(0, 200)}".`);
    });

    it('zamítne Workflow, jehož agent() nemá effort', (t) => {
      if (!pripraveno(t)) return;
      const r = spustNainstalovany({ tool_name: 'Workflow', tool_input: { script: "agent('p', { model: 'haiku' })" } });
      assert.ok(r.deny, `Nainstalovaný hook nezamítl Workflow bez effortu (stdout "${r.stdout.slice(0, 120)}").`);
    });

    it('s ORCHESTRACE_GUARD=off nic nezamítne', (t) => {
      if (!pripraveno(t)) return;
      const r = spustNainstalovany({ tool_name: 'Agent', tool_input: { prompt: 'x' } }, { ORCHESTRACE_GUARD: 'off' });
      assert.deepEqual([r.status, r.stdout], [0, ''], 'Vypínač ORCHESTRACE_GUARD=off v nainstalovaném hooku nefunguje.');
    });
  });

  // Skutečný `claude -p` proti falešnému API na loopbacku: model zavolá nástroj Agent a test se podívá, co Claude Code
  // vrátil modelu jako výsledek nástroje. Tohle je jediný test, který ověří, že Claude Code hook z nainstalovaného pluginu
  // opravdu spustí (tvar "command" a "args", dosazení ${CLAUDE_PLUGIN_ROOT}, matcher). Ostatní testy čtou hooks.json samy.
  // Bez přihlášení, bez sítě a bez skutečného modelu; profil uživatele se nečte (profil je v tmp).
  describe('plugin orchestrace: Claude Code spustí nainstalovaný hook (claude -p proti falešnému API)', { skip: ORCHESTRACE ? false : 'plugin orchestrace není v marketplace' }, () => {
    const ZNACKA = 'ZAVOLEJ-AGENTA-PRO-TEST';
    const spustSAgentem = async (vstupNastroje, extraEnv = {}) => {
      const api = await spustFalesneApi({ znacka: ZNACKA, vstupNastroje });
      try {
        const env = {
          ...stav.env, ANTHROPIC_API_KEY: 'sk-ant-api03-testovaci-neplatny-klic', ANTHROPIC_BASE_URL: api.url,
          NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...extraEnv,
        };
        const r = await spustProces(claude, ['-p', `${ZNACKA}: zavolej nástroj Agent`, '--allowedTools', 'Agent', '--no-session-persistence'], { env, cwd: stav.proj, limitMs: LIMIT_PROCESU_MS });
        const vysledky = api.vysledkyNastroje();
        const konec = `stdout: ${r.stdout.slice(-500)}\nstderr: ${r.stderr.slice(-500)}\npožadavků na API: ${api.pozadavky.length}${r.error ? `, chyba: ${r.error.message}` : ''}${r.vyprselo ? ', proces vypršel' : ''}`;
        return { r, vysledky, modely: api.modely(), konec };
      } finally {
        await api.zavri();
      }
    };

    it('Agent bez model: Claude Code spustí hook a modelu vrátí hlášku zamítnutí "Orchestrace: ..." jako výsledek nástroje', async (t) => {
      if (!pripraveno(t)) return;
      const { vysledky, konec } = await spustSAgentem({ description: 'x', prompt: 'x', subagent_type: 'general-purpose' });
      assert.equal(vysledky.length, 1, `Čekal jsem právě jeden výsledek nástroje Agent, je jich ${vysledky.length}. Model se k nástroji nedostal, nebo falešné API nesedí na novou verzi Claude Code.\n${konec}`);
      const hlaska = textVysledku(vysledky[0]);
      assert.match(hlaska, /Orchestrace: /, `Výsledek nástroje neobsahuje "Orchestrace: ", hook se nejspíš nespustil (Claude Code změnil tvar "args" a "command" nebo matcher?). Výsledek: "${hlaska.slice(0, 300)}"\n${konec}`);
      assert.equal(vysledky[0].is_error, true, 'Zamítnutí hookem má dorazit jako chybový výsledek nástroje (is_error).');
    });

    it('Agent s model: hook ho pustí, podagent běží s požadovaným modelem a žádná hláška zamítnutí nevznikne', async (t) => {
      if (!pripraveno(t)) return;
      const { vysledky, modely, konec } = await spustSAgentem({ description: 'x', prompt: 'x', subagent_type: 'general-purpose', model: 'haiku' });
      assert.equal(vysledky.length, 1, `Čekal jsem právě jeden výsledek nástroje Agent.\n${konec}`);
      assert.ok(!textVysledku(vysledky[0]).includes('Orchestrace:'), `Hook zamítl Agent s model: "${textVysledku(vysledky[0]).slice(0, 300)}"\n${konec}`);
      assert.ok(modely.some((m) => /haiku/i.test(m)), `Podagent měl běžet s modelem haiku, API vidělo modely: ${modely.join(', ')}.\n${konec}`);
    });

    it('s ORCHESTRACE_GUARD=off Agent bez model projde (kontrola, že zamítnutí výše dělá hook, ne Claude Code sám)', async (t) => {
      if (!pripraveno(t)) return;
      const { vysledky, konec } = await spustSAgentem({ description: 'x', prompt: 'x', subagent_type: 'general-purpose' }, { ORCHESTRACE_GUARD: 'off' });
      assert.equal(vysledky.length, 1, `Čekal jsem právě jeden výsledek nástroje Agent.\n${konec}`);
      assert.ok(!textVysledku(vysledky[0]).includes('Orchestrace:'), `Vypínač ORCHESTRACE_GUARD=off nezabral: "${textVysledku(vysledky[0]).slice(0, 300)}"\n${konec}`);
    });
  });

  it('claude plugin disable a enable přepnou stav pluginu (příkazy z README)', (t) => {
    if (!pripraveno(t)) return;
    for (const id of IDS) {
      uspech(cl('plugin', 'disable', id));
      assert.equal(ctiSeznam().find((p) => p.id === id)?.enabled, false, `Po "disable ${id}" je plugin pořád povolený.`);
      uspech(cl('plugin', 'enable', id));
      assert.equal(ctiSeznam().find((p) => p.id === id)?.enabled, true, `Po "enable ${id}" plugin není povolený.`);
    }
  });

  it('claude plugin marketplace update a plugin update proběhnou a verze zůstane aktuální (příkazy z README)', (t) => {
    if (!pripraveno(t)) return;
    uspech(cl('plugin', 'marketplace', 'update', mp.name));
    for (const p of PLUGINY) {
      uspech(cl('plugin', 'update', p.id));
      assert.equal(ctiSeznam().find((x) => x.id === p.id)?.version, p.manifest.version, `Po update se verze pluginu ${p.id} změnila.`);
    }
  });

  it('claude plugin uninstall a marketplace remove vše uklidí (příkazy z README)', (t) => {
    if (!pripraveno(t)) return;
    for (const id of IDS) uspech(cl('plugin', 'uninstall', id));
    assert.deepEqual(ctiSeznam(), [], 'Po uninstall zůstal v profilu plugin.');
    uspech(cl('plugin', 'marketplace', 'remove', mp.name));
    const r = uspech(cl('plugin', 'marketplace', 'list', '--json'));
    assert.deepEqual(JSON.parse(r.stdout), [], 'Po marketplace remove zůstal marketplace v profilu.');
  });

  it('marketplace add odmítne složku bez marketplace.json (E2E zachytí rozbité cesty; red)', (t) => {
    if (!pripraveno(t)) return;
    const prazdna = join(stav.tmp, 'prazdna');
    mkdirSync(prazdna, { recursive: true });
    const r = cl('plugin', 'marketplace', 'add', prazdna);
    assert.notEqual(r.status, 0, 'Přidání složky bez .claude-plugin/marketplace.json mělo selhat; test instalace by jinak neodhalil rozbitou cestu.');
    assert.deepEqual(JSON.parse(uspech(cl('plugin', 'marketplace', 'list', '--json')).stdout), [], 'Selhané přidání zanechalo marketplace v profilu.');
  });

  it('skutečný pracovní strom repa se při testu nezměnil (nové soubory .claude apod. nevznikly)', (t) => {
    if (!pripraveno(t)) return;
    assert.ok(!existsSync(cesta('.claude')), 'V kořeni repa vznikla složka .claude; E2E test zapisoval mimo dočasnou složku.');
    assert.ok(statSync(cesta('.claude-plugin')).isDirectory());
  });
});
