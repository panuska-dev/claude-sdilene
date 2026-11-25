// Lint obsahu všech souborů repa (sledovaných i nových mimo .gitignore): em dash, BOM, konce řádků, emoji,
// zástupné komentáře, zakázané osobní řetězce, použití handle autora jen v povolených souborech.
// Spuštění: node --test tests/obsah.test.mjs (nebo npm test). Bez sítě, nic nezapisuje.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { cesta, cti, ctiBuffer, existuje, jeBinarni, najdiZakazane, nic, parsujZakazane, soubory } from './lib/pomocne.mjs';

// znaky se skládají z kódových bodů, aby je tento soubor sám neobsahoval doslova
const EM_DASH = String.fromCodePoint(0x2014);
const BOM = String.fromCodePoint(0xFEFF);
// (c), (r) a (tm) nejsou emoji, ostatní piktogramy (včetně zatržítek a šipek ve formě emoji) ano
const EMOJI = new RegExp(String.raw`(?![${String.fromCodePoint(0xA9, 0xAE, 0x2122)}])\p{Extended_Pictographic}|${String.fromCodePoint(0xFE0F)}`, 'u');

const ZAKAZANE_SOUBORY = ['tests/zakazane.txt', 'tests/zakazane.local.txt'];

// Handle autora smí být jen v instalačních příkazech, URL repa, owner a author v manifestech a v LICENSE.
// handle se skládá za běhu, aby ho tento soubor sám neobsahoval
const HANDLE = ['Libera', 'Fatum'].join('');
const HANDLE_POVOLENE = [
  'README.md',
  'plugins/orchestrace/README.md',
  'LICENSE',
  '.claude-plugin/marketplace.json',
  'plugins/orchestrace/.claude-plugin/plugin.json',
];

const vsechny = soubory();
const textove = vsechny.filter((f) => !jeBinarni(ctiBuffer(f)));
const markdown = textove.filter((f) => f.endsWith('.md'));

const zakazane = parsujZakazane(cti('tests/zakazane.txt'), 'tests/zakazane.txt');
const lokalni = existuje('tests/zakazane.local.txt')
  ? parsujZakazane(cti('tests/zakazane.local.txt'), 'tests/zakazane.local.txt')
  : { vzory: [], povolene: [] };
const vzory = { vzory: [...zakazane.vzory, ...lokalni.vzory], povolene: [...zakazane.povolene, ...lokalni.povolene] };

describe('výpis souborů repa', () => {
  it('obsahuje základní soubory a není podezřele krátký (jinak by lint prošel naprázdno)', () => {
    const chybi = ['README.md', 'LICENSE', '.claude-plugin/marketplace.json', '.gitattributes', '.gitignore', 'package.json', 'tests/zakazane.txt']
      .filter((f) => !vsechny.includes(f));
    nic('Ve výpisu souborů repa chybí tyto soubory (spouští se test z kořene repa a výpis jde přes git ls-files?):', chybi);
    assert.ok(vsechny.length >= 15, `Výpis souborů repa má jen ${vsechny.length} položek, čekám aspoň 15. Test by prošel naprázdno; zkontroluj, že se spouští z repa a že git funguje.`);
    assert.ok(textove.length >= 12, `Textových souborů je jen ${textove.length}, čekám aspoň 12.`);
  });
});

