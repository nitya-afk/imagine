/* Chat UI uses the shared studio helpers defined in index.html. No remote assets. */
(() => {
  const STORAGE_KEY = 'imagine-conversations-v1';
  let chats = [], active, controller, cloudConfigured = false, storageReadable = true;
  const blank = () => ({ id: crypto.randomUUID(), title: 'New conversation', messages: [], draft: '', updatedAt: Date.now() });
  const node = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const copy = async (text, button) => {
    try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; }
    catch { button.textContent = 'Copy unavailable'; }
  };

  // Render a small Markdown subset with DOM nodes; model text never becomes HTML.
  function inline(parent, text) {
    const tokens = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|<https?:\/\/[^\s>]+>)/g;
    let pos = 0;
    for (const match of text.matchAll(tokens)) {
      parent.append(document.createTextNode(text.slice(pos, match.index)));
      const token = match[0];
      if (token.startsWith('`')) parent.append(node('code', '', token.slice(1, -1)));
      else if (token.startsWith('**')) parent.append(node('strong', '', token.slice(2, -2)));
      else if (token.startsWith('*')) { const emphasis = node('em'); inline(emphasis, token.slice(1, -1)); parent.append(emphasis); }
      else {
        const parts = token.startsWith('<') ? [token, token.slice(1, -1), token.slice(1, -1)] : /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
        const link = node('a', '', parts[1]);
        link.href = parts[2]; link.target = '_blank'; link.rel = 'noopener noreferrer';
        parent.append(link);
      }
      pos = match.index + token.length;
    }
    parent.append(document.createTextNode(text.slice(pos)));
  }
  function markdown(parent, text) {
    parent.replaceChildren(); parent.classList.add('markdown');
    const lines = text.split('\n');
    let paragraph, list;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        paragraph = list = null;
        const language = line.replace(/^\s*```/, '').trim();
        const code = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
        const pre = node('pre'), label = node('span', 'code-label', language || 'code');
        const button = node('button', 'copy-code', 'Copy'); button.type = 'button';
        button.onclick = () => copy(code.join('\n'), button);
        pre.append(label, button, node('code', '', code.join('\n'))); parent.append(pre);
      } else if (!line.trim()) { paragraph = list = null; }
      else if (/^#{1,4}\s/.test(line)) {
        paragraph = list = null;
        const heading = node('h3'); inline(heading, line.replace(/^#{1,4}\s+/, '')); parent.append(heading);
      } else if (/^\s*(?:[-*]|\d+\.)\s/.test(line)) {
        paragraph = null;
        const kind = /^\s*\d+\./.test(line) ? 'OL' : 'UL';
        if (!list || list.tagName !== kind) { list = node(kind.toLowerCase()); parent.append(list); }
        const item = node('li'); inline(item, line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '')); list.append(item);
      } else {
        list = null;
        if (!paragraph) { paragraph = node('p'); parent.append(paragraph); } else paragraph.append(node('br'));
        inline(paragraph, line);
      }
    }
  }
  function activity(lines = []) {
    const details = node('details', 'assistant-activity');
    const summary = node('summary', '', 'Response details');
    const items = node('ol'); details.append(summary, items);
    for (const line of lines) items.append(node('li', '', line));
    return { details, summary, items };
  }
  function sourceList(items = []) {
    const list = node('div', 'chat-sources');
    for (const item of items) {
      try {
        const url = new URL(item.url); if (url.protocol !== 'https:' || url.username || url.password) continue;
        const link = node('a', 'chat-source'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.append(node('span', 'source-domain', url.hostname.replace(/^www\./, '')), node('span', 'source-title', item.title || url.hostname), node('span', 'source-kind', item.kind === 'page' ? 'Page read' : 'Search snippet'));
        list.append(link);
      } catch { /* never render unsafe source links */ }
    }
    return list;
  }
  function collectSources(existing, items) {
    for (const item of items || []) {
      if (!item || typeof item.url !== 'string' || typeof item.title !== 'string') continue;
      const old = existing.find(s => s.url === item.url);
      if (!old) existing.push({ title: item.title, url: item.url, kind: item.kind });
      else if (item.kind === 'page') old.kind = 'page';
    }
  }
  function message(role, content, trace = [], error = false, turn) {
    const box = node('article', 'assistant-turn ' + (role === 'user' ? 'user' : 'agent'));
    const body = node('div', 'message-content', content);
    box.append(node('span', 'speaker', role === 'user' ? 'You' : 'Imagine'), body);
    if (role !== 'user') {
      markdown(body, content);
      if (turn?.sources?.length) box.append(sourceList(turn.sources));
      if (trace.length) box.append(activity(trace).details);
      if (turn?.runId) {
        const recover = node('button', 'copy-message', turn.pending ? 'Check saved response' : 'Run details'); recover.type = 'button';
        recover.onclick = () => recoverTurn(turn, recover, box); box.append(recover);
      }
      const button = node('button', 'copy-message', 'Copy response'); button.type = 'button';
      button.onclick = () => copy(content, button); box.append(button);
      if (error) box.dataset.error = 'true';
    }
    $('assistant-messages').append(box);
    return { box, body };
  }
  function scrollToEnd(force = false) {
    const pane = $('chat-scroll');
    if (force || pane.scrollHeight - pane.scrollTop - pane.clientHeight < 180) pane.scrollTop = pane.scrollHeight;
  }
  function saveChats() {
    if (!storageReadable) return;
    if (!chats.includes(active) && (active.messages.length || active.draft)) chats.unshift(active);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ active: active.id, chats }));
      $('chat-storage-status').textContent = 'Conversations saved in this browser.';
    } catch { $('chat-storage-status').textContent = 'Browser storage is full or unavailable. This conversation is not saved.'; }
  }
  function renderList() {
    const list = $('chat-list'); list.replaceChildren();
    const query = $('chat-search').value.trim().toLowerCase();
    const visible = [...chats].sort((a, b) => b.updatedAt - a.updatedAt).filter(chat => !query || [chat.title, ...chat.messages.map(m => m.content)].join('\n').toLowerCase().includes(query));
    for (const chat of visible) {
      const row = node('div', 'chat-list-item' + (chat.id === active.id ? ' active' : ''));
      const select = node('button', 'chat-select', chat.title); select.type = 'button'; select.title = chat.title;
      select.onclick = () => { if (!state.busy) { active = chat; renderConversation(); saveChats(); } };
      const remove = node('button', 'chat-delete', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `Delete ${chat.title}`);
      remove.onclick = async () => {
        if (state.busy || !confirm(`Delete “${chat.title}” from this browser?`)) return;
        for (const id of new Set(chat.messages.map(m => m.runId).filter(Boolean))) {
          try { const res = await api('/api/assistant/runs/' + encodeURIComponent(id), { method: 'DELETE' }); if (!res.ok) throw new Error(); }
          catch { $('chat-storage-status').textContent = 'Could not delete the local run record. Conversation was preserved; try again.'; return; }
        }
        chats = chats.filter(c => c.id !== chat.id);
        if (active.id === chat.id) active = blank();
        saveChats(); renderConversation();
      };
      row.append(select, remove); list.append(row);
    }
    if (!visible.length) list.append(node('div', 'chat-empty', query ? 'No matching conversations.' : 'Your next idea starts here.'));
  }
  function resizeComposer() {
    const input = $('assistant-prompt'); input.style.height = 'auto'; input.style.height = Math.min(180, Math.max(62, input.scrollHeight)) + 'px';
  }
  function renderConversation() {
    $('assistant-messages').replaceChildren();
    $('assistant-intro').hidden = active.messages.length > 0;
    for (const turn of active.messages) message(turn.role, turn.content, turn.trace, turn.error, turn);
    $('assistant-prompt').value = active.draft || '';
    $('chat-heading').textContent = active.title;
    renderList(); resizeComposer(); scrollToEnd(true);
    document.body.classList.remove('sidebar-open'); $('sidebar-toggle').setAttribute('aria-expanded', 'false');
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const data = JSON.parse(stored);
      if (!Array.isArray(data.chats) || !data.chats.every(c => c && typeof c.id === 'string' && typeof c.title === 'string' && Number.isFinite(c.updatedAt) && Array.isArray(c.messages) && c.messages.every(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && (!m.trace || Array.isArray(m.trace) && m.trace.every(t => typeof t === 'string'))))) throw new Error('Invalid conversation data');
      chats = data.chats; active = chats.find(c => c.id === data.active);
    }
  } catch { storageReadable = false; $('chat-storage-status').textContent = 'Saved chats could not be read. Existing data was preserved; new chats are not saved.'; }
  active ??= blank(); renderConversation();
  async function recoverTurn(turn, button, box) {
    if (state.busy) return;
    button.disabled = true;
    try {
      const res = await api('/api/assistant/runs/' + encodeURIComponent(turn.runId)); if (!res.ok) throw new Error((await res.json()).error);
      const run = await res.json();
      if (turn.pending && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state)) {
        turn.pending = false; turn.error = run.state !== 'completed';
        turn.content = run.answer || `${run.error || 'Run stopped.'}\n\nNo computer actions or messages were automatically replayed.`;
        turn.sources = []; run.events.filter(e => e.type === 'sources').forEach(e => collectSources(turn.sources, e.results));
        turn.trace = run.events.map(e => e.message || (e.type === 'sources' ? `Sources: ${e.provider} · ${e.coverage}` : e.type === 'tool' ? `Using ${e.name}` : e.type === 'route' ? `${e.provider} · ${e.model}` : '')).filter(Boolean);
        saveChats(); renderConversation(); return;
      }
      box.querySelector('.run-state')?.remove();
      box.append(node('p', 'run-state', `Run ${run.id.slice(0, 8)} · ${run.state} · ${new Date(run.updatedAt).toLocaleString()}${turn.pending ? '. Still active or queued; check again shortly.' : ''}`));
    } catch (error) { button.textContent = `Unavailable: ${error.message}`; }
    finally { button.disabled = false; }
  }
  $('new-chat').onclick = () => {
    if (state.busy) return;
    active.draft = $('assistant-prompt').value; saveChats(); active = blank(); renderConversation(); $('assistant-prompt').focus();
  };
  $('chat-search').oninput = renderList;
  $('sidebar-toggle').onclick = () => { const open = document.body.classList.toggle('sidebar-open'); $('sidebar-toggle').setAttribute('aria-expanded', String(open)); };
  $('assistant-stage').onclick = () => { document.body.classList.remove('sidebar-open'); $('sidebar-toggle').setAttribute('aria-expanded', 'false'); };
  let draftTimer;
  $('assistant-prompt').oninput = () => {
    active.draft = $('assistant-prompt').value; resizeComposer();
    clearTimeout(draftTimer); draftTimer = setTimeout(() => { saveChats(); renderList(); }, 400);
  };
  window.addEventListener('pagehide', () => { active.draft = $('assistant-prompt').value; saveChats(); });
  $('assistant-prompt').onkeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!state.busy) $('assistant').requestSubmit(); }
  };
  document.querySelectorAll('[data-suggestion]').forEach(button => { button.onclick = () => { $('assistant-prompt').value = button.dataset.suggestion; $('assistant-prompt').dispatchEvent(new Event('input')); $('assistant-prompt').focus(); }; });
  const settings = $('assistant-settings');
  $('assistant-settings-open').onclick = () => settings.showModal();
  $('assistant-settings-close').onclick = () => settings.close();
  settings.addEventListener('click', event => { if (event.target === settings) settings.close(); });
  function updateRoute() {
    const mode = $('assistant-mode').value;
    $('assistant-tier').disabled = mode === 'local'; $('assistant-input-cap').disabled = mode === 'local';
    $('assistant-cloud-history').disabled = mode === 'local'; $('assistant-model').disabled = mode === 'frontier';
    $('assistant-route-note').textContent = mode === 'local' ? 'Replies run on this Mac. Internet lookup contacts public sites when enabled.'
      : mode === 'smart' ? cloudConfigured ? 'Simple requests stay local. More complex text can go to OpenAI after approval.' : 'No cloud key configured: Smart stays local.'
      : cloudConfigured ? 'Text chat through OpenAI, with approval each time. Local tools are available in Local mode.' : 'Set OPENAI_API_KEY and restart Imagine to use Frontier.';
    const name = $('assistant-model').value.replace(':latest', '').replace('qwen3.5:', 'Qwen 3.5 ').replace('huihui_ai/', '').replace(/(\d+)b$/, '$1B');
    $('assistant-model-summary').textContent = mode === 'local' ? `${name || 'Local model'} · Local` : mode === 'smart' ? 'Smart routing' : `${$('assistant-tier').selectedOptions[0].textContent} · Frontier`;
    $('composer-hint').textContent = (mode === 'local' ? 'Replies on your Mac' : 'Cloud requests need your approval') + ' · Enter to send · Shift + Enter for a new line';
    for (const id of ['assistant-workers', 'assistant-project', 'assistant-computer', 'assistant-whatsapp', 'assistant-deep']) $(id).disabled = mode === 'frontier';
  }
  for (const id of ['assistant-mode', 'assistant-model', 'assistant-tier']) $(id).onchange = updateRoute;
  async function loadModels() {
    const select = $('assistant-model');
    try {
      const res = await api('/api/assistant/models'); if (!res.ok) throw new Error();
      const info = await res.json();
      select.replaceChildren();
      for (const model of info.models) { const option = node('option', '', `${model.name} · ${(model.size / 1e9).toFixed(1)} GB`); option.value = model.name; select.append(option); }
      if (info.defaultModel) select.value = info.defaultModel;
      if (info.projectDir) $('assistant-project-path').textContent = info.projectDir;
      if (!info.models.length) select.append(new Option('Install qwen3.5:4b in Ollama first', 'qwen3.5:4b'));
    } catch { select.replaceChildren(new Option('qwen3.5:4b · Ollama unavailable', 'qwen3.5:4b')); }
    updateRoute();
  }
  async function loadRouter() {
    try {
      const res = await api('/api/assistant/router'); if (!res.ok) throw new Error();
      const info = await res.json(); cloudConfigured = info.configured;
      $('assistant-budget').textContent = info.configured ? `Cloud session: ${info.sessionTokens.toLocaleString()} / ${info.sessionLimit.toLocaleString()} tokens. Provider billing limits are separate.` : 'Cloud off. Set OPENAI_API_KEY before starting Imagine to enable it.';
    } catch { $('assistant-budget').textContent = 'Cloud status unavailable.'; }
    updateRoute();
  }
  async function loadMemory() {
    const list = $('assistant-memory-list');
    try {
      const res = await api('/api/assistant/memory'); if (!res.ok) throw new Error();
      const { memories } = await res.json(); list.replaceChildren();
      if (!memories.length) list.textContent = 'Nothing saved yet. Ask Imagine to remember something.';
      for (const item of memories) {
        const row = node('div'), remove = node('button', '', 'Remove'); remove.type = 'button';
        remove.onclick = async () => { const result = await api('/api/assistant/memory/' + encodeURIComponent(item.id), { method: 'DELETE' }); if (result.ok) loadMemory(); };
        row.append(node('span', '', item.text), remove); list.append(row);
      }
    } catch { list.textContent = 'Saved memory could not be loaded.'; }
  }
  $('assistant-memory-toggle').onclick = () => { const list = $('assistant-memory-list'); list.hidden = !list.hidden; if (!list.hidden) loadMemory(); };
  async function loadWhatsApp() {
    try {
      const res = await api('/api/assistant/whatsapp'); if (!res.ok) return;
      const info = await res.json();
      $('whatsapp-status').textContent = info.state === 'connected' ? 'WhatsApp connected on this Mac.' : info.state === 'qr' ? 'Scan this in WhatsApp → Linked devices.' : info.state === 'connecting' ? 'Waiting for WhatsApp…' : 'WhatsApp is not connected.';
      $('whatsapp-qr').hidden = !info.qr; if (info.qr) $('whatsapp-qr').src = info.qr;
      $('whatsapp-connect').hidden = ['connected', 'connecting', 'qr'].includes(info.state);
    } catch { $('whatsapp-status').textContent = 'WhatsApp status unavailable.'; }
  }
  $('whatsapp-connect').onclick = async () => {
    $('whatsapp-status').textContent = 'Starting WhatsApp pairing…';
    try { const res = await api('/api/assistant/whatsapp/connect', { method: 'POST' }); if (!res.ok) throw new Error((await res.json()).error); loadWhatsApp(); }
    catch (error) { $('whatsapp-status').textContent = `Could not connect: ${error.message}`; }
  };
  setInterval(() => { if (settings.open) loadWhatsApp(); }, 4000);
  settings.addEventListener('toggle', () => { if (settings.open) loadWhatsApp(); });

  $('assistant-stop').onclick = () => controller?.abort();
  $('assistant').onsubmit = async event => {
    event.preventDefault(); if (state.busy) return;
    const prompt = $('assistant-prompt').value.trim(); if (!prompt) return;
    clearTimeout(draftTimer);
    const chat = active, prior = chat.messages.filter(m => !m.error && !m.pending), history = prior.slice(-48).map(m => ({ role: m.role, content: m.content }));
    let omitted = prior.length - history.length;
    while (history.length && history[0].role !== 'user') { history.shift(); omitted++; }
    while (history.length && new TextEncoder().encode(JSON.stringify(history)).length > 50_000) {
      history.shift(); omitted++;
      while (history.length && history[0].role !== 'user') { history.shift(); omitted++; }
    }
    if (!chat.messages.length) chat.title = prompt.replace(/\s+/g, ' ').slice(0, 65);
    chat.messages.push({ role: 'user', content: prompt }); chat.draft = ''; chat.updatedAt = Date.now();
    const savedTurn = { role: 'assistant', content: 'Response in progress. If this page reloads, check the saved response.', trace: [], sources: [], pending: true };
    chat.messages.push(savedTurn);
    saveChats(); renderConversation(); $('assistant-messages').lastElementChild?.remove(); setBusy(true);
    $('new-chat').disabled = true; $('assistant-submit').hidden = true; $('assistant-stop').hidden = false;
    controller = new AbortController();
    const trace = [], sources = [], approvals = [], run = activity();
    const liveSources = sourceList();
    run.summary.textContent = 'Thinking…'; $('assistant-messages').append(run.details);
    const response = message('assistant', ''); response.box.hidden = true;
    $('assistant-messages').append(liveSources);
    let answer = '', completed = false, error = false;
    const log = text => { if (trace.at(-1) === text) return; trace.push(text); run.summary.textContent = text; run.items.append(node('li', '', text)); };
    if (omitted) log(`${omitted} older messages omitted to fit the request size. Saved chat is unchanged.`);
    scrollToEnd(true);
    try {
      await stream('/api/assistant/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ prompt, history, model: $('assistant-model').value, mode: $('assistant-mode').value, frontierTier: $('assistant-tier').value, cloudHistory: $('assistant-cloud-history').checked, maxOutputTokens: Number($('assistant-output-cap').value), maxInputTokens: Number($('assistant-input-cap').value), deep: $('assistant-deep').checked, web: $('assistant-web').checked, workers: $('assistant-workers').checked, projectFiles: $('assistant-project').checked, computer: $('assistant-computer').checked, whatsapp: $('assistant-whatsapp').checked }),
      }, ev => {
        if (ev.type === 'run') { savedTurn.runId = ev.id; saveChats(); }
        if (ev.type === 'status') log(ev.message);
        if (ev.type === 'context') log(ev.message);
        if (ev.type === 'retrieval_error') log(`Could not read ${new URL(ev.url).hostname}: ${ev.message}`);
        if (ev.type === 'sources') {
          collectSources(sources, ev.results); savedTurn.sources = [...sources]; saveChats();
          log(`${ev.provider} · ${ev.results?.length || 0} sources${ev.coverage === 'limited' ? ' · limited coverage' : ev.coverage === 'unavailable' ? ' · lookup unavailable' : ''}`);
          for (const attempt of ev.attempts || []) log(`${attempt.provider}: ${attempt.outcome}`);
          liveSources.replaceChildren(...sourceList(sources).childNodes); scrollToEnd();
        }
        if (ev.type === 'route') log(`${ev.provider === 'frontier' ? 'Frontier' : 'Local'} · ${ev.model} · ${ev.reason}`);
        if (ev.type === 'tool') log(`Using ${ev.name.replaceAll('_', ' ')}…`);
        if (ev.type === 'response_start') { answer = ''; response.body.replaceChildren(); response.body.classList.remove('markdown'); response.box.hidden = true; }
        if (ev.type === 'delta') { answer += ev.content; response.body.textContent = answer; response.box.hidden = false; scrollToEnd(); }
        if (ev.type === 'usage') { const usage = `${ev.inputTokens} input / ${ev.outputTokens ?? '?'} output tokens`; log(usage); $('assistant-budget').textContent = `Cloud session: ${ev.sessionTokens.toLocaleString()} / ${ev.sessionLimit.toLocaleString()} tokens · ${usage}`; }
        if (ev.type === 'answer') { answer = ev.content; response.box.hidden = false; markdown(response.body, answer); }
        if (ev.type === 'done') completed = true;
        if (ev.type === 'error') throw new Error(ev.message);
        if (ev.type === 'memory' && !$('assistant-memory-list').hidden) loadMemory();
        if (ev.type === 'approval') {
          run.details.open = true;
          const card = node('div', 'assistant-approval'), allow = node('button', 'approve', 'Allow'), deny = node('button', '', 'Deny');
          allow.type = deny.type = 'button'; card.append(node('p', '', ev.description), allow, deny); run.details.append(card);
          const timer = setTimeout(() => { allow.disabled = deny.disabled = true; card.replaceChildren(node('p', '', 'Approval expired.')); }, 60_000);
          approvals.push({ timer, card });
          const decide = async allowed => {
            clearTimeout(timer); allow.disabled = deny.disabled = true;
            try { const res = await api('/api/assistant/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ev.id, allow: allowed }) }); if (!res.ok) throw new Error(); card.replaceChildren(node('p', '', allowed ? 'Approved.' : 'Denied.')); }
            catch { card.replaceChildren(node('p', '', 'Approval could not be delivered or has expired.')); }
          };
          allow.onclick = () => decide(true); deny.onclick = () => decide(false); scrollToEnd(true);
        }
      });
      if (!completed) throw new Error('The connection ended before the response completed.');
    } catch (caught) {
      error = true;
      answer = controller.signal.aborted ? (answer ? `${answer}\n\nResponse stopped.` : 'Response stopped.') : `Could not finish: ${caught.message}`;
    } finally {
      for (const approval of approvals) { clearTimeout(approval.timer); approval.card.remove(); }
      run.details.remove(); response.box.remove(); liveSources.remove();
      Object.assign(savedTurn, { content: answer || 'The model returned no answer.', trace, sources, error, pending: !completed && !controller.signal.aborted && Boolean(savedTurn.runId) }); chat.updatedAt = Date.now();
      saveChats(); setBusy(false); controller = undefined;
      $('new-chat').disabled = false; $('assistant-submit').hidden = false; $('assistant-stop').hidden = true;
      renderConversation(); $('assistant-prompt').focus();
    }
  };
  loadModels(); loadRouter();
})();
