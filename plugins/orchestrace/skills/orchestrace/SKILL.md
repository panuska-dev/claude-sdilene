---
name: orchestrace
description: Rozděluje práci při ultracode a Workflow: hlavní session rozkládá úlohu, zadává subagentům výslovný model a effort a čte jejich výtahy s důkazem, subagenti čtou velké podklady, píšou kód a dokumenty a ověřují výsledky. Použij při zapnutém ultracode, před voláním Workflow nebo nástroje Agent, při volbě modelu a effortu pro subagenty, když dochází limit předplatného a když hook orchestrace zamítne volání. Nepoužívej pro krátký dotaz, úpravu jednoho souboru nebo pár příkazů.
---

# Orchestrace: hlavní session řídí, subagenti pracují

[REFERENCE.md](REFERENCE.md): verze aliasů, ceny, benchmarky za tabulkou modelů, pořadí, ve kterém se určí model subagenta, a kostra skriptu workflow. Přečti ho, když píšeš skript workflow nebo když úloha do tabulky nezapadá.

Hlavní session drží jen výtahy, protože se její kontext posílá při každém tahu. Subagent bez výslovného modelu běží na modelu session a desítky takových agentů rychle vyčerpají limit.

Před každým Workflow nebo Agent: (1) velké podklady hlavní session nečte a nepíše, deleguje; (2) každý subagent má `model`, ve Workflow i `effort` (sekce 4); (3) výstup subagenta je výtah s důkazem, ne obsah souborů; (4) když kontext výrazně narostl, postupovat podle sekce 6.

## 1. Role

Hlavní session dělá:
1. Průzkum jen pro rozklad: seznam souborů a jejich velikosti (nástroj Glob, nástroj Grep v režimu seznamu souborů), ne obsah.
2. Rozklad práce, zadání, volbu modelu a effortu u každého subagenta.
3. Čtení výtahů a rozhodnutí o dalším kroku; rozpor mezi výtahy řeší dalším subagentem, ne vlastním čtením.
4. Závěrečné řízené zápisy: pravidla a nastavení (CLAUDE.md, settings) až po výslovném souhlasu uživatele, commit a push podle projektu, odpověď uživateli s důkazem.

Hlavní session nedělá: nečte velké soubory a podklady (PDF, směrnice, dlouhé logy, cizí moduly), nepíše dokumenty ani kód, nedělá rešerše. Sama jen odpovídá v konverzaci a dělá triviální mechanické úpravy.

Úloha bez velkého vstupu, která se celá vejde do kontextu, jde jednomu subagentovi, nikdy ne štafetě. Hlavní session ji sama nedělá, protože by jí narůstal kontext (zdůvodnění v sekci 2).

## 2. Rozklad

- Jedna úloha = jeden výstup a ověřitelné kritérium dokončení. Nezávislé úlohy paralelně (`pipeline`), závislé za sebou.
- Velký vstup dělit podle přirozených hranic: kapitoly, adresáře, témata.
- Měření Anthropic: delegace vyhrála jen u rutinní práce s mnoha drobnými podobnými případy a u práce větší než jedno okno; u dříve měřených modelů jinak vyhrál model orchestrátora sám na nižším effortu. Měření porovnává kvalitu a cenu, ne růst kontextu hlavní session. Proto se úloha, která se vejde do kontextu, předá jednomu subagentovi (sekce 1), ne štafetě.
- Vícefázová práce = víc workflow za sebou (porozumět, navrhnout, provést, ověřit); mezi nimi hlavní session čte výsledek a plánuje.
- Neznámý rozsah: nejdřív malý řez, pak plný běh. Při ultracode se varování o velkém workflow nezobrazuje, počet subagentů hlídá hlavní session.

## 3. Zadání subagentovi (vše povinné)

1. Cíl a proč, kontext, který subagent nemá: nevidí konverzaci ani soubory přečtené jinde. CLAUDE.md načítá subagent sám, jeho pravidla v zadání neopakuj. Výjimka: Explore, Plan a subagenti s `omitClaudeMd` ho nenačítají, těm podstatná pravidla napiš do zadání.
2. Vstupy: absolutní cesty, URL, rozsah.
3. Výstup: kam zapsat soubory a jaký výtah vrátit (ve Workflow `schema`, u nástroje Agent popis tvaru odpovědi v zadání), nikdy obsah souborů.
4. Kritérium dokončení a důkaz (příkaz a výstup, cesta:řádek, URL); co neověřil, označí.
5. Hranice: kam nesmí psát, zda smí commitovat. Trvalá pravidla nezapisuje, navrhne je ve výtahu a o zápisu rozhodne uživatel.
6. `model` a `effort` (sekce 4).

## 4. Model a effort

Výchozí: nejmenší model, který úlohu zvládne, effort medium. Tabulka je výchozí volba, ne měření (zdroje a jistota v REFERENCE.md). Aliasy `opus`, `sonnet`, `haiku` a `fable` ukazují na aktuální verzi; které verze to jsou a od jakého Claude Code, uvádí REFERENCE.md. Na starším Claude Code míří alias na starší model.

| Úloha | model | effort |
|---|---|---|
| Mechanické úpravy, vyhledávání, kontrola odkazů, extrakce, třídění | haiku | medium; low jen pro krátké jednoduché zadání |
| Shrnutí krátkého nebo extraktivního dokumentu | haiku | medium |
| Dlouhé, regulační nebo vizuálně náročné podklady (tabulky, grafy) | sonnet | medium |
| Rešerše na webu, čtení zdrojů | sonnet | medium |
| Kód, dobře zadaný | sonnet | medium |
| Kód nejasný, rozsáhlý, architektonicky citlivý | opus | high |
| Revize a ověřování faktů u těžkých témat | opus | medium až high |
| Syntéza středního rozsahu | sonnet | high |
| Syntéza dlouhá nebo rozporná | opus | high |
| Architektura, hledání příčin, nejednoznačné problémy | opus | high |
| Právní a regulační úvahy | opus | high |
| Nejtěžší úsudek s vysokými důsledky, opus nestačil ani při xhigh nebo max (Anthropic: až tehdy přejít na fable) | fable, výslovná volba (podle plánu se může účtovat z usage credits); když ho účet nenabízí, opus | high |