describe('znaky a konce řádků', () => {
  it('detektory poznají vadný vzorek (red) a dobrý vzorek (green)', () => {
    assert.ok(`a ${EM_DASH} b`.includes(EM_DASH));
    assert.ok(!'a - b'.includes(EM_DASH));
    assert.ok((BOM + 'x').startsWith(BOM));
    assert.ok('a\r\nb'.includes('\r'));
    assert.ok(!'a\nb'.includes('\r'));
    assert.ok(EMOJI.test('hotovo ' + String.fromCodePoint(0x2705)));
    assert.ok(EMOJI.test('stop ' + String.fromCodePoint(0x1F6A8)));
    assert.ok(!EMOJI.test('Autorské právo ' + String.fromCodePoint(0xA9) + ' a ĚŠČŘŽÝÁÍÉ, šipka ' + String.fromCodePoint(0x2192)));
  });

  it('žádný soubor neobsahuje znak em dash (U+2014); nahraď ho čárkou, dvojtečkou, závorkou nebo spojovníkem', () => {
    nic('Znak em dash (U+2014) je v těchto souborech:', textove.filter((f) => cti(f).includes(EM_DASH)).map((f) => {
      const radek = cti(f).split('\n').findIndex((r) => r.includes(EM_DASH)) + 1;
      return `${f}:${radek}`;
    }));
  });

  it('žádný soubor nezačíná BOM (U+FEFF); ulož ho jako UTF-8 bez BOM', () => {
    nic('Soubory s BOM na začátku:', textove.filter((f) => cti(f).startsWith(BOM)));
  });

  it('všechny textové soubory mají konce řádků LF (žádné CR); skripty s CRLF se v Git Bash rozbijí', () => {
    nic('Soubory s CR (CRLF) na koncích řádků; převeď na LF a zkontroluj .gitattributes (text=auto eol=lf):',
      textove.filter((f) => cti(f).includes('\r')));
  });

  it('každý neprázdný textový soubor končí novým řádkem', () => {
    nic('Soubory bez koncového nového řádku:', textove.filter((f) => {
      const t = cti(f);
      return t.length > 0 && !t.endsWith('\n');
    }));
  });

  it('žádný soubor neobsahuje emoji (texty jsou věcné, bez ozdob)', () => {
    nic('Emoji nalezeno v souborech:', textove.filter((f) => EMOJI.test(cti(f))).map((f) => {
      const radek = cti(f).split('\n').findIndex((r) => EMOJI.test(r)) + 1;
      return `${f}:${radek}`;
    }));
  });
});

describe('.gitattributes a .gitignore', () => {
  it('.gitattributes vynucuje LF', () => {
    const t = cti('.gitattributes');
    assert.match(t, /^\*\s+text=auto\s+eol=lf\s*$/m, '.gitattributes musí obsahovat řádek "* text=auto eol=lf", jinak Windows s autocrlf vytvoří soubory s CRLF.');
  });

  it('.gitignore vylučuje lokální doplněk zakázaných řetězců, aby se osobní údaje nedostaly do repa', () => {
    assert.match(cti('.gitignore'), /^tests\/zakazane\.local\.txt\s*$/m, 'Přidej do .gitignore řádek tests/zakazane.local.txt.');
    assert.ok(!vsechny.includes('tests/zakazane.local.txt'), 'tests/zakazane.local.txt je mezi sledovanými nebo přidatelnými soubory; je v .gitignore a nesmí se commitovat.');
  });
});

