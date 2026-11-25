// Pozor: tvrzení o skillu a hooku (sekce, matcher, vypínač) jsou napevno vázaná na plugin orchestrace (PLUGIN níže); obecná pravidla
// pro každý plugin jsou v tests/manifesty.test.mjs a tests/instalace.test.mjs. Druhý plugin přidej vlastním blokem, ne úpravou tohoto.
// Konzistence dokumentace, kódu a manifestů: odkazy na sekce, relativní odkazy a kotvy v .md, tvrzení README o hooku
// (matcher, vypínač, bezpečný výchozí stav, nic nezapisuje, nepoužívá síť), instalační příkazy podle manifestů.
// Spuštění: node --test tests/konzistence.test.mjs. Bez sítě, hook se spouští jen v dočasném čistém prostředí.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, posix as ppath } from 'node:path';
import {
  HOOK_REL, bezBlokuKodu, cesta, cti, ctiJson, existuje, inlineKod, jeBinarni, jeSlozka, kotva, nactiMarketplace, nadpisy,
  nic, odkazyMd, pluginy, soubory, spustHook, ctiBuffer,
} from './lib/pomocne.mjs';

const mp = nactiMarketplace();
const seznam = pluginy();
const vsechny = soubory();
const markdown = vsechny.filter((f) => f.endsWith('.md'));
const PLUGIN = 'plugins/orchestrace';
const SKILL = `${PLUGIN}/skills/orchestrace/SKILL.md`;
const hookZdroj = cti(HOOK_REL);
const README = 'README.md';
const PLUGIN_README = `${PLUGIN}/README.md`;
const hooksJson = ctiJson(`${PLUGIN}/hooks/hooks.json`);
const matcher = hooksJson.hooks.PreToolUse[0].matcher;
const nastroje = matcher.split('|');

const AGENT_BEZ_MODELU = { tool_name: 'Agent', tool_input: { prompt: 'x' } };
const AGENT_S_MODELEM = { tool_name: 'Agent', tool_input: { prompt: 'x', model: 'sonnet' } };
const WORKFLOW_BEZ_EFFORTU = { tool_name: 'Workflow', tool_input: { script: "agent('p', { model: 'haiku' })" } };

// ------------------------------------------------------------------ odkazy na sekce skillu

