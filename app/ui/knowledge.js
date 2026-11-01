'use strict';
(() => {
  const host = document.getElementById('workspace-dialog');
  const toolbar = document.createElement('div');
  const output = document.createElement('section');
  output.setAttribute('aria-live', 'polite');
  const request = async (route, body) => {
    const response = await window.hive.request(route, body);
    if (response.status >= 400) throw Error(response.value.error);
    return response.value;
  };
  function button(label, action) {
    const b = document.createElement('button'); b.textContent = label; b.type = 'button';
    b.onclick = async () => { try { await action(); } catch(e) { output.textContent = e.message; } };
    toolbar.append(b);
  }
  const mode = document.createElement('select');
  mode.setAttribute('aria-label', 'Knowledge view');
  for (const value of ['timeline', 'table', 'evidence']) {
    const option = document.createElement('option'); option.value = value; option.textContent = value; mode.append(option);
  }
  toolbar.append(mode);
  button('Show knowledge view', async () => {
    const result = await request('/v1/knowledge/view', {query: document.getElementById('workspace-search').value, view:mode.value});
    output.replaceChildren();
    if (mode.value === 'table') {
      const table = document.createElement('table');
      const header = table.insertRow();
      for (const label of ['Date', 'Kind', 'Title', 'State', 'Source']) { const cell=document.createElement('th');cell.textContent=label;header.append(cell); }
      for (const record of result.rows) {
        const row=table.insertRow();
        for(const value of [record.createdAt, record.kind, record.title, record.data.status ?? '', `${record.source.type}: ${record.source.threadId}`]) row.insertCell().textContent=value;
      }
      output.append(table);
    }
    for (const record of result.rows) {
      const article = document.createElement('details');
      const title = document.createElement('summary');
      title.textContent = `${record.createdAt} · ${record.kind} · ${record.title}`;
      article.append(title);
      const content = document.createElement('pre');
      content.style.whiteSpace = 'pre-wrap';
      content.textContent = JSON.stringify({current: record.data, source: record.source, originals: record.originals, history: record.history}, null, 2);
      article.append(content);
      if(record.kind === 'interpretation') {
        const toggle = document.createElement('button'); toggle.textContent = 'Deactivate this interpretation';
        toggle.onclick = async () => {
          try {
            const {id,kind,scope,project,title,source,revision,data} = record;
            await request('/v1/brain/save', {id,kind,scope,project,title,source,revision,data:{...data,active:false}});
            toggle.disabled = true;
          } catch(e) { output.textContent = e.message; }
        };
        article.append(toggle);
      }
      output.append(article);
    }
    if (result.truncated) output.append(document.createTextNode('Results limited. Refine the search.'));
  });
  button('Import notes / normalized chats', async () => {
    const picker = document.createElement('input'); picker.type = 'file'; picker.accept = '.json';
    picker.onchange = async () => {
      try {
        if (!picker.files[0]) return;
        if (picker.files[0].size > 60000) throw Error('Split this file into batches below 60 KB.');
        const input = JSON.parse(await picker.files[0].text());
        const preview = await request('/v1/knowledge/import', {...input, dryRun:true});
        output.textContent = JSON.stringify(preview, null, 2);
        const commit = document.createElement('button'); commit.textContent = 'Import previewed entries';
        commit.onclick = async () => { try {
          commit.disabled = true;
          output.textContent = JSON.stringify(await request('/v1/knowledge/import', {...input,dryRun:false}),null,2);
        } catch(e) { output.textContent = e.message; } };
        output.append(commit);
      } catch(e) { output.textContent = e.message; }
    }; picker.click();
  });
  host.append(toolbar, output);
})();