describe('zakázané řetězce (osobní údaje a soukromý kontext)', () => {
  it('seznam vzorů se načte a není prázdný', () => {
    assert.ok(zakazane.vzory.length >= 8, `tests/zakazane.txt má jen ${zakazane.vzory.length} vzorů, čekám aspoň 8. Nesmazal se seznam?`);
  });

  it('vzory poznají vadné vzorky (red) a nechají projít povolené (green)', () => {
    // vzorky se skládají za běhu, aby tento soubor sám žádný zakázaný řetězec neobsahoval
    const vadne = [
      ['C:/Us', 'ers/jan/code'].join(''),
      ['C:', '\\Users\\jan\\code'].join(''),
      ['/Us', 'ers/jan/projekt'].join(''),
      ['jan.novak', '@', 'firma.example'].join(''),
      ['maji', 'tel'].join(''),
      ['claude', '-setup'].join(''),
      ['rule-to', '-check'].join(''),
      ['setup', '-sync'].join(''),
      ['back', 'log'].join(''),
      ['App', 'Data/Local'].join(''),
    ];
    for (const v of vadne) {
      assert.ok(najdiZakazane(v, zakazane).length > 0, `Vzor neodhalil vadný vzorek "${v}"; oprav tests/zakazane.txt.`);
    }
    const dobre = [
      ['191391870+jan', '@', 'users.noreply.github.com'].join(''),
      ['noreply', '@', 'anthropic.com'].join(''),
      'claude plugin install orchestrace@claude-sdilene',
      '~/.claude/agents a .claude/agents projektu',
      'npm install -g @anthropic-ai/claude-code',
      'claude-sdilene',
    ];
    for (const d of dobre) {
      assert.deepEqual(najdiZakazane(d, zakazane), [], `Vzor falešně označil povolený vzorek "${d}"; oprav tests/zakazane.txt.`);
    }
  });

  it('žádný soubor (kromě seznamů zakázaných řetězců) neobsahuje zakázaný řetězec; viz tests/zakazane.txt', () => {
    const nalezy = [];
    for (const f of textove.filter((x) => !ZAKAZANE_SOUBORY.includes(x))) {
      for (const n of najdiZakazane(cti(f), vzory)) nalezy.push(`${f}:${n.radek}: "${n.shoda}" (vzor ${n.vzor})`);
    }
    nic('Veřejné repo nesmí obsahovat osobní údaje ani soukromý kontext autora. Přepiš text obecně nebo odstraň nález:', nalezy);
  });

  it('žádný název souboru neobsahuje zakázaný řetězec', () => {
    const nalezy = [];
    for (const f of vsechny) for (const n of najdiZakazane(f, vzory)) nalezy.push(`${f}: "${n.shoda}"`);
    nic('Názvy souborů prozrazují osobní údaje nebo soukromý kontext:', nalezy);
  });

  it('autorský handle je jen v povolených souborech a ty existují', () => {
    nic('Povolený soubor pro handle autora neexistuje (aktualizuj HANDLE_POVOLENE v tests/obsah.test.mjs):', HANDLE_POVOLENE.filter((f) => !existsSync(cesta(f))));
    const nalezy = textove
      .filter((f) => !HANDLE_POVOLENE.includes(f) && !ZAKAZANE_SOUBORY.includes(f))
      .filter((f) => cti(f).includes(HANDLE));
    nic(`Handle ${HANDLE} smí být jen v instalačních příkazech, URL repa, owner a author v manifestech a v LICENSE. Najdeš ho tady:`, nalezy);
  });

  it('handle autora se v povolených souborech skutečně vyskytuje (seznam výjimek není zastaralý)', () => {
    nic('Tyto soubory handle neobsahují, odeber je z HANDLE_POVOLENE:', HANDLE_POVOLENE.filter((f) => existsSync(cesta(f)) && !readFileSync(cesta(f), 'utf8').includes(HANDLE)));
  });
});

describe('zástupné komentáře v dokumentaci', () => {
  const ZASTUPNE = /\b(TODO|FIXME|TBD|XXX)\b|lorem ipsum|\bdoplnit\b|<\s*(doplnit|doplň|vlož)[^>]*>|\.\.\.\s*$/i;

  it('detektor pozná zástupný text (red) a běžnou větu (green)', () => {
    for (const v of ['TODO: napsat', 'Sem se doplnit', '<doplň odkaz>', 'Lorem ipsum dolor', 'a pak ...']) assert.ok(ZASTUPNE.test(v), `Detektor neodhalil "${v}".`);
    for (const d of ['Instalace pluginu.', 'Doplň model, např. model: sonnet.', 'tři tečky v kódu `a...b`']) assert.ok(!ZASTUPNE.test(d), `Detektor falešně označil "${d}".`);
  });

  it('v žádném .md souboru není zástupný komentář (TODO, doplnit, lorem ipsum)', () => {
    assert.ok(markdown.length >= 4, `Markdown souborů je jen ${markdown.length}, čekám aspoň 4.`);
    const nalezy = [];
    for (const f of markdown) {
      cti(f).split('\n').forEach((r, i) => { if (ZASTUPNE.test(r)) nalezy.push(`${f}:${i + 1}: ${r.trim().slice(0, 80)}`); });
    }
    nic('Dokumentace obsahuje zástupný text; dopiš ho, nebo smaž:', nalezy);
  });
});