- Snížit effort, případně model, o stupeň: mechanická práce s jasným kritériem, výstup kontroluje další fáze nebo program.
- Zvýšit o stupeň (nejdřív effort, pak model): subagent minul kritérium dokončení, výstup jde uživateli bez revize, vysoké důsledky (právo, bezpečnost, peníze, osobní data).
- xhigh a max jen se změřeným přínosem.
- haiku: prompt nad 100 000 tokenů má pětinásobnou sazbu.
- fable nikdy jako výchozí volba pro subagenty, jen jednotlivá těžká fáze, a high (Anthropic doporučuje začít na high; na low a medium častěji končí tah předčasně). Žádný model Fable není výchozí na žádném plánu ani u žádného poskytovatele.
- Ve workflow: každé `agent()` má `model` i `effort`, společné úrovně přes konstanty a spread (`{...LEVNE, schema}`; kostra v REFERENCE.md). U nástroje Agent pole `model` (alias), podle potřeby i `effort`. U vlastního typu agenta (`agentType`) může být model v jeho definici; tam ho ověř. Tento skill vyžaduje model u každého volání i tam, kde obecné návody radí ho vynechat, aby subagenti nedědili drahý model session.
- fork běží na modelu svého rodiče (u hlavní session na jejím modelu) a nedá se mu nastavit ani effort. Na levnou práci ho nepoužívej. U agenta z pluginu (`plugin:jméno`) hook definici nečte: ověř, že má model nastavený a není `inherit`.
- Kontrola: hook tohoto pluginu `hooks/orchestrace-guard.mjs`. Zamítne Agent nebo Task bez `model` a `agent()` ve Workflow bez `model` nebo bez `effort`. Bez modelu smí být jen fork, agent z pluginu (`plugin:jméno`) a vlastní typ s modelem v definici. Effort ve Workflow je povinný vždy, u nástroje Agent ho hook nevyžaduje. Vypínač `ORCHESTRACE_GUARD=off` použij jen na pokyn uživatele.
- Při `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` Claude Code ignoruje model v definicích a model při volání předat nejde, proto hook model nevyžaduje sám: Agent a Task bez `model` projdou a ve workflow hlídá jen `effort`. Ruční `ORCHESTRACE_GUARD=off` kvůli tomu není potřeba. Hook bere jako zapnuté hodnoty `1`, `true`, `yes` a `on` (na velikosti písmen a okolních mezerách nezáleží).

## 5. Ověřování

- Ověřuje jiný subagent než autor, bez autorova uvažování; dostane výstup a zdroje a má ho vyvrátit.
- Mechanické a faktické kontroly (odkazy, čísla proti zdroji, formát): levnější model než autor, nebo program.
- Těžká témata (právo, architektura, rozporná syntéza, vysoké důsledky): stejný nebo silnější model, opus high.
- Kód ověřuje test, ne názor.

## 6. Hygiena kontextu

- Výtah = závěr, důkazy (cesta:řádek, příkaz, URL), co neověřeno, otevřené body. Soubory zůstávají na disku, hlavní session na ně odkazuje cestou.
- Velké vstupy čte vždy subagent. Workflow vrací malý objekt, mezivýsledky drží skript.
- Když kontext (`/context`) výrazně narostl nebo se kvalita odpovědí zhoršuje, na nejbližší přirozené přestávce navrhnout uživateli `/compact` s fokusem, nebo předávací poznámku a `/clear`. Ne uprostřed úlohy.

## 7. Limit dochází nebo je vyčerpaný

1. Nespouštět další subagenty. Běh, který na limit narazil, na předplatném za podmínek z docs (workflows, sekce usage limit) počká na reset sám a pak pokračuje; `/workflows` ukazuje čas resetu. Co je levnější, počkat, nebo zastavit a změnit model, rozhodne uživatel.
2. Zjistit příčinu (`/usage`, model a effort jednotlivých fází).
3. Při změně: workflow zastavit, ve skriptu snížit model nebo effort jen u volání, která ještě nedoběhla; hotová volání neměnit.
4. Pokračovat `Workflow({scriptPath, resumeFromRunId})` jen ve stejné session; po ukončení nejdřív `claude --resume`. Hotová volání s nezměněným promptem se zpravidla vrací z uložených výsledků; od prvního změněného nebo selhaného volání se běží znovu a subagent, který při zastavení běžel, začíná od začátku.
5. Uživateli: co doběhlo, co zbývá, na jakém modelu poběží zbytek.

## 8. Hlavní session

`opus`, effort medium; pro návrh rozkladu velké úlohy a konečnou syntézu high. `fable` jen pro mimořádně těžký úsudek, pak high, ne xhigh ani max. Odůvodnění: REFERENCE.md (Hlavní session).

Ultracode zapni příkazem `/effort ultracode` v session, kde už effort medium běží. Spuštění `claude --effort ultracode` nastaví xhigh.

Model session volit na začátku: přepnutí modelu zahodí cache, změna effortu ji nezahodí (s API klíčem nebo předplatným; na Bedrock, Agent Platform, Claude apps gateway, s `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` nebo s konfigurací HIPAA se cache zahazuje; verze Claude Code a modelů v REFERENCE.md).
