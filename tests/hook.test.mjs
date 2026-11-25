// Hook pluginu orchestrace (orchestrace-guard.mjs) z pohledu repa. Rozdělení odpovědnosti:
//   - chování hooku (každá větev rozhodování) testuje plugins/orchestrace/hooks/orchestrace-guard.test.mjs,
//   - tento soubor ověřuje jen to, co plugin sám neohlídá: že se jeho test spouští v čistém prostředí a nesmí klesnout
//     počet případů, spuštění přes odkazy a cesty s diakritikou, základní stdin kontrakt a texty hlášek,
//   - instalaci a spuštění hooku podle hooks.json ověřuje tests/instalace.test.mjs.
// Spuštění: node --test tests/hook.test.mjs. Bez sítě, skutečný ~/.claude se nečte (prázdná konfigurace v tmp).
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOOK, HOOK_REL, LIMIT_PROCESU_MS, ROOT, cesta, cistyEnv, cti, nic, spustHook } from './lib/pomocne.mjs';

const EM_DASH = String.fromCodePoint(0x2014);
const TEST_PLUGINU = 'plugins/orchestrace/hooks/orchestrace-guard.test.mjs';
// Spodní hranice počtu případů ve vlastním testu pluginu: zabrání tichému smazání testů nebo spuštění naprázdno.
// Při záměrném zmenšení testu ji sniž a napiš do commitu proč.
const MIN_PRIPADU = 200;

const agent = (ti, tool = 'Agent') => ({ tool_name: tool, tool_input: ti });

describe('plugin orchestrace: vlastní test pluginu (orchestrace-guard.test.mjs)', () => {
  // Výsledek se čte z kódu a ze souhrnu node:test ("tests N" ve spec reporteru, "# tests N" v TAP na Node 18),
  // takže test nezávisí na tom, jak vlastní test pluginu vypisuje jednotlivé případy.
  const spust = (env) => spawnSync(process.execPath, [cesta(TEST_PLUGINU)], { cwd: ROOT, encoding: 'utf8', env, timeout: LIMIT_PROCESU_MS, maxBuffer: 256 * 1024 * 1024 });
  const INFO = String.fromCodePoint(0x2139); // znak před souhrnem ve spec reporteru (je to piktogram, proto ne doslova)
  const pocet = (text, slovo) => Number((new RegExp(`^(?:${INFO}|#) ${slovo} (\\d+)`, 'm').exec(text) ?? [])[1] ?? NaN);

  it('doběhne v čistém prostředí s kódem 0, bez selhání a s dostatkem případů', () => {
    const r = spust(cistyEnv());
    const konec = `${r.stdout.slice(-600)}${r.stderr.slice(0, 400)}`;
    assert.equal(r.status, 0, `${TEST_PLUGINU} skončil s kódem ${r.status}${r.error ? ` (${r.error.message})` : ''}. Konec výstupu:\n${konec}`);
    assert.equal(pocet(r.stdout, 'fail'), 0, `${TEST_PLUGINU} hlásí selhané případy. Konec výstupu:\n${konec}`);
    const celkem = pocet(r.stdout, 'tests');
    assert.ok(celkem >= MIN_PRIPADU, `${TEST_PLUGINU} provedl ${celkem} případů, čekám aspoň ${MIN_PRIPADU}. Test se zkrátil nebo neběží celý.`);
  });

  it('nezávisí na okolním prostředí: s ORCHESTRACE_GUARD=off a CLAUDE_CODE_SUBAGENT_MODEL v rodiči také projde', () => {
    // obě proměnné ovlivňují hook; výsledek testu nesmí záviset na tom, kdo a z jakého prostředí ho spustil
    const r = spust({ ...process.env, ORCHESTRACE_GUARD: 'off', CLAUDE_CODE_SUBAGENT_MODEL: 'opus' });
    assert.equal(r.status, 0, `${TEST_PLUGINU} závisí na proměnných prostředí rodiče (ORCHESTRACE_GUARD, CLAUDE_CODE_SUBAGENT_MODEL); ve vlastním testu je vynuluj před spuštěním hooku. Konec výstupu:\n${r.stdout.slice(-600)}`);
  });
});

describe('plugin orchestrace: spuštění hooku přes symlink a junction (isMain porovnává reálné cesty)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-sdilene-link-'));
  const hooksDir = dirname(HOOK);
  after(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('přes odkaz na složku hooku (junction na Windows, symlink jinde) hook zamítne Agent bez model', () => {
    const odkaz = join(tmp, 'odkaz-slozka');
    symlinkSync(hooksDir, odkaz, 'junction');
    const r = spustHook(agent({ prompt: 'x' }), {}, join(odkaz, 'orchestrace-guard.mjs'));
    assert.deepEqual([r.status, r.deny], [0, true], `Hook spuštěný přes odkaz na složku nic nezamítl (stdout "${r.stdout.slice(0, 80)}", stderr "${r.stderr.slice(0, 120)}"). Funkce isMain nejspíš nerozpozná spuštění přes symlink; hook pak mlčky nehlídá nic.`);
  });

  it('přes symlink na soubor hooku (kde to systém dovolí) hook zamítne Agent bez model', (t) => {
    const odkaz = join(tmp, 'odkaz-soubor.mjs');
    try { symlinkSync(HOOK, odkaz, 'file'); } catch (e) {
      return t.skip(`Symlink na soubor nejde vytvořit (${e.code}); na Windows bez vývojářského režimu je to obvyklé, složkový odkaz je pokrytý výše.`);
    }
    const r = spustHook(agent({ prompt: 'x' }), {}, odkaz);
    assert.deepEqual([r.status, r.deny], [0, true], `Hook spuštěný přes symlink na soubor nic nezamítl (stdout "${r.stdout.slice(0, 80)}").`);
  });

  it('hook funguje i z cesty s mezerou a diakritikou (kopie v tmp), jak ho spustí Claude Code z cache pluginu', () => {
    const slozka = join(tmp, 'složka s mezerou', 'hooks');
    mkdirSync(slozka, { recursive: true });
    const kopie = join(slozka, 'orchestrace-guard.mjs');
    writeFileSync(kopie, cti(HOOK_REL));
    const r = spustHook(agent({ prompt: 'x' }), {}, kopie);
    assert.deepEqual([r.status, r.deny], [0, true], `Hook z cesty s mezerou a diakritikou nic nezamítl (stdout "${r.stdout.slice(0, 80)}", stderr "${r.stderr.slice(0, 120)}").`);
  });
});

