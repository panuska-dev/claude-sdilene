// Falešné API Anthropic na lokální adrese: umožňuje spustit skutečný `claude -p` bez přihlášení a bez sítě a ověřit,
// že Claude Code opravdu spustí hook pluginu. Model "odpoví" jediným voláním nástroje Agent (nebo Task) s vloženým
// vstupem a po výsledku nástroje skončí textem. Server zaznamenává všechny požadavky, takže test vidí, co Claude Code
// poslal zpátky modelu (hlášku zamítnutí hooku jako výsledek nástroje) a s jakým modelem spustil podagenta.
//
// Rozhraní je tenká nadstavba nad dokumentovaným Messages API (https://docs.anthropic.com/en/api/messages-streaming):
// události message_start, content_block_*, message_delta, message_stop. Kdyby nová verze Claude Code protokol změnila,
// test selže s hláškou obsahující konec výstupu procesu (naplánovaný týdenní běh na kanálu latest to odhalí dřív než uživatelé).
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const sse = (res, udalost, data) => res.write(`event: ${udalost}\ndata: ${JSON.stringify({ type: udalost, ...data })}\n\n`);

const text = (zprava) => (typeof zprava?.content === 'string'
  ? zprava.content
  : (zprava?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join(''));

// Claude Code posílá za zprávami uživatele i zprávu s rolí system (kontext prostředí), proto se hledá poslední zpráva s rolí user.
const posledniUzivatelska = (zpravy) => [...zpravy].reverse().find((z) => z.role === 'user');

const vysledkyNastroju = (zprava) => (Array.isArray(zprava?.content) ? zprava.content.filter((b) => b.type === 'tool_result') : []);

// Obsah výsledku nástroje může být řetězec nebo pole textových bloků.
export const textVysledku = (vysledek) => (typeof vysledek.content === 'string'
  ? vysledek.content
  : (vysledek.content ?? []).map((b) => b.text ?? '').join(''));

// Spustí server na volném portu loopbacku. `znacka` je řetězec v uživatelském promptu, na který model odpoví voláním
// nástroje; `vstupNastroje` je jeho vstup. Ostatní požadavky (podagent, titulky, odhad tokenů) dostanou prostý text.
export async function spustFalesneApi({ znacka, vstupNastroje }) {
  const pozadavky = [];
  const server = createServer((req, res) => {
    const kusy = [];
    req.on('data', (k) => kusy.push(k));
    req.on('end', () => {
      let j = null;
      try { j = JSON.parse(Buffer.concat(kusy).toString('utf8')); } catch { /* ne JSON */ }
      pozadavky.push({ url: req.url, json: j });
      if (!String(req.url).startsWith('/v1/messages')) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); return; }
      if (String(req.url).includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 10 })); return; }
      const zpravy = j?.messages ?? [];
      const nastroj = ['Agent', 'Task'].find((n) => (j?.tools ?? []).some((t) => t.name === n));
      const posledni = posledniUzivatelska(zpravy);
      const volat = posledni && vysledkyNastroju(posledni).length === 0 && text(posledni).includes(znacka) && nastroj;
      const model = j?.model ?? 'falesny-model';
      const zaklad = { id: 'msg_falesna', type: 'message', role: 'assistant', model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      if (!j?.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...zaklad, content: [{ type: 'text', text: 'hotovo' }], stop_reason: 'end_turn' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sse(res, 'message_start', { message: { ...zaklad, content: [] } });
      if (volat) {
        sse(res, 'content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_falesne', name: nastroj, input: {} } });
        sse(res, 'content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(vstupNastroje) } });
        sse(res, 'content_block_stop', { index: 0 });
        sse(res, 'message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } });
      } else {
        sse(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        sse(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hotovo' } });
        sse(res, 'content_block_stop', { index: 0 });
        sse(res, 'message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      }
      sse(res, 'message_stop', {});
      res.end();
    });
  });
  await new Promise((vyreseno, selhalo) => { server.once('error', selhalo); server.listen(0, '127.0.0.1', vyreseno); });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    pozadavky,
    zavri: () => new Promise((vyreseno) => { server.close(() => vyreseno()); server.closeAllConnections?.(); }),
    // výsledky nástroje, které Claude Code poslal modelu zpátky (hláška zamítnutí hooku je výsledek s is_error); každé volání
    // nástroje jednou, i když Claude Code stejnou konverzaci pošle víckrát (například pro souhrn)
    vysledkyNastroje: () => [...new Map(pozadavky.flatMap((p) => vysledkyNastroju(posledniUzivatelska(p.json?.messages ?? []))).map((v) => [v.tool_use_id, v])).values()],
    // modely, s nimiž Claude Code volal API (podagent s parametrem model volá API s tímto modelem)
    modely: () => [...new Set(pozadavky.map((p) => p.json?.model).filter(Boolean))],
  };
}

// Spustí proces asynchronně (server v téže smyčce událostí nesmí být blokovaný jako při spawnSync). Na Windows se .cmd a .bat
// obálka spouští přes cmd.exe, jinak Node vrátí EINVAL (stejně jako v spustClaude).
export function spustProces(prikaz, args, { env, cwd, limitMs }) {
  return new Promise((vyreseno) => {
    let p;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(prikaz)) {
      const radek = [prikaz, ...args].map((a) => `"${a.replace(/"/g, '""')}"`).join(' ');
      p = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${radek}"`], { env, cwd, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      p = spawn(prikaz, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    let stdout = '';
    let stderr = '';
    let vyprselo = false;
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    const hlidac = setTimeout(() => { vyprselo = true; p.kill(); }, limitMs);
    p.on('error', (error) => { clearTimeout(hlidac); vyreseno({ status: null, stdout, stderr, error, vyprselo }); });
    p.on('close', (status) => { clearTimeout(hlidac); vyreseno({ status, stdout, stderr, error: undefined, vyprselo }); });
  });
}
