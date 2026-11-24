---
name: orchestrace
description: Hlavní session jako manažer, subagenti pracují. Použij při zapnutém ultracode, před voláním Workflow nebo více subagentů, když úloha vyžaduje číst velké podklady nebo psát víc souborů, když volíš model a effort pro subagenty a když hook orchestrace zamítne volání Agent nebo Workflow. Nepoužívej pro běžnou drobnou práci (krátký dotaz, úprava jednoho souboru, pár příkazů), tu hlavní session udělá sama bez delegace.
---

# Orchestrace: hlavní session řídí, subagenti pracují

Kontext hlavní session se posílá při každém tahu a s jeho délkou kvalita plynule klesá. Subagent má vlastní kontext, manažer drží jen výsledky. Agent bez výslovného modelu dědí model session: když session běží na drahém modelu, desítky agentů na stejném modelu rychle vyčerpají limit. Zdroje a čísla: [REFERENCE.md](REFERENCE.md).

Před každým Workflow nebo Agent: (1) velké podklady hlavní session nečte a nepíše, deleguje; (2) každý agent má `model` a `effort`; (3) výstup agenta je výtah s důkazem, ne obsah souborů; (4) když kontext výrazně narostl, postupovat podle bodu 6.

## 1. Role

Hlavní session dělá:
1. Průzkum jen pro rozklad: seznam souborů, velikosti, struktura (`ls`, `rg -l`, `wc`), ne obsah.
2. Rozklad práce, zadání, volbu modelu a effortu u každého agenta.
3. Čtení výtahů, rozhodnutí o dalším kroku; rozpor mezi výtahy řeší dalším agentem, ne vlastním čtením.
4. Závěrečné řízené zápisy: pravidla a nastavení (CLAUDE.md, settings) až po výslovném souhlasu uživatele, commit a push podle projektu, odpověď uživateli s důkazem.

Hlavní session nedělá: nečte velké soubory a podklady (PDF, směrnice, dlouhé logy, cizí moduly), nepíše dokumenty ani kód, nedělá rešerše. Sama dělá jen konverzační tah a triviální mechanickou úpravu.

## 2. Rozklad

- Jedna úloha = jeden výstup a ověřitelné hotovo. Nezávislé úlohy paralelně (`pipeline`), závislé za sebou.
- Velký vstup dělit podle přirozených hranic: kapitoly, adresáře, témata.
- Delegace se vyplácí u rutinní práce s mnoha drobnými podobnými případy (long tail) a u práce větší než jedno okno. Jeden závislý řetězec, který se vejde do kontextu: jeden agent, ne štafeta.
- Vícefázová práce = víc workflow za sebou (porozumět, navrhnout, provést, ověřit); mezi nimi manažer čte výsledek a plánuje.
- Neznámý rozsah: nejdřív malý řez, pak plný běh. Při ultracode se varování o velkém workflow nezobrazuje, počet agentů hlídá manažer.

## 3. Zadání subagentovi (vše povinné)

1. Cíl a proč, kontext, který subagent nemá: nevidí konverzaci ani soubory přečtené jinde. CLAUDE.md projektu a uživatele dostává, jeho pravidla v zadání neopakovat.
2. Vstupy: absolutní cesty, URL, rozsah.
3. Výstup: kam zapsat (cesta) a co vrátit: `schema` se strukturovaným výtahem, nikdy obsah souborů.
4. Hotovo: kritérium a důkaz (příkaz a výstup, cesta:řádek, URL); co neověřil, označí.
5. Hranice: kam nesmí psát, zda smí commitovat. Pravidla nezapisuje: „rule candidate“ znamená, že subagent trvalé pravidlo nikam nezapíše, jen ho navrhne ve výsledku a o zápisu rozhodne uživatel.
6. `model` a `effort` (bod 4).

## 4. Model a effort

Výchozí: nejmenší model, který úlohu zvládne, effort medium. Tabulka je odvozená z doporučení a benchmarků Anthropic (vlastní měření výrobce) a z úsudku; žádný zdroj tyto úlohy přímo neměří, proto sloupec Jistota nikde neříká „vysoká“. Aliasy `opus`, `sonnet`, `haiku` a `fable` ukazují vždy na aktuální verzi; které verze to jsou, uvádí datovaný blok v [REFERENCE.md](REFERENCE.md).

