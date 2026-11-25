# orchestrace: podrobnosti a zdroje

Obsah:
- [Verze modelů a Claude Code](#verze-modelů-a-claude-code)
- [Jak se model a effort agenta určí](#jak-se-model-a-effort-agenta-určí)
- [Kostra workflow](#kostra-workflow)
- [Modely a ceny](#modely-a-ceny)
- [Jistota tabulky](#jistota-tabulky)
- [Benchmarky](#benchmarky)
- [Měření orchestrace](#měření-orchestrace)
- [Hlavní session](#hlavní-session-opus-nebo-fable)
- [Kontext a kompakce](#kontext-a-kompakce)

Údaje zjištěny 2026-11-10 z oficiálních stránek Anthropic (URL u každého bloku), opraveno podle kontroly zdrojů 2026-11-24. Benchmarky jsou vlastní měření výrobce, čísla tabulek převzal nástroj WebFetch (shrnuje malým modelem); brát řády, ne desetiny. Při vydání nového modelu tento soubor a tabulku ve [SKILL.md](SKILL.md) přezkoumat.

## Verze modelů a Claude Code

Stav k 2026-11-10. Zdroje: https://code.claude.com/docs/en/model-config (Version history), https://code.claude.com/docs/en/sub-agents , https://code.claude.com/docs/en/prompt-caching

- Aliasy na Anthropic API a nejnižší verze Claude Code, od které míří na uvedený model:

  | Alias | Model | Od Claude Code |
  |---|---|---|
  | `opus` | Opus 5.5 | 2.1.280 |
  | `sonnet` | Sonnet 5.5 | 2.1.284 |
  | `haiku` | Haiku 5.5 | 2.1.293 |
  | `fable` | Fable 5.2 | 2.1.321 |

  Na starší verzi míří alias na starší model (například `fable` na Fable 5.1 u verze 2.1.318); Fable 5.2 vyžaduje verzi 2.1.321 nebo novější. Ve Claude apps gateway se `fable` řeší na Fable 5. Kolegům doporučit aktualizaci Claude Code (`claude update`).
- `fable` není výchozí na žádném plánu ani u žádného poskytovatele, vybírá se výslovně. Podle plánu a úrovně místa se jeho použití může účtovat z usage credits místo z limitů zahrnutých v plánu.
- Změna effortu nezahodí cache u Opus 5.5, Sonnet 5.5, Haiku 5.5 a Fable 5.1 a novějších (Fable 5.1 od Claude Code 2.1.260), ale jen s API klíčem nebo s předplatným. Na Amazon Bedrock, Google Cloud Agent Platform, v Claude apps gateway, při `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` a při konfiguraci HIPAA se cache při změně effortu zahazuje. Přepnutí modelu cache zahodí vždy.
- Nástroj Agent smí při volání předat i `effort` (jen ne-fork) od Claude Code v2.1.292.
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` vyžaduje Claude Code v2.1.257 nebo novější.

## Jak se model a effort agenta určí

Zdroje: https://code.claude.com/docs/en/sub-agents , https://code.claude.com/docs/en/workflows (sekce Cost), https://code.claude.com/docs/en/model-config

1. Model uvedený při volání (ve workflow `opts.model` u `agent()`, u nástroje Agent pole `model`).
2. Pole `model` v definici agenta (`inherit` = model hlavní konverzace).
3. Proměnná `CLAUDE_CODE_SUBAGENT_MODEL` (platí i pro workflow agenty; `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` ji vynutí pro všechny).
4. Model hlavní konverzace.

- Při `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` Claude Code ignoruje pole `model` v definicích agentů a Claude při spuštění subagenta nesmí předat model (zdroj: https://code.claude.com/docs/en/sub-agents, sekce Run every subagent on one model). Hook orchestrace v tom případě model nevyžaduje: Agent a Task bez `model` projdou a ve workflow hlídá jen `effort`, takže `ORCHESTRACE_GUARD=off` není potřeba. Za zapnutou hook bere hodnotu `1`, `true`, `yes` nebo `on` (na velikosti písmen a okolních mezerách nezáleží).
- Nástroj Agent přijímá jen aliasy; definice agenta i plný ID a `inherit`.
- Effort: `low`, `medium`, `high`, `xhigh`, `max`. Bez uvedení agent běží na effortu session. `CLAUDE_CODE_EFFORT_LEVEL` přebíjí všechno včetně hodnot při volání, proto ho k řízení agentů nepoužívat.
- Vestavěné typy agentů:
  - Explore běží na modelu hlavní konverzace; s předplatným, Console účtem nebo LLM gateway běží na Opusu, na Bedrock, Agent Platform, Foundry a Claude Platform on AWS zůstává na Fable (podmínku uvádí zdroj jen zčásti, před spoléháním ověřit v sub-agents docs). `CLAUDE_CODE_SUBAGENT_MODEL` samo model Explore a Plan nemění.
  - Plan dědí model hlavní konverzace, pokud model není vynucen.
  - `web-fetch` běží na Haiku, `claude-code-guide` na Haiku, `statusline-setup` na Sonnetu.
  - fork běží na modelu svého rodiče; fork vnořený pod subagentem běží na modelu rodičovského subagenta.
- Neověřeno: zda `opts.model` ve workflow přijímá i plný ID a zda přebíjí `agentType` a proměnné prostředí (schéma nástroje Workflow v dokumentaci nenalezeno).

## Kostra workflow

```js
const LEVNE = { model: 'haiku', effort: 'medium' }
const BEZNE = { model: 'sonnet', effort: 'medium' }
const TEZKE = { model: 'opus', effort: 'high' }
const VYTAH = { type: 'object', properties: {
  zaver: { type: 'string' },
  dukazy: { type: 'array', items: { type: 'string' }, description: 'cesta:řádek, příkaz a výstup, URL' },
  neovereno: { type: 'array', items: { type: 'string' } },
  soubory: { type: 'array', items: { type: 'string' } },
}, required: ['zaver', 'dukazy', 'neovereno'] }

const vysledky = await pipeline(KAPITOLY,
  (_, k) => agent(`Přečti ${k.cesta} ... zapiš do ${k.vystup} ... vrať výtah`, { ...BEZNE, schema: VYTAH, phase: 'Čtení', label: `čtení:${k.id}` }),
  (r, k) => agent(`Ověř proti zdroji ${k.cesta}: ${JSON.stringify(r)}`, { ...LEVNE, schema: VYTAH, phase: 'Ověření', label: `ověření:${k.id}` }),
)
return vysledky.filter(Boolean)
```

Stejný model, effort, typ, nástroje a schéma u více agentů sdílí prefix cache (workflows, sekce Cost).

## Modely a ceny

Zdroj: https://platform.claude.com/docs/en/about-claude/pricing , stránky modelů https://platform.claude.com/docs/en/models/{fable-5-2,opus-5-5,sonnet-5-5,haiku-5-5}/overview

| | Fable 5.2 | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|---|
| Vstup / výstup za 1M tokenů | $8 / $40 | $4 / $20 | $2 / $10 | $0.10 / $0.50 do 100k promptu, $0.50 / $2.50 nad |
| Čtení z cache za 1M | $0.20 | $0.20 | $0.10 | $0.01 (nad 100k $0.05) |
| Kontext | 1M, bez příplatku | 1M, bez příplatku | 1M, bez příplatku | 1M, příplatek nad 100k |
| Latence (srovnávací štítek) | střední | střední | rychlá | nejrychlejší |
| Výchozí effort v Claude Code | medium | medium | medium | medium |

Použití podle Anthropic: Fable 5.2 náročné uvažování a dlouhé agentní relace; Opus 5.5 výchozí pro většinu úloh, dlouhé agentní kódování a znalostní práce; Sonnet 5.5 nejlepší poměr rychlosti a inteligence, silný na dobře zadaných úlohách; Haiku 5.5 klasifikace, extrakce, routing, shrnutí, subagenti.

## Jistota tabulky

Tabulka ve [SKILL.md](SKILL.md) je odvozená z doporučení a benchmarků Anthropic (vlastní měření výrobce) a z úsudku. Žádný zdroj tyto úlohy přímo neměří, proto sloupec nikde neříká „vysoká“.

| Úloha | Jistota |
|---|---|
| Mechanické úpravy, vyhledávání, kontrola odkazů, extrakce, třídění | střední |
| Shrnutí krátkého nebo extraktivního dokumentu | střední |
| Dlouhé, regulační nebo vizuálně náročné podklady | střední |
| Rešerše na webu, čtení zdrojů | nízká až střední |
| Kód, dobře zadaný | střední |
| Kód nejasný, rozsáhlý, architektonicky citlivý | střední |
| Revize a ověřování faktů u těžkých témat | nízká až střední |
| Syntéza středního rozsahu | nízká až střední |
| Syntéza dlouhá nebo rozporná | nízká až střední |
| Architektura, hledání příčin, nejednoznačné problémy | střední |
| Právní a regulační úvahy | nízká |
| Nejtěžší úsudek s vysokými důsledky (fable) | střední |

Doporučení `low` u haiku jen pro krátké jednoduché zadání nemá doložený zdroj; je to úsudek, ne tvrzení Anthropic (oznámení Haiku 5.5 o chování na low nic neuvádí).

## Benchmarky

Použité pro tabulku ve SKILL.md. Zdroje: https://www.anthropic.com/claude-fable-and-mythos-5-2 , /claude-opus-5-5 , /claude-sonnet-5-5 , /claude-haiku-5-5

Effort je uveden jen tam, kde ho zdroj výslovně uvádí; buňky bez štítku mohou mít jiný effort, než se předpokládá.

| Benchmark | Fable 5.2 | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|---|
| Terminal-Bench 4.0 | neuvedeno | 66.4 % (xhigh) | 70.6 % (effort neuveden) | 39.2 % |
| FrontierCode 1.1 | 49.1 % (xhigh); 45.3 % (high) | 54.4 % (max); 54.6 % (medium, výchozí) | 52.1 % (xhigh); 46.2 % (max, nižší kvůli spouštění code-review skillu v mnoha subagentech) | 46.4 % |
| CursorBench 4.0 | neuvedeno | 57.8 % (max); 52.5 % (medium, výchozí) | 55.5 % | neuvedeno |
| GDPval-AA (Elo) | neuvedeno | 1846 (max) | 1844 | 1620 |
| HLE s nástroji | 74.2 % | 67.7 % | 64.5 % | 57.4 % |
| HLE bez nástrojů | neuvedeno | neuvedeno | 56.9 % | 45.9 % |
| Chartography (bez nástrojů) | 73.4 % | 64.4 % | 61.6 % | 46.4 % |

Poznámky: u Chartography platí štítek „bez nástrojů“ podle stránky Sonnetu (Opus 64.4 %, Sonnet 61.6 %); stránka Opusu uvádí Opus s nástroji 89.0 %, tedy číslo, které se s řádkem srovnávat nesmí. Štítek u Fable a Haiku v této kontrole nezjištěn.

Odvozené závěry (úsudek, ne tvrzení Anthropic):
- Dobře zadaný kód stačí Sonnet: Terminal-Bench má Sonnet nad Opusem (effort Sonnetu neuveden, Opus při xhigh), CursorBench Opus při medium (52.5 %) pod Sonnetem (55.5 %, effort Sonnetu neuveden), takže srovnání je orientační.
- Otevřená práce s trvalým úsudkem patří Opusu (opírá se o text Anthropic). Na FrontierCode 1.1 je rozdíl malý: Opus 54.4 % při max a 54.6 % při medium proti Sonnetu 52.1 % při xhigh, tedy asi 2 až 2.5 bodu a Opus má při medium stejný výsledek jako při max.
- Grafy a tabulky v PDF patří Sonnetu místo Haiku (Chartography, HLE bez nástrojů).
- Pro webovou rešerši a právní úvahy přímý benchmark u modelů 5.x nenalezen; doporučení stojí na HLE a na úsudku, ne na měření.
- Anthropic o Sonnetu a Opusu píše: Sonnet je nejsilnější u dobře zadaných každodenních úloh, Opus je jasně silnější u složité otevřené práce vyžadující trvalý úsudek (text oznámení Sonnet 5.5, bez čísla).

## Měření orchestrace

Doporučení Anthropic. Zdroje: https://platform.claude.com/docs/en/about-claude/models/choosing-a-model , https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence , https://code.claude.com/docs/en/best-practices , https://code.claude.com/docs/en/costs

- Začít na Opus 5.5, na Fable 5.2 přejít, až evaly na Opusu při xhigh nebo max stále nestačí. „Tuning effort is often a better lever than switching models.“
- Delegace vyhrála jen u rutinní práce s mnoha drobnými podobnými případy a u práce větší než jedno okno (jen ve dvou měřených situacích); jinak vyhrál orchestrátorův model sám na nižším effortu, u dříve měřených modelů. Pro modely 5.5 samostatně změřeno není. Skill orchestrace přesto předává i střední úlohu jednomu subagentovi, protože chrání kontext hlavní session, který tato měření nesledují.
- Opus 5.5 medium se Sonnet 5.5 subagenty: stejný výsledek jako Opus sám, asi o třetinu levněji.
- Fable 5.2 na místě Opusu jako orchestrátor: o 19 % dráž, skóre zhruba stejné (stránka výslovně neuvádí subagenty, z kontextu Sonnet 5.5).
- Opus 5.5 medium s Haiku 5.5 subagenty: o 32 % levnější, úspěšnost asi o 4 body nižší („an alternative to lowering effort, not better“).
- Fable 5.2 sám: o 1.6 až 5.9 bodu nad Opusem na high za 1.5 až 2.4násobek ceny.
- Advisor (slabší model vede a radí se se silnějším): jediná dvojice, kde se poradce volal často, +1.7 bodu na hraně šumu za asi 2.1násobek ceny; u ostatních se poradce skoro nevolal. Konkrétní dvojice modelů neověřena.
- Čerstvý revizor pomáhá, protože neviděl uvažování autora (best-practices). Pro jednoduché subagenty `model: haiku` (costs).
- Fable 5.2 (https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2): v harnessu, jehož pokyny k delegaci vybízejí, deleguje ochotně a subagenti mohou tvořit velkou část ceny session (Anthropic radí zkontrolovat, na jakém modelu subagenti běží); na low a medium častěji končí tah předčasně; na high přemýšlí před téměř každou odpovědí.
- Pokračování workflow (`resumeFromRunId`): jen ve stejné session, hotová volání s nezměněným vstupem se zpravidla vrací z cache, ostatní běží znovu (https://code.claude.com/docs/en/agent-sdk/typescript , https://code.claude.com/docs/en/workflows). Při selhání na usage limitu se hotová volání vrací bez opakování od v2.1.318.

## Hlavní session: Opus, nebo Fable

Doporučení: Opus 5.5, effort medium, high pro návrh rozkladu a konečnou syntézu; Fable 5.2 výjimečně a pak high. Jistota střední.

1. Anthropic: Opus 5.5 výchozí, Fable až když Opus nestačí.
2. Cena hlavní session je hlavně opakované čtení rostoucího kontextu; čtení z cache stojí u obou $0.20 za 1M. Dopočet z ceníku, ne měření: 500 000 tokenů z cache $0.10 u obou, bez cache (po vypršení) $4.00 Fable proti $2.00 Opus. Dvojnásobek se projeví na thinkingu, výstupu a zápisech do cache.
3. Měření orchestrace: Fable na místě Opusu jako orchestrátor o 19 % dráž při zhruba stejném skóre (hledání defektů, subagenti výslovně neuvedeni).
4. Pro Fable: vede na většině benchmarků, raní testeři hlásí dobré výsledky v roli plánovače a orchestrátora pro jiné modely. Proti: při pokynech k delegaci deleguje ochotně (subagenti mohou tvořit velkou část ceny), na low a medium častěji končí tah předčasně.
5. Hypotéza, ne měření: ve workflow drží smyčku skript a hlavní session čte jen výsledek, takže jí snad stačí medium. xhigh a max pro koordinaci žádný zdroj nedoporučuje.
6. Ultracode: `claude --effort ultracode` nastaví effort xhigh; `/effort ultracode` (od v2.1.284) zapne automatickou orchestraci workflow na effortu, na kterém session běží (https://code.claude.com/docs/en/workflows, sekce Let Claude decide with ultracode).

Nedoloženo: měření přímo pro roli hlavní session ve workflow Claude Code. Ověření na vlastních úlohách: stejná úloha jednou s Opus 5.5 medium, jednou s Fable 5.2 high jako hlavní session, srovnat výsledek a spotřebu v `/usage`.

## Kontext a kompakce

Zdroje: https://platform.claude.com/docs/en/build-with-claude/context-windows , https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents , https://code.claude.com/docs/en/costs , https://code.claude.com/docs/en/prompt-caching , https://code.claude.com/docs/en/model-config

- Context rot: přesnost a recall s délkou kontextu klesají, gradient bez číselného prahu. Benchmarky dlouhého kontextu pro modely 5.x nenalezeny. Claude Code posílá celou konverzaci při každém požadavku.
- Cache TTL (https://code.claude.com/docs/en/prompt-caching, tabulka Which TTL each request gets): hlavní konverzace dostane hodinu jen na předplatném a v rámci zahrnutého limitu; po přechodu na usage credits nebo limit plánu klesne na pět minut. Na API klíči, u workflow agentů, forku, kompakce a teammates je to pět minut i na předplatném. Nastavení: `promptCacheTtl` a `subagentPromptCacheTtl` (od v2.1.242). Po vypršení se kontext zpracuje znovu za plnou cenu. `/compact` je sám velký požadavek.
- Vestavěná kompakce u modelů s 1M oknem běží kolem 967K. Aby běžela dřív, nastav práh příkazem `/autocompact <práh>`, klíčem `autoCompactWindow` v settings nebo proměnnou `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (100K až 1M).
- Číselný práh, od kterého se vyplatí kompaktovat dřív, oficiální zdroj neuvádí; rozhoduje pozorovaný pokles kvality a cena opakovaného čtení kontextu.