describe('plugin orchestrace: kontrakt hooku přes stdin (kouřové případy, podrobnosti testuje test pluginu)', () => {
  const tabulka = [
    ['Agent bez model se zamítne', agent({ prompt: 'x' }), true],
    ['Agent s model projde', agent({ prompt: 'x', model: 'sonnet' }), false],
    ['Workflow: agent() bez effort se zamítne', { tool_name: 'Workflow', tool_input: { script: "agent('p', { model: 'haiku' })" } }, true],
    ['jiný nástroj (Bash) hook ignoruje', { tool_name: 'Bash', tool_input: { command: 'ls' } }, false],
  ];

  for (const [nazev, vstup, zamitnout] of tabulka) {
    it(nazev, () => {
      const r = spustHook(vstup);
      assert.equal(r.status, 0, `Hook skončil s kódem ${r.status}; má vždy skončit kódem 0 (zamítnutí se hlásí JSON na stdout). ${r.stderr.slice(0, 200)}`);
      assert.equal(r.deny, zamitnout, `${nazev}: čekal jsem ${zamitnout ? 'zamítnutí' : 'povolení bez výstupu'}, stdout je "${r.stdout.slice(0, 120)}"`);
      if (!zamitnout) assert.equal(r.stdout, '', `${nazev}: povolení nesmí nic vypsat, ale stdout je "${r.stdout.slice(0, 120)}"`);
    });
  }

  it('hlásí se jako PreToolUse a odpověď je jeden JSON na jednom řádku', () => {
    const r = spustHook(agent({ prompt: 'x' }));
    assert.equal(r.hookEventName, 'PreToolUse', 'hookEventName v odpovědi musí být PreToolUse.');
    assert.equal(r.stdout.trimEnd().split('\n').length, 1, 'Odpověď hooku má být jeden řádek JSON.');
    assert.equal(r.stderr, '', `Hook nemá nic psát na stderr: ${r.stderr.slice(0, 120)}`);
  });
});

describe('plugin orchestrace: texty zamítnutí', () => {
  const pripady = [['Agent', agent({ prompt: 'x' })], ['Task', agent({ prompt: 'x' }, 'Task')], ['Workflow', { tool_name: 'Workflow', tool_input: { script: "agent('p')" } }]];

  for (const [nazev, vstup] of pripady) {
    it(`${nazev}: hláška říká, co chybí, jak to opravit, kde to je popsané, a neobsahuje em dash`, () => {
      const { reason } = spustHook(vstup);
      assert.ok(reason, `${nazev}: hook nezamítl.`);
      assert.match(reason, /^Orchestrace: /, `${nazev}: hláška má začínat "Orchestrace: " (uživatel hned pozná zdroj).`);
      assert.match(reason, /model/, `${nazev}: hláška nezmiňuje model.`);
      assert.match(reason, /Oprava:|Doplň model|napiš jeho alias/, `${nazev}: hláška neříká, jak chybu opravit.`);
      assert.match(reason, /skill orchestrace/, `${nazev}: hláška neodkazuje na skill orchestrace.`);
      assert.match(reason, /ORCHESTRACE_GUARD|README pluginu/, `${nazev}: hláška neříká, jak kontrolu vypnout (README pluginu).`);
      assert.ok(!reason.includes(EM_DASH), `${nazev}: hláška obsahuje em dash.`);
      assert.ok(reason.length < 2500, `${nazev}: hláška má ${reason.length} znaků, je příliš dlouhá na zobrazení v terminálu.`);
    });
  }

  it('hláška Workflow uvádí číslo řádku vadného agent()', () => {
    const { reason } = spustHook({ tool_name: 'Workflow', tool_input: { script: "const a = 1\nagent('p')" } });
    assert.match(reason, /řádek 2/, `Hláška neuvádí řádek 2: ${reason.slice(0, 200)}`);
  });
});

describe('plugin orchestrace: hook je spustitelný jako skript', () => {
  it('soubor hooku existuje, začíná shebangem node a končí LF', () => {
    const t = cti(HOOK_REL);
    assert.ok(t.startsWith('#!/usr/bin/env node\n'), `${HOOK_REL} má začínat řádkem "#!/usr/bin/env node".`);
    nic('Hook obsahuje CR:', t.includes('\r') ? [HOOK_REL] : []);
  });
});