| Úloha | model | effort | Jistota |
|---|---|---|---|
| Mechanické úpravy, vyhledávání, kontrola odkazů, extrakce, třídění | haiku | medium; low jen krátké jednoduché zadání | střední |
| Shrnutí krátkého nebo extraktivního dokumentu | haiku | medium | střední |
| Dlouhé, regulační nebo vizuálně náročné podklady (tabulky, grafy) | sonnet | medium | střední |
| Rešerše na webu, čtení zdrojů | sonnet | medium | nízká až střední |
| Kód, dobře zadaný | sonnet | medium | střední |
| Kód nejasný, rozsáhlý, architektonicky citlivý | opus | high | střední |
| Revize a ověřování faktů u těžkých témat | opus | medium až high | nízká až střední |
| Syntéza středního rozsahu | sonnet | high | nízká až střední |
| Syntéza dlouhá nebo rozporná | opus | high | nízká až střední |
| Architektura, hledání příčin, nejednoznačné problémy | opus | high | střední |
| Právní a regulační úvahy | opus | high | nízká |
| Nejtěžší úsudek s vysokými důsledky, opus nestačil ani při xhigh nebo max (Anthropic: až tehdy přejít na fable) | fable, jen pokud ho účet nabízí; jinak opus | high | střední |

- O stupeň níž: mechanická práce s jasným kritériem, výstup kontroluje další fáze nebo program.
- O stupeň výš: agent minul kritérium hotovo, výstup jde uživateli bez revize, vysoké důsledky (právo, bezpečnost, peníze, osobní data).
- Nejdřív zvednout effort, teprve pak model. xhigh a max jen se změřeným přínosem.
- haiku: prompt nad 100 000 tokenů má pětinásobnou sazbu; na low v dlouhém zadání přeskakuje kroky.
- fable nikdy jako výchozí pracovník, jen jednotlivá těžká fáze, a high (Anthropic doporučuje začít na high; na low a medium častěji končí tah předčasně).
- Ve workflow: každé `agent()` má `model` i `effort`, společné úrovně přes konstanty a spread (`{...LEVNE, schema}`). U nástroje Agent pole `model` (alias), podle potřeby i `effort`. U vlastního typu agenta (`agentType`) může být model v jeho definici; tam ho ověřit. Tento skill model vyžaduje u každého volání i tam, kde obecné návody radí ho vynechat, aby subagenti nedědili drahý model session.
- Kontrola: hook tohoto pluginu `hooks/orchestrace-guard.mjs`. Zamítne volání Agent nebo Task bez `model` a `agent()` ve Workflow bez `model` nebo `effort` (výjimky: fork, agent z pluginu, vlastní typ agenta s modelem v definici). Vypínač: proměnná prostředí `ORCHESTRACE_GUARD=off`.

## 5. Ověřování

- Ověřuje jiný agent než autor, bez autorova uvažování; dostane výstup a zdroje a má ho vyvrátit.
- Mechanické a faktické kontroly (odkazy, čísla proti zdroji, formát): levnější model než autor, nebo program.
- Těžká témata (právo, architektura, rozporná syntéza, vysoké důsledky): stejný nebo silnější model, opus high.
- Kód ověřuje test, ne názor.

## 6. Hygiena kontextu

- Výtah = závěr, důkazy (cesta:řádek, příkaz, URL), co neověřeno, otevřené body. Soubory zůstávají na disku, manažer na ně odkazuje cestou.
- Velké vstupy čte vždy subagent. Workflow vrací malý objekt, mezivýsledky drží skript.
- Doloženo: kvalita s délkou kontextu plynule klesá (context rot) a každý tah posílá celý kontext znovu; číselný práh Anthropic neuvádí.
- Proto: když kontext (`/context`) výrazně narostl nebo se kvalita odpovědí zhoršuje, na nejbližší přirozené přestávce navrhnout uživateli `/compact` s fokusem, nebo předávací poznámku a `/clear`. Ne uprostřed úlohy.
- Model session volit na začátku: přepnutí modelu zahodí cache, změna effortu u současných modelů ne (kterých, uvádí [REFERENCE.md](REFERENCE.md)).

## 7. Limit dochází nebo je vyčerpaný

1. Nespouštět další agenty. Běh, který na limit narazil, na předplatném za podmínek z docs (workflows, sekce usage limit) počká na reset sám a pak pokračuje; `/workflows` ukazuje čas resetu. Co je levnější, počkat, nebo zastavit a změnit model, rozhodne uživatel.
2. Zjistit příčinu (`/usage`, model a effort jednotlivých fází).
3. Při změně: workflow zastavit, ve skriptu snížit model nebo effort jen u volání, která ještě nedoběhla; hotová volání neměnit.
4. Pokračovat `Workflow({scriptPath, resumeFromRunId})`: podle docs se hotová volání vrací z uložených výsledků, dokud se jejich prompt neliší od minulého běhu; od prvního změněného nebo selhaného volání se běží znovu.
5. Uživateli: co doběhlo, co zbývá, na jakém modelu poběží zbytek.

## 8. Hlavní session

`opus`, effort medium; pro návrh rozkladu velké úlohy a konečnou syntézu high. `fable` (jen pokud ho účet nabízí) jen pro mimořádně těžký úsudek, pak high, ne xhigh ani max. Jistota střední, odůvodnění v [REFERENCE.md](REFERENCE.md).