// "sekce 4" nebo "sekce 4. Model a effort". Název se čte jen tam, kde je odkaz v pevném tvaru (hláška hooku);
// v próze za tečkou začíná další věta.
function odkazyNaSekce(text, snazvem = false) {
  return [...text.matchAll(/sekc[ie][ \t]+(\d+)(?:\.[ \t]+([^.\n"'`)]+))?/g)].map((m) => ({ cislo: Number(m[1]), nazev: snazvem ? m[2]?.trim() : undefined }));
}

function sekceSkillu() {
  const mapa = new Map();
  for (const n of nadpisy(cti(SKILL)).seznam.filter((x) => x.uroven === 2)) {
    const m = /^(\d+)\.\s+(.+)$/.exec(n.text);
    if (m) mapa.set(Number(m[1]), m[2].trim());
  }
  return mapa;
}

function nezname(odkazy, sekce, kde) {
  const chyby = [];
  for (const o of odkazy) {
    if (!sekce.has(o.cislo)) chyby.push(`${kde}: odkaz na sekci ${o.cislo}, ale ${SKILL} takovou sekci nemá (má ${[...sekce.keys()].join(', ')})`);
    else if (o.nazev && o.nazev !== sekce.get(o.cislo)) chyby.push(`${kde}: sekce ${o.cislo} se v odkazu jmenuje "${o.nazev}", v ${SKILL} je "${sekce.get(o.cislo)}"`);
  }
  return chyby;
}

describe('plugin orchestrace: odkazy na sekce skillu', () => {
  it('pomocná detekce pozná odkaz a nadpis (red a green na vzorku)', () => {
    assert.deepEqual(odkazyNaSekce('viz skill x, sekce 4. Model a effort. Dál', true), [{ cislo: 4, nazev: 'Model a effort' }]);
    assert.deepEqual(odkazyNaSekce(['podle sekce 6.', '', '## 1. Role'].join('\n'), true), [{ cislo: 6, nazev: undefined }]);
    assert.deepEqual(odkazyNaSekce('(sekce 4) a sekci 6'), [{ cislo: 4, nazev: undefined }, { cislo: 6, nazev: undefined }]);
    const sekce = new Map([[4, 'Model a effort']]);
    assert.equal(nezname([{ cislo: 9 }], sekce, 'x').length, 1, 'Neexistující sekce se musí označit.');
    assert.equal(nezname([{ cislo: 4, nazev: 'Jiný název' }], sekce, 'x').length, 1, 'Rozdílný název sekce se musí označit.');
    assert.equal(nezname([{ cislo: 4, nazev: 'Model a effort' }], sekce, 'x').length, 0);
  });

  it('SKILL.md má číslované sekce ## N. Název', () => {
    assert.ok(sekceSkillu().size >= 4, `${SKILL} má méně než 4 číslované sekce; hlášky hooku na ně odkazují.`);
  });

  it('hláška v kódu hooku odkazuje na sekci, která ve SKILL.md existuje, se správným názvem', () => {
    const odkazy = odkazyNaSekce(hookZdroj, true);
    assert.ok(odkazy.length >= 1, `${HOOK_REL} už na žádnou sekci skillu neodkazuje; zkontroluj, že hláška radí, kde najít postup (test jinak prošel by naprázdno).`);
    nic('Hláška hooku odkazuje na neexistující sekci:', nezname(odkazy, sekceSkillu(), HOOK_REL));
  });

  it('skutečná hláška zamítnutí (Agent i Workflow) odkazuje na existující sekci a jmenuje skill', () => {
    for (const vstup of [AGENT_BEZ_MODELU, WORKFLOW_BEZ_EFFORTU]) {
      const r = spustHook(vstup);
      assert.ok(r.deny, `Hook nezamítl ${vstup.tool_name} (stdout: ${r.stdout.slice(0, 120)}).`);
      assert.ok(odkazyNaSekce(r.reason, true).length >= 1, `Hláška pro ${vstup.tool_name} neodkazuje na sekci skillu: ${r.reason.slice(0, 160)}`);
      nic(`Hláška pro ${vstup.tool_name} odkazuje na neexistující sekci:`, nezname(odkazyNaSekce(r.reason, true), sekceSkillu(), 'hláška'));
      assert.match(r.reason, /skill orchestrace/, `Hláška pro ${vstup.tool_name} nejmenuje skill orchestrace.`);
    }
  });

  it('odkazy na sekce ve SKILL.md a v README míří na sekce SKILL.md', () => {
    const sekce = sekceSkillu();
    const chyby = [];
    for (const f of [SKILL, README, PLUGIN_README]) chyby.push(...nezname(odkazyNaSekce(cti(f)), sekce, f));
    nic('Odkaz na neexistující sekci:', chyby);
  });

  it('soubory .md zmíněné v hlášce hooku existují v pluginu', () => {
    const zminene = [...new Set(hookZdroj.match(/\b[A-Z][A-Za-z]*\.md\b/g) ?? [])];
    const vPluginu = vsechny.filter((f) => f.startsWith(`${PLUGIN}/`) && f.endsWith('.md')).map((f) => f.split('/').pop());
    nic(`${HOOK_REL} zmiňuje soubory, které v pluginu nejsou:`, zminene.filter((z) => !vPluginu.includes(z)));
  });
});

// ------------------------------------------------------------------ relativní odkazy a kotvy v markdownu

function zkontrolujOdkazy(soubor, text, existuje_ = existuje, cti_ = cti) {
  const chyby = [];
  let overeno = 0;
  for (const { cil, radek } of odkazyMd(text)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(cil)) continue; // http(s), mailto a podobně
    overeno++;
    const [cast, kotvaCil] = cil.split('#');
    let cilovy = soubor;
    if (cast) {
      let dekodovano = cast;
      try { dekodovano = decodeURIComponent(cast); } catch { /* ponechat */ }
      cilovy = ppath.normalize(ppath.join(dirname(soubor), dekodovano)).replace(/\/$/, '');
      if (!existuje_(cilovy)) { chyby.push(`${soubor}:${radek}: odkaz "${cil}" vede na neexistující soubor ${cilovy}`); continue; }
    }
    if (kotvaCil && cilovy.endsWith('.md')) {
      const mozne = nadpisy(cti_(cilovy)).kotvy;
      let k = kotvaCil;
      try { k = decodeURIComponent(kotvaCil); } catch { /* ponechat */ }
      if (!mozne.has(k.toLowerCase())) chyby.push(`${soubor}:${radek}: odkaz "${cil}" vede na kotvu #${kotvaCil}, kterou ${cilovy} nemá (dostupné: ${[...mozne].join(', ')})`);
    }
  }
  return { chyby, overeno };
}

describe('odkazy v markdownu', () => {
  it('pomocné funkce poznají kotvy a mrtvé odkazy (red a green na vzorku)', () => {
    assert.equal(kotva('Vydání nové verze (pro autora)'), 'vydání-nové-verze-pro-autora');
    assert.equal(kotva('1. Role'), '1-role');
    assert.equal(kotva('Co plugin `spouští` na [tvém](x) počítači'), 'co-plugin-spouští-na-tvém-počítači');
    const md = '# A\n\n## B\n\n## B\n\n```\n## Skryto\n```\n';
    assert.deepEqual([...nadpisy(md).kotvy], ['a', 'b', 'b-1']);
    const vzorek = zkontrolujOdkazy('x.md', '[a](#b) [b](#neni) [c](jiny.md) [d](https://example.org/x) `[e](nic.md)`', (f) => f !== 'jiny.md', () => md);
    assert.equal(vzorek.overeno, 3);
    assert.equal(vzorek.chyby.length, 2, `Čekal jsem 2 chyby (kotva #neni a soubor jiny.md), dostal: ${vzorek.chyby.join(' | ')}`);
  });

  it('všechny relativní odkazy vedou na existující soubor a kotvu', () => {
    let celkem = 0;
    const chyby = [];
    for (const f of markdown) {
      const r = zkontrolujOdkazy(f, cti(f));
      celkem += r.overeno;
      chyby.push(...r.chyby);
    }
    assert.ok(celkem >= 3, `Ověřeny jen ${celkem} relativní odkazy, čekám aspoň 3 (README odkazuje na README pluginu, LICENSE a kotvy). Test by prošel naprázdno.`);
    nic('Rozbité odkazy v dokumentaci:', chyby);
  });
});

// ------------------------------------------------------------------ tvrzení README o hooku

describe('plugin orchestrace: README tvrdí o hooku to, co hook dělá', () => {
  it('každý nástroj z matcheru v hooks.json je v obou README', () => {
    assert.ok(nastroje.length >= 2, `Matcher "${matcher}" má méně než 2 nástroje.`);
    for (const f of [README, PLUGIN_README]) {
      nic(`${f} nezmiňuje nástroje z matcheru hooks.json (${matcher}):`, nastroje.filter((n) => !new RegExp(`\\b${n}\\b`).test(cti(f))));
    }
  });

  it('README nezmiňuje nástroj, který matcher nepokrývá', () => {
    const tvrzeni = [...cti(README).matchAll(/nástroje ([A-Z][A-Za-z]+(?:(?:,| a| nebo) [A-Z][A-Za-z]+)*)/g)]
      .flatMap((m) => m[1].split(/,| a | nebo /).map((s) => s.trim()).filter(Boolean));
    assert.ok(tvrzeni.length >= 2, 'README už neříká, na které nástroje hook míří (věta "na nástroje Agent, Task nebo Workflow").');
    nic('README tvrdí, že hook hlídá nástroje, které hooks.json nepokrývá:', [...new Set(tvrzeni)].filter((n) => !nastroje.includes(n)));
  });

  it('proměnné ORCHESTRACE_* v dokumentaci jsou ty, které čte hook', () => {
    const vDokumentaci = new Set(markdown.flatMap((f) => cti(f).match(/\bORCHESTRACE_[A-Z_]+\b/g) ?? []));
    assert.ok(vDokumentaci.size >= 1, 'Dokumentace nezmiňuje žádnou proměnnou ORCHESTRACE_*, vypínač musí být zdokumentovaný.');
    nic('Dokumentace zmiňuje proměnné, které hook nečte:', [...vDokumentaci].filter((v) => !hookZdroj.includes(v)));
    for (const f of [README, PLUGIN_README]) assert.match(cti(f), /ORCHESTRACE_GUARD=off/, `${f} musí uvádět vypínač ORCHESTRACE_GUARD=off.`);
  });

  it('vypínač ORCHESTRACE_GUARD=off funguje bez ohledu na velikost písmen, jiná hodnota kontrolu nevypne', () => {
    for (const hodnota of ['off', 'OFF', 'Off', ' off ']) {
      const r = spustHook(AGENT_BEZ_MODELU, { ORCHESTRACE_GUARD: hodnota });
      assert.deepEqual([r.status, r.stdout], [0, ''], `ORCHESTRACE_GUARD="${hodnota}" měl kontrolu vypnout (README: velikost písmen nehraje roli), ale stdout je "${r.stdout.slice(0, 80)}".`);
    }
    for (const hodnota of ['', 'on', '0', 'false']) {
      const r = spustHook(AGENT_BEZ_MODELU, { ORCHESTRACE_GUARD: hodnota });
      assert.ok(r.deny, `ORCHESTRACE_GUARD="${hodnota}" nesmí kontrolu vypnout; vypíná ji jen hodnota off.`);
    }
  });

  it('při nejasném nebo vadném vstupu hook nic nezamítne a skončí s kódem 0 (README: volání projde)', () => {
    const vstupy = ['', 'není json', '[]', 'null', '{}', '{"tool_name":"Agent"}', '{"tool_name":"Agent","tool_input":[]}', '{"tool_name":"Agent","tool_input":"x"}', '{"tool_name":"Bash","tool_input":{"command":"ls"}}'];
    for (const v of vstupy) {
      const r = spustHook(v);
      assert.deepEqual([r.status, r.stdout], [0, ''], `Vstup ${JSON.stringify(v)}: hook měl volání pustit (kód 0, prázdný výstup), ale vrátil kód ${r.status} a stdout "${r.stdout.slice(0, 80)}" ${r.stderr.slice(0, 120)}`);
    }
  });

  it('README: zamítne Agent bez model a Workflow bez effortu, povolí Agent s model', () => {
    assert.ok(spustHook(AGENT_BEZ_MODELU).deny, 'Agent bez model musí být zamítnut.');
    assert.ok(spustHook({ ...AGENT_BEZ_MODELU, tool_name: 'Task' }).deny, 'Task bez model musí být zamítnut.');
    assert.ok(spustHook(WORKFLOW_BEZ_EFFORTU).deny, 'Workflow, jehož agent() nemá effort, musí být zamítnut.');
    const povolen = spustHook(AGENT_S_MODELEM);
    assert.deepEqual([povolen.status, povolen.stdout], [0, ''], 'Agent s model musí projít bez výstupu.');
  });

  it('README: výjimky fork a agent z pluginu projdou i bez model', () => {
    for (const typ of ['fork', 'nejaky-plugin:agent']) {
      const r = spustHook({ tool_name: 'Agent', tool_input: { prompt: 'x', subagent_type: typ } });
      assert.deepEqual([r.status, r.stdout], [0, ''], `Agent typu "${typ}" měl projít (README uvádí výjimku), ale stdout je "${r.stdout.slice(0, 80)}".`);
    }
  });

  it('README: hook nic nezapisuje a nepoužívá síť (kontrola importů a volání ve zdroji hooku)', () => {
    const importy = [...hookZdroj.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.ok(importy.length >= 2, `Z ${HOOK_REL} se nepodařilo přečíst importy.`);
    nic('Hook smí importovat jen vestavěné moduly node: (je to jeden soubor bez závislostí):', importy.filter((i) => !i.startsWith('node:')));
    const sitAProcesy = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'child_process', 'worker_threads', 'cluster'];
    nic('Hook importuje modul pro síť nebo spouštění procesů (README tvrdí, že síť nepoužívá):', importy.filter((i) => sitAProcesy.includes(i.replace(/^node:/, ''))));
    const bezKomentaru = hookZdroj.replace(/^\s*\/\/.*$/gm, '');
    const zapis = bezKomentaru.match(/\b(writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|mkdir|rmSync|rm|unlinkSync|unlink|renameSync|rename|copyFileSync|copyFile|createWriteStream|truncateSync|symlinkSync|chmodSync)\s*\(/g) ?? [];
    nic('Hook obsahuje volání, která zapisují na disk (README tvrdí, že nic nezapisuje):', [...new Set(zapis)]);
    assert.ok(!/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/.test(bezKomentaru), 'Hook volá fetch, XMLHttpRequest nebo WebSocket (README tvrdí, že síť nepoužívá).');
  });

  it('README: hook je jeden soubor bez závislostí na jiných souborech repa', () => {
    assert.ok(!/^import\s[^;]*?from\s+['"]\.{1,2}\//m.test(hookZdroj), `${HOOK_REL} importuje relativní soubor; po instalaci do cache musí být hook samostatný (nebo ho aspoň ověř v tests/instalace.test.mjs).`);
  });
});

// ------------------------------------------------------------------ instalační příkazy

describe('příkazy v README odpovídají manifestům', () => {
  const texty = markdown.map((f) => ({ f, t: cti(f) }));
  const hledej = (re) => texty.flatMap(({ f, t }) => t.split('\n').flatMap((r, i) => [...r.matchAll(re)].map((m) => ({ f, radek: i + 1, m }))));
  const pj = ctiJson(`${PLUGIN}/.claude-plugin/plugin.json`);
  const repoCesta = new URL(pj.repository).pathname.replace(/^\/|\.git$|\/$/g, '');

  it('claude plugin install/update/uninstall/enable/disable používají jméno pluginu a marketplace z manifestů', () => {
    const nalezy = hledej(/claude plugin (install|uninstall|update|enable|disable) ([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)/g);
    assert.ok(nalezy.length >= 4, `Našel jsem jen ${nalezy.length} příkazů "claude plugin <akce> plugin@marketplace", čekám aspoň 4.`);
    nic('Příkaz používá jméno, které není v manifestech:', nalezy
      .filter(({ m }) => !seznam.some((p) => p.name === m[2]) || m[3] !== mp.name)
      .map(({ f, radek, m }) => `${f}:${radek}: ${m[0]} (plugin má být jeden z ${seznam.map((p) => p.name).join(', ')}, marketplace ${mp.name})`));
  });

  it('claude plugin marketplace update/remove používají jméno marketplace z marketplace.json', () => {
    const nalezy = hledej(/claude plugin marketplace (update|remove) ([A-Za-z0-9._-]+)/g);
    assert.ok(nalezy.length >= 2, `Našel jsem jen ${nalezy.length} příkazů marketplace update/remove, čekám aspoň 2.`);
    nic('Příkaz používá cizí jméno marketplace:', nalezy.filter(({ m }) => m[2] !== mp.name).map(({ f, radek, m }) => `${f}:${radek}: ${m[0]} (marketplace se jmenuje ${mp.name})`));
  });

  it('claude plugin marketplace add odkazuje na repo z plugin.json (owner/repo)', () => {
    const nalezy = hledej(/claude plugin marketplace add ([^\s`'"]+)/g);
    assert.ok(nalezy.length >= 2, `Našel jsem jen ${nalezy.length} příkazů marketplace add, čekám aspoň 2.`);
    nic(`Příkaz marketplace add nesměřuje na repo z plugin.json (${repoCesta}):`, nalezy.filter(({ m }) => m[1] !== repoCesta).map(({ f, radek, m }) => `${f}:${radek}: ${m[0]}`));
  });

  it('plugin.json repository a homepage míří na stejné repo', () => {
    assert.equal(new URL(pj.homepage).pathname.replace(/\/$/, ''), new URL(pj.repository).pathname.replace(/\.git$|\/$/g, ''), 'plugin.json: homepage a repository míří na jiné repo.');
  });

  it('claude plugin tag míří na existující složku pluginu', () => {
    const nalezy = hledej(/claude plugin tag ([^\s`'"]+)/g);
    nic('claude plugin tag míří na neexistující složku:', nalezy.filter(({ m }) => !jeSlozka(m[1].replace(/\/$/, ''))).map(({ f, radek, m }) => `${f}:${radek}: ${m[0]}`));
  });

  it('README v kořeni uvádí instalaci každého pluginu a odkaz na jeho README', () => {
    const t = cti(README);
    for (const p of seznam) {
      assert.ok(t.includes(`claude plugin install ${p.name}@${mp.name}`), `${README} neuvádí příkaz "claude plugin install ${p.name}@${mp.name}".`);
      assert.ok(t.includes(`](${p.slozka}/README.md)`), `${README} neodkazuje na ${p.slozka}/README.md (tabulka Pluginy).`);
      assert.ok(existuje(`${p.slozka}/README.md`), `Chybí ${p.slozka}/README.md.`);
      assert.ok(cti(`${p.slozka}/README.md`).includes(`claude plugin install ${p.name}@${mp.name}`), `${p.slozka}/README.md neuvádí vlastní instalační příkaz.`);
    }
  });

  it('README pluginu jmenuje každý jeho skill', () => {
    const t = cti(PLUGIN_README);
    const skilly = readdirSync(cesta(`${PLUGIN}/skills`), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    assert.ok(skilly.length >= 1, 'Plugin nemá žádný skill.');
    nic(`${PLUGIN_README} nejmenuje tyto skilly:`, skilly.filter((s) => !t.includes(`\`${s}\``)));
  });

  it('příkazy "node <soubor>.mjs" v README pluginu míří na existující soubor (od kořene pluginu)', () => {
    const kody = inlineKod(cti(PLUGIN_README)).map((k) => /^node (\S+\.mjs)$/.exec(k.text)).filter(Boolean);
    nic(`${PLUGIN_README} uvádí neexistující skript:`, kody.filter((m) => !existuje(`${PLUGIN}/${m[1]}`)).map((m) => m[0]));
  });

  it('textové soubory skillu nejsou binární a nejsou prázdné', () => {
    for (const f of vsechny.filter((x) => x.startsWith(`${PLUGIN}/skills/`))) {
      const buf = ctiBuffer(f);
      assert.ok(buf.length > 0 && !jeBinarni(buf), `${f} je prázdný nebo binární.`);
    }
  });

  it('bloky kódu v README nejsou nikdy neuzavřené', () => {
    nic('Neuzavřený blok kódu (lichý počet ohraničení ```):', markdown.filter((f) => (cti(f).match(/^\s{0,3}```/gm) ?? []).length % 2 === 1));
    assert.equal(bezBlokuKodu('a\n```\nskryto\n```\nb').split('\n').filter(Boolean).join(','), 'a,b');
  });
});
