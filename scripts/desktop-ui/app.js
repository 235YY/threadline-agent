(() => {
  const $ = id => document.getElementById(id);
  const qsa = sel => [...document.querySelectorAll(sel)];

  const state = {
    profile: null,
    ranges: {},
    hasKey: false,
    qqStatus: 'off',
    affect: null,
    limit: null,
    gateway: null,
    mcp: null,
    glassbox: null,
    components: null,
    wizardStep: 1,
    wizardSkin: 'chatgpt',
    geekProvenance: false,
    pollTimer: null,
    quickResult: null,
    roster: null,
    activeProposalId: null,
    createState: null,
    safeMode: new URLSearchParams(window.location.search).get('safe') === '1',
    communityChannels: [],
    attachments: [],
    starGraph: {nodes: [], edges: []},
    selectedStar: null,
  };


  function openDialog({title = '提示', message = '', fields = [], okText = '确定'} = {}) {
    return new Promise(resolve => {
      $('dlgTitle').textContent = title;
      $('dlgMessage').textContent = message;
      $('dlgMessage').hidden = !message;
      const box = $('dlgFields'); box.innerHTML = '';
      const inputs = [];
      for (const f of fields) {
        const lbl = document.createElement('label');
        lbl.textContent = f.label || '';
        const el = f.multiline ? document.createElement('textarea') : document.createElement('input');
        if (!f.multiline) el.type = f.type || 'text';
        else el.rows = 3;
        el.value = f.value ?? '';
        el.placeholder = f.placeholder || '';
        el.dataset.fieldKey = f.key;
        lbl.appendChild(el);
        box.appendChild(lbl);
        inputs.push(el);
      }
      $('dlgOkBtn').textContent = okText;
      $('inAppDialog').hidden = false;
      setTimeout(() => (inputs[0] || $('dlgOkBtn')).focus(), 40);

      const cleanup = result => {
        $('inAppDialog').hidden = true;
        $('dlgOkBtn').onclick = null;
        $('dlgCancelBtn').onclick = null;
        $('dlgCloseBtn').onclick = null;
        resolve(result);
      };
      $('dlgOkBtn').onclick = () => {
        if (!inputs.length) return cleanup(true);
        const vals = {};
        for (const el of inputs) vals[el.dataset.fieldKey] = el.value;
        cleanup(vals);
      };
      $('dlgCancelBtn').onclick = () => cleanup(null);
      $('dlgCloseBtn').onclick = () => cleanup(null);
    });
  }

  function updateEmptyHero() {
    const hero = $('emptyHero');
    if (!hero) return;
    const hasMsgs = $('chatLog').querySelectorAll('.msg.user, .msg.bot').length > 0;
    hero.classList.toggle('hidden', hasMsgs);
    const h = new Date().getHours();
    const greet = h < 6 ? '夜深了，还没睡吗？' : h < 12 ? '早上好，今天想聊点什么？' : h < 18 ? '下午好，随时可以聊几句' : '晚上好，今天过得怎么样？';
    $('heroGreeting').textContent = greet;
    const av = $('heroAvatar');
    const url = state.profile?.ui?.avatarDataUrl;
    if (url) { av.textContent = ''; av.style.backgroundImage = `url("${url}")`; }
    else { av.textContent = ''; av.style.backgroundImage = 'url("icon.png")'; }
  }

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2600);
  }

  async function apiGet(path) {
    const res = await fetch(path, {cache: 'no-store'});
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'REQUEST_FAILED');
    return data;
  }

  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'REQUEST_FAILED');
    return data;
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 KB';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function extractAccentFromDataUrl(dataUrl) {
    return new Promise(resolve => {
      if (!dataUrl) return resolve('');
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = 24; c.height = 24;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, 24, 24);
          const data = ctx.getImageData(0, 0, 24, 24).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 140) continue;
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            if (lum < 30 || lum > 235) continue;
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
          }
          if (!n) return resolve('');
          const mix = v => Math.round((v / n) * 0.78 + 70 * 0.22);
          resolve('#' + [mix(r), mix(g), mix(b)].map(x => Math.max(40, Math.min(185, x)).toString(16).padStart(2, '0')).join(''));
        } catch { resolve(''); }
      };
      img.onerror = () => resolve('');
      img.src = dataUrl;
    });
  }

  function hexToSoftRgba(hex, alpha = 0.14) {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return '';
    return `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${alpha})`;
  }

  function switchView(viewName) {
    qsa('.nav-item[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === viewName));
    qsa('.vsc-tab').forEach(t => t.classList.toggle('active', t.dataset.vscTab === viewName));
    qsa('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + viewName));
    if (viewName === 'memory') { void refreshAll(); setTimeout(() => void refreshStarMap(), 60); }
    if (viewName === 'settings') { void refreshComponents(false); void refreshStorage(); }
  }

  function applyVisualUi(ui, charName) {
    const cfg = ui || {};
    const skin = cfg.skin || 'chatgpt';
    document.documentElement.dataset.skin = skin;
    document.documentElement.dataset.theme = cfg.theme || 'paper';
    document.documentElement.dataset.layout = cfg.layout || 'minimal';

    qsa('[data-skin-pick]').forEach(b => b.classList.toggle('active', b.dataset.skinPick === skin));
    qsa('[data-skin-card]').forEach(b => b.classList.toggle('active', b.dataset.skinCard === skin));

    const root = document.documentElement.style;
    root.setProperty('--radius-bubble', `${cfg.bubbleRadius ?? 18}px`);
    root.setProperty('--font-size', `${cfg.fontSize ?? 15}px`);
    root.setProperty('--bg-blur', `${cfg.bgBlur ?? 12}px`);
    root.setProperty('--bg-opacity', String(cfg.bgOpacity ?? 0.14));
    root.setProperty('--bg-image', cfg.bgDataUrl ? `url("${cfg.bgDataUrl}")` : 'none');
    const bgVid = $('bgVideoLayer');
    if (cfg.bgVideoDataUrl) {
      if (bgVid.src !== cfg.bgVideoDataUrl) bgVid.src = cfg.bgVideoDataUrl;
      bgVid.hidden = false;
    } else {
      bgVid.hidden = true; bgVid.removeAttribute('src');
    }
    $('avatarStage').classList.toggle('open', Boolean(cfg.avatarStageOpen));
    $('toggleAvatarStageBtn').classList.toggle('active', Boolean(cfg.avatarStageOpen));
    $('stageCharName').textContent = charName || 'Threadline';
    const stageFrame = $('avatarStageFrame'), stageImg = $('avatarStageImg');
    if (cfg.avatarStageUrl) {
      if (stageFrame.src !== cfg.avatarStageUrl) stageFrame.src = cfg.avatarStageUrl;
      stageFrame.hidden = false; stageImg.hidden = true;
      $('avatarStageSub').textContent = '实时数字人画面已接入';
    } else {
      stageFrame.hidden = true; stageImg.hidden = false;
      stageImg.src = cfg.portraitDataUrl || cfg.avatarDataUrl || 'icon.png';
      $('avatarStageSub').textContent = '静态立绘 / 可接入实时数字人';
    }

    if (cfg.accent && /^#[0-9a-fA-F]{6}$/.test(cfg.accent)) {
      root.setProperty('--accent', cfg.accent);
      root.setProperty('--accent-soft', hexToSoftRgba(cfg.accent, 0.14));
    } else {
      root.removeProperty('--accent');
      root.removeProperty('--accent-soft');
    }

    const name = charName || 'Threadline';
    $('charTitle').textContent = name;
    $('sidebarCharName').textContent = name;
    $('portraitName').textContent = name;
    const avatarEl = $('railAvatar');
    if (cfg.avatarDataUrl) {
      avatarEl.textContent = '';
      avatarEl.style.backgroundImage = `url("${cfg.avatarDataUrl}")`;
    } else {
      avatarEl.textContent = '';
      avatarEl.style.backgroundImage = 'url("icon.png")';
    }

    const pImg = $('portraitImg');
    if (cfg.portraitDataUrl || cfg.avatarDataUrl) {
      pImg.src = cfg.portraitDataUrl || cfg.avatarDataUrl;
      pImg.classList.add('ready');
      $('portraitPlaceholder').hidden = true;
    } else {
      pImg.classList.remove('ready');
      $('portraitPlaceholder').hidden = false;
    }

    $('cornerPet').hidden = cfg.layout !== 'pet';
    const petImg = $('petImg');
    const petSrc = cfg.petPack?.image || cfg.avatarDataUrl || '';
    if (petSrc) {
      petImg.src = petSrc;
      petImg.classList.add('ready');
      $('petFallback').hidden = true;
    } else {
      petImg.classList.remove('ready');
      $('petFallback').hidden = false;
    }

    $('glassboxDrawer').classList.toggle('open', Boolean(cfg.showGlassbox));
    $('customThemeLink').href = `custom.css?v=${Date.now()}`;
  }

  function addMessage(role, text, meta = '', bubbles = []) {
    let messageText=text;
    const log = $('chatLog');
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;
    const parts=document.createElement('div');
    parts.className='bubble-parts';
    const renderParts=items=>{
      parts.replaceChildren();
      let nextAt=0;
      const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      for(const item of items){
        const bubble=document.createElement('div');
        bubble.className='bubble';
        bubble.textContent=item.text;
        parts.appendChild(bubble);
        nextAt+=item.delayMs||0;
        if(nextAt&&!reduced){
          bubble.hidden=true;
          setTimeout(()=>{bubble.hidden=false;},nextAt);
        }
      }
    };
    renderParts(bubbles.length?bubbles:[{text:messageText}]);
    wrap.appendChild(parts);
    if (role === 'bot' || role === 'user') {
      const acts = document.createElement('div'); acts.className = 'msg-actions';
      if (meta) { const m = document.createElement('span'); m.className = 'msg-meta'; m.textContent = meta; acts.appendChild(m); }
      const cp = document.createElement('button'); cp.className = 'msg-act-btn'; cp.type = 'button';
      cp.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>复制</span>';
      cp.addEventListener('click', async () => {
        await copyText(messageText, '已复制消息');
        cp.querySelector('span').textContent = '已复制';
        setTimeout(() => { cp.querySelector('span').textContent = '复制'; }, 1500);
      });
      acts.appendChild(cp);
      if (role === 'bot') {
        const regen = document.createElement('button'); regen.className = 'msg-act-btn'; regen.type = 'button';
        regen.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg><span>重新生成</span>';
        regen.addEventListener('click', async () => {
          $('thinkingBar').hidden = false; $('thinkingText').textContent = 'Thinking… 正在重新组织回复';
          try {
            const res = await apiPost('api/chat/regenerate', {});
            messageText=res.text||'…';
            renderParts(res.bubbles?.length?res.bubbles:[{text:messageText}]);
            toast('已重新生成回复');
            await refreshAll();
          } catch (e) { toast('重生成失败：' + e.message); }
          finally { $('thinkingBar').hidden = true; }
        });
        const ed = document.createElement('button'); ed.className = 'msg-act-btn'; ed.type = 'button';
        ed.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg><span>修改</span>';
        ed.addEventListener('click', async () => {
          const dlg = await openDialog({title: '手动修改 TA 的回复', fields: [{key: 'v', label: '修改后内容', value: messageText, multiline: true}]});
          if (!dlg?.v?.trim()) return;
          messageText=dlg.v.trim();
          renderParts([{text:messageText}]);
          await apiPost('api/chat/edit-reply', {text: dlg.v.trim()}).catch(() => {});
          toast('已修改回复内容');
        });
        acts.append(regen, ed);
      }
      const rmBtn = document.createElement('button'); rmBtn.className = 'msg-act-btn'; rmBtn.type = 'button';
      rmBtn.textContent = '删去';
      rmBtn.addEventListener('click', () => { wrap.remove(); updateEmptyHero(); });
      acts.appendChild(rmBtn);
      wrap.appendChild(acts);
    }
    log.appendChild(wrap);
    updateEmptyHero();
    log.scrollTo({top: log.scrollHeight, behavior: 'smooth'});
  }

  function renderStatus() {
    const p = state.profile;
    const gb = state.glassbox;
    let text = p?.live ? '在线 · 准备就绪' : '离线体验模式';
    if (gb?.affect?.initialized && gb.affect.emotions?.length) {
      text = `${p?.live ? '在线' : '离线'} · ${gb.affect.emotions[0].name ?? '平静'}`;
    } else if (gb?.memory?.notes?.length && p?.live) {
      text = `在线 · 已留存 ${gb.memory.notes.length} 条记忆`;
    }
    $('statusText').textContent = text;
    $('portraitMood').textContent = text;

    if (p?.live && state.limit) {
      const est = state.limit.estimate != null ? state.limit.estimate.toFixed(3) : '?';
      $('budgetChip').textContent = `今日 ¥${est} / ¥${p.daily}`;
    } else {
      $('budgetChip').textContent = p?.live ? `预算 ¥${p.daily}/天` : '离线体验';
    }

    // VS Code Status Bar sync
    $('vsbMode').textContent = p?.live ? `Live (${p.reasoning})` : 'Offline';
    $('vsbMem').textContent = `Notes: ${gb?.memory?.notes?.length ?? 0}`;
    $('vsbGw').textContent = state.gateway?.running ? `Gateway: :${state.gateway.port}` : 'Gateway: Off';
    $('vsbMcp').textContent = `MCP: ${state.mcp?.toolCount ?? 0}`;

    if (p?.ui?.showDreamNote && gb?.journals?.length) {
      const latest = gb.journals[0];
      $('dreamBannerText').textContent = `昨晚的梦境小记：${latest.body.slice(0, 48)}${latest.body.length > 48 ? '…' : ''}`;
      $('dreamBanner').hidden = false;
    }
  }

  function renderGlassbox() {
    const gb = state.glassbox;
    if (!gb) return;
    $('gbPinboard').textContent = gb.pinboard?.body || '还没有核心置顶记忆，聊一阵或点「睡前整理」就会生成。';

    const goalsEl = $('gbGoals');
    goalsEl.innerHTML = '';
    const goals = [...(gb.goals?.intents ?? []), ...(gb.goals?.tasks ?? [])];
    if (!goals.length) goalsEl.textContent = '暂无进行中的目标或长链任务';
    else {
      for (const g of goals.slice(0, 8)) {
        const div = document.createElement('div');
        div.className = 'gb-item';
        div.textContent = `[${g.status}] ${g.goal}`;
        goalsEl.appendChild(div);
      }
    }

    const aff = gb.affect;
    $('gbAffectSummary').textContent = aff?.initialized
      ? `Limbic 已激活 (v${aff.revision}) · 模式：${aff.mode ?? 'default'}`
      : (aff?.enabled ? 'Limbic 已启用，等待首次对话初始化' : 'Limbic 深度情感引擎未开启（当前使用轻量体感状态）');
    const drivesEl = $('gbDrives');
    drivesEl.innerHTML = '';
    if (aff?.drives) {
      for (const [k, v] of Object.entries(aff.drives)) {
        const row = document.createElement('div');
        row.className = 'gb-item';
        row.textContent = `${k}: ${typeof v === 'number' ? v.toFixed(2) : JSON.stringify(v)}`;
        drivesEl.appendChild(row);
      }
    } else {
      drivesEl.textContent = '开启 Limbic 后可在这里看到六维内驱力实时变化。';
    }

    const thEl = $('gbThoughts');
    thEl.innerHTML = '';
    if (!(gb.thoughts ?? []).length) thEl.textContent = '聊几句后，这里会实时展示 TA 的思考选项与记忆检索。';
    else {
      for (const d of gb.thoughts.slice(0, 8)) {
        const div = document.createElement('div');
        div.className = 'gb-item';
        div.textContent = `${d.selectedKind ?? 'decision'} · ${d.selectedSummary ?? d.selectedText ?? d.id}`;
        thEl.appendChild(div);
      }
    }

    const officeEl = $('gbOfficeFiles');
    officeEl.innerHTML = '';
    if (!(gb.officeFiles ?? []).length) officeEl.textContent = '书桌还是空的';
    else {
      for (const f of gb.officeFiles) {
        const div = document.createElement('div');
        div.className = 'gb-item';
        div.textContent = f.path;
        officeEl.appendChild(div);
      }
    }

    const seedsEl = $('gbSeeds');
    seedsEl.innerHTML = '';
    if (!(gb.seeds ?? []).length) seedsEl.textContent = '暂无好奇心种子';
    else {
      for (const s of gb.seeds) {
        const div = document.createElement('div');
        div.className = 'gb-item';
        div.textContent = s.body;
        seedsEl.appendChild(div);
      }
    }
  }

  function renderMemory() {
    const gb = state.glassbox;
    if (!gb) return;
    const prov = state.geekProvenance;

    const stEl = $('statesList');
    stEl.innerHTML = '';
    const states = gb.memory?.states ?? [];
    if (!states.length) stEl.innerHTML = '<div class="muted">多聊几句后，TA 会慢慢形成对你的印象与认识。</div>';
    else {
      for (const s of states) {
        const card = document.createElement('div');
        card.className = 'mem-card';
        const body = document.createElement('div'); body.className = 'mem-body'; body.textContent = s.body;
        const foot = document.createElement('div'); foot.className = 'mem-foot';
        const meta = document.createElement('span');
        meta.textContent = prov ? `${s.id} · v${s.revision} · ${s.kind}` : `${s.kind} · v${s.revision}`;
        const btn = document.createElement('button'); btn.className = 'tiny-btn'; btn.textContent = '温柔澄清';
        btn.addEventListener('click', async () => {
          const dlg = await openDialog({title: '温柔澄清', message: '用聊天的方式补充或纠正 TA 对你的印象：', fields: [{key: 'v', label: '想说的话', multiline: true, placeholder: '其实我更喜欢…'}]});
          const suggestion = dlg?.v?.trim();
          if (!suggestion) return;
          try {
            const res = await apiPost('api/memory/state-propose', {id: s.id, suggestion});
            if (res.text) addMessage('bot', res.text, '已回应你的澄清');
            toast('已发给 TA 澄清');
            await refreshAll();
          } catch (e) { toast('发送失败：' + e.message); }
        });
        foot.append(meta, btn);
        card.append(body, foot);
        stEl.appendChild(card);
      }
    }

    const nEl = $('notesList');
    nEl.innerHTML = '';
    const notes = (gb.memory?.notes ?? []).filter(n => !n.id.startsWith('note:journal:'));
    if (!notes.length) nEl.innerHTML = '<div class="muted">还没有小纸条，可以在上方亲手写一条。</div>';
    else {
      for (const n of notes.slice(0, 60)) {
        const card = document.createElement('div'); card.className = 'mem-card';
        const body = document.createElement('div'); body.className = 'mem-body'; body.textContent = n.body;
        const foot = document.createElement('div'); foot.className = 'mem-foot';
        const meta = document.createElement('span');
        meta.textContent = prov ? `${n.id} · v${n.revision} · ${n.kind} (${n.status})` : `${n.kind} · ${n.status}`;
        const editBtn = document.createElement('button'); editBtn.className = 'tiny-btn'; editBtn.textContent = '编辑';
        editBtn.addEventListener('click', async () => {
          const dlg = await openDialog({title: '编辑小纸条', fields: [{key: 'v', label: '记忆内容', value: n.body, multiline: true}]});
          const nextBody = dlg?.v?.trim();
          if (!nextBody || nextBody === n.body) return;
          try {
            await apiPost('api/memory/note-save', {id: n.id, expectedRevision: n.revision, kind: n.kind, body: nextBody, status: n.status, confidence: n.confidence});
            toast('小纸条已更新');
            await refreshAll();
          } catch (e) { toast('保存失败：' + e.message); }
        });
        foot.append(meta, editBtn);
        card.append(body, foot);
        nEl.appendChild(card);
      }
    }

    const jEl = $('journalsList'); jEl.innerHTML = '';
    if (!(gb.journals ?? []).length) jEl.innerHTML = '<div class="muted small">还没有梦境日记，可在玻璃箱点「睡前整理」。</div>';
    else {
      for (const j of gb.journals) {
        const card = document.createElement('div'); card.className = 'mem-card';
        const b = document.createElement('div'); b.className = 'mem-body'; b.textContent = j.body;
        const f = document.createElement('div'); f.className = 'mem-foot'; f.textContent = j.id;
        card.append(b, f); jEl.appendChild(card);
      }
    }

    const tEl = $('traitsList'); tEl.innerHTML = '';
    if (!(gb.traits ?? []).length) tEl.innerHTML = '<div class="muted small">多天相处后，TA 会自动沉淀稳定特质。</div>';
    else {
      for (const t of gb.traits) {
        const card = document.createElement('div'); card.className = 'mem-card';
        const b = document.createElement('div'); b.className = 'mem-body'; b.textContent = t.body;
        card.append(b); tEl.appendChild(card);
      }
    }

    const eEl = $('eventsList'); eEl.innerHTML = '';
    for (const ev of (gb.memory?.events ?? []).slice(0, 40)) {
      const card = document.createElement('div'); card.className = 'mem-card';
      const b = document.createElement('div'); b.className = 'mem-body'; b.textContent = ev.body || '(空事件)';
      const f = document.createElement('div'); f.className = 'mem-foot';
      f.textContent = prov ? `${ev.id} · ${ev.actor ?? ''} · ${ev.scene ?? ''} · 衍生 ${ev.derived?.length ?? 0}` : `${ev.actor ?? '对话'} · ${ev.scene ?? ''}`;
      card.append(b, f); eEl.appendChild(card);
    }
  }

  function populateSettings() {
    const p = state.profile;
    if (!p) return;
    const ui = p.ui || {};
    $('uiTheme').value = ui.theme || 'paper';
    $('uiLayout').value = ui.layout || 'minimal';
    $('uiAutoAccent').checked = ui.autoAccent !== false;
    $('uiAccent').value = /^#[0-9a-fA-F]{6}$/.test(ui.accent || '') ? ui.accent : '#10a37f';
    $('uiBubbleRadius').value = ui.bubbleRadius ?? 18; $('bubbleRadiusVal').textContent = ui.bubbleRadius ?? 18;
    $('uiFontSize').value = ui.fontSize ?? 15; $('fontSizeVal').textContent = ui.fontSize ?? 15;
    $('uiBgBlur').value = ui.bgBlur ?? 12; $('bgBlurVal').textContent = ui.bgBlur ?? 12;
    $('uiBgOpacity').value = Math.round((ui.bgOpacity ?? 0.14) * 100); $('bgOpacityVal').textContent = Math.round((ui.bgOpacity ?? 0.14) * 100);
    $('uiCustomCss').value = ui.customCss || '';

    $('charNameInput').value = p.characterName || 'Threadline';
    $('identityInput').value = p.identity || '';
    $('styleInput').value = p.style || '';
    $('providerBaseUrl').value = p.providerBaseUrl || 'https://api.deepseek.com';
    $('providerModel').value = p.providerModel || '';
    $('liveToggle').checked = Boolean(p.live);
    $('dailyBudget').value = p.daily ?? 5; $('dailyVal').textContent = p.daily ?? 5;
    $('reasoningSelect').value = p.reasoning || 'low';
    $('autoDreamToggle').checked = p.autoDream !== false;
    $('longChainToggle').checked = p.longChain !== false;
    $('officeDeskToggle').checked = p.officeDesk !== false;
    $('windowExploreToggle').checked = Boolean(p.windowExplore);
    $('autonomyToggle').checked = Boolean(p.autonomy);
    $('affectToggle').checked = Boolean(p.affect);
    $('apperceptionToggle').checked = p.apperception !== false;
    $('memoryEnabledToggle').checked = p.memoryEnabled !== false;
    $('contextModeSelect').value = p.contextMode || 'dynamic-mind';
    if ($('wireLayoutSelect')) $('wireLayoutSelect').value = p.wireLayout || 'legacy';
    $('customContextTokens').value = p.customContextTokens ?? 32000;
    $('ctxTokensVal').textContent = p.customContextTokens ?? 32000;
    const cmLabels = {'dynamic-mind': '动态心智', 'long-agent': '轻量 Agent', 'custom': `自定义 ${Math.round((p.customContextTokens ?? 32000)/1000)}K`};
    $('quickModeLabel').textContent = cmLabels[p.contextMode || 'dynamic-mind'] || '动态心智';
    $('fusionToggle').checked = Boolean(p.fusion);
    $('pythonPath').value = p.python || '';
    $('tzMinutes').value = p.timezoneMinutes ?? 480;

    const slEl = $('limbicSliders'); slEl.innerHTML = '';
    for (const [key, [min, max]] of Object.entries(state.ranges || {})) {
      const val = p.parameters?.[key] ?? ((min + max) / 2);
      const wrap = document.createElement('label');
      wrap.textContent = `${key} (${Number(val).toFixed(2)})`;
      const input = document.createElement('input');
      input.type = 'range'; input.min = min; input.max = max; input.step = (max - min) / 40;
      input.value = val; input.dataset.limbicKey = key;
      input.addEventListener('input', () => { wrap.firstChild.textContent = `${key} (${Number(input.value).toFixed(2)})`; });
      wrap.appendChild(input); slEl.appendChild(wrap);
    }

    const gw = p.gateway || {};
    $('gwEnabled').checked = Boolean(gw.enabled);
    $('gwPort').value = gw.port ?? 18792;
    $('gwModelName').value = gw.modelName || 'threadline-brain';
    $('gwApiKey').value = gw.apiKey || '';
    $('gwEmotionTag').checked = Boolean(gw.includeEmotionTag);
    const gwStatus = state.gateway;
    const gwBadge = $('gwBadge');
    gwBadge.textContent = gwStatus?.running ? `通道运行中 :${gwStatus.port}` : '通道未开启';
    gwBadge.classList.toggle('ok', Boolean(gwStatus?.running));
    if (gwStatus?.running) {
      $('gwEndpoints').hidden = false;
      $('gwEndpoints').textContent =
        `OpenAI Base URL: ${gwStatus.baseUrl}/v1\n` +
        `Chat Completions (流式): ${gwStatus.baseUrl}/v1/chat/completions\n` +
        `状态流 (SSE): ${gwStatus.baseUrl}/v1/events`;
    } else {
      $('gwEndpoints').hidden = true;
    }

    $('mcpConfigInput').value = JSON.stringify(p.mcp || {mcpServers: {}}, null, 2);
    $('mcpBadge').textContent = `${state.mcp?.toolCount ?? 0} 个工具`;
    const mcpList = $('mcpStatusList'); mcpList.innerHTML = '';
    for (const s of state.mcp?.servers ?? []) {
      const div = document.createElement('div'); div.className = 'gb-item';
      div.textContent = `${s.id} (${s.transport}) · ${s.state} · ${s.toolCount} 个工具${s.error ? ' · ' + s.error : ''}`;
      mcpList.appendChild(div);
    }

    $('qqBot').value = p.qq?.bot || ''; $('qqOwner').value = p.qq?.owner || '';
    $('qqHome').value = p.qq?.home || ''; $('qqSdk').value = p.qq?.sdk || '';
    $('qqBadge').textContent = state.qqStatus;
    $('mirrorSelect').value = ui.mirror || 'cn';
    $('modalMirrorSelect').value = ui.mirror || 'cn';
  }

  function renderComponentList(container, info, checkboxClass) {
    container.innerHTML = '';
    for (const c of info.components || []) {
      const row = document.createElement('label'); row.className = 'comp-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = checkboxClass; cb.value = c.id;
      cb.disabled = c.installed; cb.checked = !c.installed && c.recommended;
      const box = document.createElement('div'); box.className = 'comp-info';
      const title = document.createElement('div'); title.className = 'comp-title';
      title.innerHTML = `<span>${c.name}</span><span class="badge ${c.installed ? 'ok' : ''}">${c.installed ? '已就绪' : c.sizeHint}</span>`;
      const desc = document.createElement('div'); desc.className = 'comp-desc';
      desc.textContent = `${c.benefit}（当前：${c.current} · ${c.requirement}）`;
      box.append(title, desc); row.append(cb, box); container.appendChild(row);
    }
  }

  async function refreshComponents(showModalIfNeeded = false) {
    try {
      const info = await apiGet('api/components');
      state.components = info;
      renderComponentList($('componentsPanelList'), info, 'comp-check-panel');
      renderComponentList($('modalCompList'), info, 'comp-check-modal');
      if (showModalIfNeeded && info.hasMissingRecommended && !state.profile?.ui?.componentPromptDismissed && state.profile?.ui?.onboardingDone) {
        $('componentModal').hidden = false;
      }
    } catch { /* ignore */ }
  }

  async function refreshStorage() {
    try {
      const st = await apiGet('api/storage');
      $('storageStats').innerHTML = `
        <div class="stat-box"><strong>${formatBytes(st.sqliteBytes)}</strong><span>SQLite 主库</span></div>
        <div class="stat-box"><strong>${formatBytes(st.walBytes)}</strong><span>WAL 缓存</span></div>
        <div class="stat-box"><strong>${formatBytes(st.ledgerBytes)}</strong><span>请求账本</span></div>
        <div class="stat-box"><strong>${formatBytes(st.totalBytes)}</strong><span>当前总计</span></div>
      `;
    } catch { /* ignore */ }
  }


  function renderRosterAndPool() {
    const r = state.roster;
    if (!r) return;
    // Sidebar Resident List
    const list = $('residentList');
    list.innerHTML = '';
    for (const res of r.residents || []) {
      const btn = document.createElement('button');
      btn.className = 'roster-item' + (res.id === r.activeResidentId ? ' active' : '');
      btn.title = `${res.name} (${res.roleMode === 'agent' ? '干活 Agent' : '陪伴'})`;
      const av = document.createElement('div');
      av.className = 'roster-av';
      if (res.avatarDataUrl) av.style.backgroundImage = `url("${res.avatarDataUrl}")`;
      else av.textContent = res.name.slice(0, 1).toUpperCase();
      const meta = document.createElement('div');
      meta.className = 'roster-meta';
      const nm = document.createElement('span'); nm.className = 'roster-name'; nm.textContent = res.name;
      const tg = document.createElement('span'); tg.className = 'roster-tag'; tg.textContent = res.roleMode === 'agent' ? 'Agent 工作台' : (res.tagline || '陪伴模式');
      meta.append(nm, tg);
      btn.append(av, meta);
      btn.addEventListener('click', async () => {
        if (res.id === r.activeResidentId) return;
        toast(`正在切换到 ${res.name} 的房间…`);
        try {
          await apiPost('api/residents/switch', {id: res.id});
          document.dispatchEvent(new Event('threadline-resident-change'));
          $('chatLog').innerHTML = '';
          await refreshAll();
          addMessage('sys', `已进入 ${res.name} 的独立房间（记忆与情绪完全隔离）。`);
        } catch (e) { toast('切换失败：' + e.message); }
      });
      list.appendChild(btn);
    }

    // Provider Pool Cards & Dropdowns
    const pool = $('providerPoolList');
    pool.innerHTML = '';
    const fillSelect = (selEl, selectedId) => {
      selEl.innerHTML = '';
      for (const p of r.providers || []) {
        const opt = document.createElement('option');
        opt.value = p.id; opt.textContent = `${p.label} (${p.model || 'default'})${p.hasKey ? ' · 已填 Key' : ''}`;
        if (p.id === selectedId) opt.selected = true;
        selEl.appendChild(opt);
      }
    };
    const activeRes = (r.residents || []).find(x => x.id === r.activeResidentId) || r.residents?.[0];
    fillSelect($('copilotProviderSelect'), r.copilotProviderId);
    fillSelect($('residentProviderSelect'), activeRes?.providerId);
    fillSelect($('newResProvider'), r.providers?.[0]?.id);

    for (const p of r.providers || []) {
      const card = document.createElement('div'); card.className = 'mem-card';
      const head = document.createElement('div'); head.className = 'mem-foot';
      head.innerHTML = `<strong>${p.label}</strong><span class="badge ${p.hasKey ? 'ok' : ''}">${p.hasKey ? '已配 Key' : '未填 Key'}</span>`;
      const body = document.createElement('div'); body.className = 'muted small';
      body.textContent = `${p.baseUrl} · 模型：${p.model || '默认'} · 上限 ¥${p.dailyLimit}/天`;
      const foot = document.createElement('div'); foot.className = 'btn-row';
      const keyBtn = document.createElement('button'); keyBtn.className = 'tiny-btn'; keyBtn.textContent = '填入 / 更新 Key';
      keyBtn.addEventListener('click', async () => {
        const dlg = await openDialog({title: `配置「${p.label}」API Key`, message: '密钥仅存当前内存，绝不写入硬盘。', fields: [{key: 'k', label: 'API Key', type: 'password', placeholder: 'sk-...'}]});
        if (!dlg) return;
        await apiPost('api/providers/save', {provider: p, apiKey: (dlg.k || '').trim()});
        toast('已更新内存中的 API Key');
        await refreshAll();
      });
      foot.appendChild(keyBtn);
      if ((r.providers || []).length > 1) {
        const delBtn = document.createElement('button'); delBtn.className = 'tiny-btn'; delBtn.textContent = '删除';
        delBtn.addEventListener('click', async () => {
          await apiPost('api/providers/delete', {id: p.id});
          toast('已移除模型池条目');
          await refreshAll();
        });
        foot.appendChild(delBtn);
      }
      card.append(head, body, foot);
      pool.appendChild(card);
    }

    // Active Resident Agent Matrix
    if (activeRes) {
      $('residentRoleMode').value = activeRes.roleMode || 'companion';
      
      $('residentWorkspaceDir').value = activeRes.workspaceDir || '';
      const pm = activeRes.permissions || {};
      $('permOfficeRead').checked = pm.officeRead !== false;
      $('permOfficeWrite').checked = pm.officeWrite !== false;
      $('permWsRead').checked = Boolean(pm.workspaceRead);
      $('permWsWrite').checked = Boolean(pm.workspaceWrite);
      $('permWeb').checked = Boolean(pm.webExplore);
      $('permMcpRead').checked = pm.mcpRead !== false;
      $('permMcpWrite').checked = Boolean(pm.mcpWrite);
      $('permApproval').checked = pm.requireApprovalForWrite !== false;
    }
  }



  // Pure zero-dependency PNG tEXt chunk encoder/decoder for Stego Character/Skin Poster Cards
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function embedTextInPng(pngBytes, keyword, text) {
    const kw = new TextEncoder().encode(keyword);
    const val = new TextEncoder().encode(text);
    const chunkData = new Uint8Array(kw.length + 1 + val.length);
    chunkData.set(kw, 0); chunkData[kw.length] = 0; chunkData.set(val, kw.length + 1);
    const typeBytes = new TextEncoder().encode('tEXt');
    const crcBuf = new Uint8Array(4 + chunkData.length);
    crcBuf.set(typeBytes, 0); crcBuf.set(chunkData, 4);
    const chunk = new Uint8Array(12 + chunkData.length);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, chunkData.length);
    chunk.set(typeBytes, 4);
    chunk.set(chunkData, 8);
    dv.setUint32(8 + chunkData.length, crc32(crcBuf));
    // Insert right before IEND (last 12 bytes)
    const out = new Uint8Array(pngBytes.length + chunk.length);
    out.set(pngBytes.subarray(0, pngBytes.length - 12), 0);
    out.set(chunk, pngBytes.length - 12);
    out.set(pngBytes.subarray(pngBytes.length - 12), pngBytes.length - 12 + chunk.length);
    return out;
  }

  function extractTextFromPng(pngBytes, keyword) {
    const dv = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
    let offset = 8;
    const dec = new TextDecoder();
    while (offset + 12 <= pngBytes.length) {
      const len = dv.getUint32(offset);
      const type = dec.decode(pngBytes.subarray(offset + 4, offset + 8));
      if (type === 'tEXt') {
        const data = pngBytes.subarray(offset + 8, offset + 8 + len);
        const sep = data.indexOf(0);
        if (sep > 0 && dec.decode(data.subarray(0, sep)) === keyword) {
          return dec.decode(data.subarray(sep + 1));
        }
      }
      offset += 12 + len;
    }
    return null;
  }

  async function generateStegoPosterPng(pack) {
    const canvas = document.createElement('canvas');
    canvas.width = 900; canvas.height = 540;
    const ctx = canvas.getContext('2d');
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#10a37f';
    ctx.fillStyle = '#faf8f5'; ctx.fillRect(0, 0, 900, 540);
    ctx.fillStyle = accent; ctx.globalAlpha = 0.12;
    ctx.beginPath(); ctx.arc(760, 120, 220, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.08)'; ctx.lineWidth = 2;
    ctx.strokeRect(24, 24, 852, 492);
    ctx.fillStyle = accent; ctx.font = '600 18px sans-serif';
    ctx.fillText('THREADLINE STUDIO · 社区分享卡片（拖入软件即可 1 秒领养）', 54, 78);
    ctx.fillStyle = '#18181b'; ctx.font = '700 42px sans-serif';
    ctx.fillText((pack.meta?.title || '我的数字生命').slice(0, 22), 54, 155);
    ctx.fillStyle = '#52525b'; ctx.font = '400 22px sans-serif';
    ctx.fillText(`创作者：${pack.meta?.author || '社区创作者'}`, 54, 206);
    ctx.fillText((pack.meta?.description || '').slice(0, 40), 54, 250);
    const tags = [
      pack.included?.persona ? '人设与语言包' : null,
      pack.included?.skin ? '外观皮肤' : null,
      pack.included?.extensions ? '创造模式小组件' : null,
      pack.included?.limbic ? 'Limbic 气质' : null,
      pack.included?.notes ? `精选公开记忆 ${pack.notes?.length || 0} 条` : null,
    ].filter(Boolean);
    ctx.fillStyle = accent; ctx.font = '600 18px sans-serif';
    ctx.fillText('包含内容：' + tags.join('  ·  '), 54, 330);
    ctx.fillStyle = '#71717a'; ctx.font = '400 16px sans-serif';
    ctx.fillText('隐私安全：已自动剥离 API Key 与私密数据库  |  #ThreadlineStudio', 54, 476);

    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const raw = new Uint8Array(await blob.arrayBuffer());
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(pack))));
    const stego = embedTextInPng(raw, 'threadline_pack', b64);
    return new Blob([stego], {type: 'image/png'});
  }


  function renderAttachmentChips() {
    const box = $('attachmentChips');
    box.innerHTML = '';
    box.hidden = state.attachments.length === 0;
    state.attachments.forEach((a, idx) => {
      const chip = document.createElement('span'); chip.className = 'att-chip';
      if (a.thumbUrl) { const img = document.createElement('img'); img.src = a.thumbUrl; img.className = 'att-thumb'; chip.appendChild(img); }
      const sp = document.createElement('span'); sp.textContent = a.name; chip.appendChild(sp);
      const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = '×';
      rm.addEventListener('click', () => { state.attachments.splice(idx, 1); renderAttachmentChips(); });
      chip.appendChild(rm); box.appendChild(chip);
    });
  }

  // Interactive Force-Directed Memory Star Map (Zoom, Pan, Drag, Left-Click Detail, Right-Click Context Menu)
  const starView = {zoom: 1, ox: 0, oy: 0, dragging: false, lx: 0, ly: 0, nodes: [], is3D: false, yaw: 0.45, pitch: 0.22};
  const KIND_COLORS = {
    personal_state: '#f59e0b', fact_claim: '#38bdf8', preference: '#f472b6',
    interpretation: '#a78bfa', journal: '#34d399', trait: '#fb7185', dream: '#818cf8',
  };

  async function refreshStarMap() {
    try {
      const g = await apiGet('api/memory/graph');
      state.starGraph = g;
      const canvas = $('starMapCanvas');
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cw = Math.max(400, rect.width || 720), ch = Math.max(360, rect.height || 480);
      canvas.width = cw; canvas.height = ch;
      const oldPos = new Map(starView.nodes.map(n => [n.id, {x: n.x, y: n.y}]));
      starView.nodes = (g.nodes || []).map((n, i) => {
        const prev = oldPos.get(n.id);
        const angle = (i / Math.max(1, g.nodes.length)) * Math.PI * 2;
        const rad = 60 + (i % 6) * 32;
        return {...n, x: prev ? prev.x : cw / 2 + Math.cos(angle) * rad, y: prev ? prev.y : ch / 2 + Math.sin(angle) * rad, vx: 0, vy: 0, z: Math.sin((i + 1) * 1.618) * 140};
      });
      // Lightweight force-directed relaxation (40 ticks) so hubs separate organically
      const byId = new Map(starView.nodes.map(n => [n.id, n]));
      for (let step = 0; step < 40; step++) {
        for (let i = 0; i < starView.nodes.length; i++) {
          const a = starView.nodes[i];
          a.vx += (cw / 2 - a.x) * 0.004; a.vy += (ch / 2 - a.y) * 0.004;
          for (let j = i + 1; j < starView.nodes.length; j++) {
            const b = starView.nodes[j];
            const dx = b.x - a.x || 0.1, dy = b.y - a.y || 0.1;
            const d2 = Math.max(180, dx * dx + dy * dy), f = 680 / d2;
            const d = Math.sqrt(d2);
            a.vx -= (dx / d) * f; a.vy -= (dy / d) * f;
            b.vx += (dx / d) * f; b.vy += (dy / d) * f;
          }
        }
        for (const e of g.edges || []) {
          const a = byId.get(e.from), b = byId.get(e.to);
          if (!a || !b) continue;
          const dx = b.x - a.x, dy = b.y - a.y, f = 0.018;
          a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
        }
        for (const n of starView.nodes) { n.x += n.vx; n.y += n.vy; n.vx *= 0.68; n.vy *= 0.68; }
      }
      drawStarMap();
    } catch { /* ignore */ }
  }

  function projectStar(n, w, h) {
    if (!starView.is3D) return {px: n.x, py: n.y, scale: 1, depth: 0};
    const cx = w / 2, cy = h / 2;
    const x0 = n.x - cx, y0 = n.y - cy, z0 = n.z || 0;
    const cosY = Math.cos(starView.yaw), sinY = Math.sin(starView.yaw);
    const cosP = Math.cos(starView.pitch), sinP = Math.sin(starView.pitch);
    const x1 = x0 * cosY - z0 * sinY;
    const z1 = x0 * sinY + z0 * cosY;
    const y2 = y0 * cosP - z1 * sinP;
    const z2 = y0 * sinP + z1 * cosP;
    const fov = 560;
    const scale = fov / Math.max(120, fov + z2);
    return {px: cx + x1 * scale, py: cy + y2 * scale, scale, depth: z2};
  }

  function drawStarMap() {
    const canvas = $('starMapCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (starView.is3D) {
      ctx.save();
      ctx.translate(w / 2 + starView.ox, h / 2 + starView.oy);
      ctx.scale(starView.zoom, starView.zoom);
      ctx.translate(-w / 2, -h / 2);
      const proj = new Map(starView.nodes.map(n => [n.id, {...projectStar(n, w, h), n}]));
      const q = ($('starSearchInput')?.value || '').trim().toLowerCase();
      ctx.strokeStyle = 'rgba(148, 197, 255, 0.24)';
      ctx.lineWidth = 1.1 / starView.zoom;
      for (const e of state.starGraph.edges || []) {
        const a = proj.get(e.from), b = proj.get(e.to);
        if (!a || !b) continue;
        ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
      }
      const sorted = [...proj.values()].sort((a, b) => b.depth - a.depth);
      for (const item of sorted) {
        const {n, px, py, scale} = item;
        const match = !q || n.body.toLowerCase().includes(q) || n.kind.toLowerCase().includes(q);
        const color = KIND_COLORS[n.kind] || '#93c5fd';
        const baseR = Math.min(13, (n.nodeType === 'personal_state' ? 8.5 : 5.5) + Math.sqrt(n.degree || 0) * 1.4);
        const r = Math.max(2.5, baseR * scale);
        ctx.globalAlpha = (match ? (n.freshness ?? 0.9) : 0.14) * Math.min(1, Math.max(0.35, scale));
        ctx.beginPath(); ctx.arc(px, py, r + 4 * scale, 0, Math.PI * 2); ctx.fillStyle = color + '33'; ctx.fill();
        ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
        if (state.selectedStar?.id === n.id) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2 / starView.zoom; ctx.stroke(); }
        ctx.fillStyle = 'rgba(235, 243, 255, 0.92)';
        ctx.font = `${Math.max(9, 11.5 * scale / Math.sqrt(starView.zoom))}px sans-serif`;
        ctx.fillText(n.label.slice(0, 14) + (n.label.length > 14 ? '…' : ''), px + r + 4, py + 4);
      }
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.translate(w / 2 + starView.ox, h / 2 + starView.oy);
    ctx.scale(starView.zoom, starView.zoom);
    ctx.translate(-w / 2, -h / 2);

    const byId = new Map(starView.nodes.map(n => [n.id, n]));
    const q = ($('starSearchInput')?.value || '').trim().toLowerCase();

    // Draw constellation edges
    ctx.strokeStyle = 'rgba(148, 197, 255, 0.22)';
    ctx.lineWidth = 1.2 / starView.zoom;
    for (const e of state.starGraph.edges || []) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    // Draw glowing memory stars
    for (const n of starView.nodes) {
      const match = !q || n.body.toLowerCase().includes(q) || n.kind.toLowerCase().includes(q);
      const color = KIND_COLORS[n.kind] || '#93c5fd';
      const r = Math.min(13, (n.nodeType === 'personal_state' ? 8.5 : 5.5) + Math.sqrt(n.degree || 0) * 1.4);
      ctx.globalAlpha = match ? (n.freshness ?? 0.9) : 0.16;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 5, 0, Math.PI * 2);
      ctx.fillStyle = color + '33';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (state.selectedStar?.id === n.id) {
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2 / starView.zoom; ctx.stroke();
      }
      ctx.fillStyle = 'rgba(235, 243, 255, 0.9)';
      ctx.font = `${11.5 / Math.sqrt(starView.zoom)}px sans-serif`;
      ctx.fillText(n.label.slice(0, 14) + (n.label.length > 14 ? '…' : ''), n.x + r + 5, n.y + 4);
    }
    ctx.restore();
  }

  function starWorldCoords(canvas, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const sx = (clientX - rect.left) * (canvas.width / rect.width);
    const sy = (clientY - rect.top) * (canvas.height / rect.height);
    const wx = (sx - canvas.width / 2 - starView.ox) / starView.zoom + canvas.width / 2;
    const wy = (sy - canvas.height / 2 - starView.oy) / starView.zoom + canvas.height / 2;
    return {wx, wy, rx: clientX - rect.left, ry: clientY - rect.top};
  }

  function findStarAt(wx, wy) {
    const canvas = $('starMapCanvas');
    const w = canvas?.width || 800, h = canvas?.height || 460;
    for (let i = starView.nodes.length - 1; i >= 0; i--) {
      const n = starView.nodes[i];
      const p = projectStar(n, w, h);
      if (Math.hypot(p.px - wx, p.py - wy) <= (15 * p.scale) / starView.zoom) return n;
    }
    return null;
  }

  function showStarDetail(node) {
    state.selectedStar = node;
    $('starDetailKind').textContent = `${node.nodeType === 'personal_state' ? 'TA 眼里的我' : '记忆节点'} · ${node.kind}`;
    $('starDetailBody').textContent = node.body;
    $('starDetailMeta').textContent = `ID: ${node.id} · v${node.revision} · 关联依据 ${node.evidenceCount} 条`;
    const isNote = node.nodeType === 'note';
    $('starEditBtn').hidden = !isNote;
    $('starMergeBtn').hidden = !isNote;
    $('starArchiveBtn').hidden = !isNote;
    $('starDetailCard').hidden = false;
    drawStarMap();
  }

  async function editStarNode(node) {
    if (!node || node.nodeType !== 'note') return toast('个人状态请通过「TA 眼里的我 → 温柔澄清」自然修改');
    const dlg = await openDialog({title: '编辑记忆节点', fields: [{key: 'v', label: '内容', value: node.body, multiline: true}]});
    if (!dlg?.v?.trim()) return;
    await apiPost('api/memory/note-save', {id: node.id, expectedRevision: node.revision, kind: node.kind === 'journal' || node.kind === 'trait' ? 'interpretation' : node.kind, body: dlg.v.trim(), status: 'current', confidence: node.confidence || 'tentative'});
    toast('已按版本锁安全更新记忆节点');
    await refreshAll(); await refreshStarMap();
  }

  async function mergeStarNode(node) {
    if (!node || node.nodeType !== 'note') return;
    const others = starView.nodes.filter(n => n.nodeType === 'note' && n.id !== node.id);
    if (!others.length) return toast('没有其他可合并的目标节点');
    const sample = others.slice(0, 6).map(o => `${o.id} (${o.label})`).join('\n');
    const dlg = await openDialog({
      title: '安全合并记忆节点',
      message: `将「${node.label}」合并到目标节点（保留双方证据链并归档源节点）。可选目标：\n${sample}`,
      fields: [{key: 'targetId', label: '输入目标节点 ID', value: others[0].id}],
    });
    if (!dlg?.targetId?.trim()) return;
    await apiPost('api/memory/note-merge', {sourceId: node.id, targetId: dlg.targetId.trim()});
    $('starDetailCard').hidden = true;
    toast('已安全合并记忆节点（图谱结构完好）');
    await refreshAll(); await refreshStarMap();
  }

  async function archiveStarNode(node) {
    if (!node || node.nodeType !== 'note') return;
    const ok = await openDialog({title: '归档删除节点', message: `将「${node.label}」标记为历史归档（不再参与日常回忆，但保留底层溯源链，绝不破坏记忆结构）。`, okText: '确认归档'});
    if (!ok) return;
    await apiPost('api/memory/note-archive', {id: node.id});
    $('starDetailCard').hidden = true;
    toast('已安全归档该记忆节点');
    await refreshAll(); await refreshStarMap();
  }



  async function refreshEpochStatus() {
    try {
      const ep = await apiGet('api/context/epoch');
      const grid = $('epochStatsGrid');
      if (grid) {
        grid.innerHTML = `
          <div class="stat-box"><strong>${ep.estimatedCacheHitPercent ?? 0}%</strong><span>估算前缀缓存命中</span></div>
          <div class="stat-box"><strong>${ep.usedTokens ?? 0} / ${ep.maxTokens ?? 32000}</strong><span>今日上下文水位 (${ep.utilizationPercent ?? 0}%)</span></div>
          <div class="stat-box"><strong>${ep.turnsCount ?? 0} 轮</strong><span>今日连续对话 (${ep.epochId})</span></div>
          <div class="stat-box"><strong>${ep.compactionCount ?? 0} 次</strong><span>历史收束次数</span></div>
        `;
      }
      const box = $('yesterdayHandoffBox');
      if (box) {
        if (ep.yesterdayHandoff) {
          box.hidden = false;
          box.textContent = `【昨日交接卷轴 · ${ep.handoffDay || '此前'}】\n${ep.yesterdayHandoff}`;
        } else {
          box.hidden = true;
        }
      }
    } catch {}
  }

  async function refreshSkillsAndTeam() {
    try {
      const sk = await apiGet('api/skills');
      const box = $('skillsList'); box.innerHTML = '';
      if (!(sk.skills || []).length) box.textContent = '暂无专属 Skill，点击右上角即可新增或粘贴 SKILL.md。';
      else {
        for (const s of sk.skills) {
          const row = document.createElement('div'); row.className = 'gb-item';
          const line = document.createElement('div'); line.className = 'mem-foot';
          const lbl = document.createElement('span'); lbl.textContent = `${s.name}${s.description ? ' · ' + s.description : ''}`;
          const acts = document.createElement('div'); acts.className = 'btn-row';
          const tBtn = document.createElement('button'); tBtn.className = 'tiny-btn'; tBtn.textContent = s.enabled ? '停用' : '启用';
          tBtn.addEventListener('click', async () => { await apiPost('api/skills/toggle', {id: s.id, enabled: !s.enabled}); await refreshSkillsAndTeam(); });
          const dBtn = document.createElement('button'); dBtn.className = 'tiny-btn'; dBtn.textContent = '删除';
          dBtn.addEventListener('click', async () => { await apiPost('api/skills/delete', {id: s.id}); await refreshSkillsAndTeam(); });
          acts.append(tBtn, dBtn); line.append(lbl, acts); row.appendChild(line); box.appendChild(row);
        }
      }
    } catch {}
    try {
      const tm = await apiGet('api/team/state');
      $('teamEnabledToggle').checked = Boolean(tm.teamEnabled);
      const box = $('teamOverviewBox'); box.innerHTML = '';
      const info = document.createElement('div'); info.className = 'muted small';
      info.textContent = `共享工作台文件：${(tm.sharedFiles || []).length} 个 · 居民频道消息：${(tm.messages || []).length} 条 · 子 Agent 记录：${(tm.subAgentRuns || []).length} 次`;
      box.appendChild(info);
      for (const m of (tm.messages || []).slice(-4).reverse()) {
        const div = document.createElement('div'); div.className = 'gb-item';
        div.textContent = `[协作] ${m.fromName}：${m.text}`;
        box.appendChild(div);
      }
      for (const r of (tm.subAgentRuns || []).slice(0, 3)) {
        const div = document.createElement('div'); div.className = 'gb-item';
        div.textContent = `[子 Agent · ${r.role}] ${r.output.slice(0, 120)}`;
        box.appendChild(div);
      }
    } catch {}
  }

  function renderCommunity() {
    const list = $('communityChannelsList');
    if (!list) return;
    list.innerHTML = '';
    for (const ch of state.communityChannels || []) {
      const card = document.createElement('div'); card.className = 'channel-card';
      const top = document.createElement('div'); top.className = 'channel-top';
      const name = document.createElement('strong'); name.textContent = ch.name;
      const tag = document.createElement('span'); tag.className = 'channel-tag'; tag.textContent = ch.tag;
      top.append(name, tag);
      const desc = document.createElement('p'); desc.className = 'muted small'; desc.textContent = ch.desc;
      card.append(top, desc);
      if (ch.code) {
        const code = document.createElement('div'); code.className = 'channel-code'; code.textContent = ch.code;
        card.appendChild(code);
      }
      const foot = document.createElement('div'); foot.className = 'btn-row';
      if (ch.url) {
        const a = document.createElement('a'); a.className = 'primary-btn link-as-btn';
        a.href = ch.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = ch.actionLabel || '前往';
        foot.appendChild(a);
      } else if (ch.code) {
        const cp = document.createElement('button'); cp.className = 'primary-btn'; cp.textContent = ch.actionLabel || '复制口令';
        cp.addEventListener('click', () => void copyText(ch.code, `已复制：${ch.code}`));
        foot.appendChild(cp);
      }
      const edit = document.createElement('button'); edit.className = 'soft-btn'; edit.textContent = '编辑入口';
      edit.addEventListener('click', async () => {
        const dlg = await openDialog({
          title: `编辑「${ch.name}」入口`,
          fields: [
            {key: 'url', label: '跳转链接（可选，http:// 或 https://）', value: ch.url || ''},
            {key: 'code', label: '群号 / 频道号 / 话题口令（可选）', value: ch.code || ''},
          ],
        });
        if (!dlg) return;
        const next = state.communityChannels.map(x => x.id === ch.id ? {...x, url: (dlg.url || '').trim(), code: (dlg.code || '').trim()} : x);
        try {
          const saved = await apiPost('api/community/channels', {channels: next});
          state.communityChannels = saved.channels;
          renderCommunity();
          toast('社区入口已更新');
        } catch (e) { toast('保存失败：' + e.message); }
      });
      foot.appendChild(edit);
      card.appendChild(foot);
      list.appendChild(card);
    }

    // Populate selective public notes picker
    const picker = $('shareNotesPicker');
    if (picker && state.glassbox) {
      picker.innerHTML = '';
      const notes = (state.glassbox.memory?.notes || []).filter(n => !n.id.startsWith('note:journal:')).slice(0, 20);
      if (!notes.length) picker.textContent = '当前没有可选小纸条。';
      else {
        for (const n of notes) {
          const lbl = document.createElement('label'); lbl.className = 'comp-row';
          const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'share-note-cb'; cb.value = n.id;
          const sp = document.createElement('span'); sp.textContent = n.body.slice(0, 90);
          lbl.append(cb, sp); picker.appendChild(lbl);
        }
      }
    }
  }

  async function buildCurrentSharePack() {
    const noteIds = qsa('.share-note-cb:checked').map(cb => cb.value);
    const res = await apiPost('api/community/export', {
      title: $('shareTitle').value.trim(),
      author: $('shareAuthor').value.trim(),
      description: $('shareDesc').value.trim(),
      include: {
        persona: $('shareIncPersona').checked,
        skin: $('shareIncSkin').checked,
        extensions: $('shareIncExt').checked,
        limbic: $('shareIncLimbic').checked,
        notes: $('shareIncNotes').checked,
      },
      noteIds,
    });
    return res.pack;
  }

  function renderCreateModeAndSlots() {
    const cs = state.createState;
    if (!cs) return;
    const isSafe = state.safeMode || cs.safeMode;
    $('safeModeBanner').hidden = !isSafe;
    if (isSafe) $('customThemeLink').href = `custom.css?safe=1&v=${Date.now()}`;

    // Render declarative extension slots (skipped in Safe Mode)
    const topSlot = $('slotTopbarBadge'); topSlot.innerHTML = '';
    const roomSlot = $('slotRoomWidgets'); roomSlot.innerHTML = '';
    const activeExts = isSafe ? [] : (cs.extensions || []).filter(e => e.enabled);
    let roomCount = 0;
    for (const ext of activeExts) {
      if (ext.slot === 'topbar-badge') {
        const chip = document.createElement('span');
        chip.className = 'meta-chip';
        chip.textContent = ext.title || ext.name;
        topSlot.appendChild(chip);
      } else {
        roomCount++;
        const card = document.createElement('div'); card.className = 'diy-widget';
        const head = document.createElement('div'); head.className = 'diy-widget-head';
        head.textContent = ext.title || ext.name;
        card.appendChild(head);
        if (ext.kind === 'countdown' && ext.targetDate) {
          const days = Math.ceil((new Date(ext.targetDate + 'T00:00:00').getTime() - Date.now()) / 86400000);
          const p = document.createElement('div');
          p.textContent = days >= 0 ? `距离 ${ext.targetDate} 还有 ${days} 天` : `目标日 ${ext.targetDate} 已过 ${Math.abs(days)} 天`;
          card.appendChild(p);
        } else if (ext.kind === 'pomodoro') {
          let left = (ext.minutes || 25) * 60;
          let timer = null;
          const row = document.createElement('div'); row.className = 'btn-row';
          const disp = document.createElement('strong');
          const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
          disp.textContent = fmt(left);
          const toggle = document.createElement('button'); toggle.className = 'tiny-btn'; toggle.textContent = '开始专注';
          toggle.addEventListener('click', () => {
            if (timer) { clearInterval(timer); timer = null; toggle.textContent = '继续'; return; }
            toggle.textContent = '暂停';
            timer = setInterval(() => {
              left = Math.max(0, left - 1); disp.textContent = fmt(left);
              if (left === 0) { clearInterval(timer); timer = null; toggle.textContent = '重新开始'; toast('番茄钟完成！休息一下吧'); }
            }, 1000);
          });
          row.append(disp, toggle);
          card.appendChild(row);
        } else {
          const p = document.createElement('div'); p.className = 'muted small';
          p.textContent = ext.body || '自定义扩展卡片';
          card.appendChild(p);
        }
        roomSlot.appendChild(card);
      }
    }
    roomSlot.hidden = roomCount === 0;

    // Render Extensions list in Settings
    const extList = $('extensionsList'); extList.innerHTML = '';
    if (!(cs.extensions || []).length) extList.textContent = '暂无自制扩展。打开「软件管家 → 创造模式」即可一键生成。';
    else {
      for (const ext of cs.extensions) {
        const row = document.createElement('div'); row.className = 'gb-item';
        const line = document.createElement('div'); line.className = 'mem-foot';
        const lbl = document.createElement('span'); lbl.textContent = `${ext.name} (${ext.kind} · ${ext.slot})`;
        const actions = document.createElement('div'); actions.className = 'btn-row';
        const tBtn = document.createElement('button'); tBtn.className = 'tiny-btn';
        tBtn.textContent = ext.enabled ? '停用' : '启用';
        tBtn.addEventListener('click', async () => {
          await apiPost('api/create/toggle', {id: ext.id, enabled: !ext.enabled});
          await refreshAll(); toast(ext.enabled ? '已停用扩展' : '已启用扩展');
        });
        const dBtn = document.createElement('button'); dBtn.className = 'tiny-btn'; dBtn.textContent = '卸载';
        dBtn.addEventListener('click', async () => {
          await apiPost('api/create/delete', {id: ext.id});
          await refreshAll(); toast('已卸载扩展（已自动备份快照）');
        });
        actions.append(tBtn, dBtn); line.append(lbl, actions); row.appendChild(line); extList.appendChild(row);
      }
    }

    // Render Time-Machine Snapshots list
    const snapList = $('snapshotsList'); snapList.innerHTML = '';
    if (!(cs.snapshots || []).length) snapList.textContent = '暂无快照。软件管家每次改动前都会自动拍快照。';
    else {
      for (const s of cs.snapshots) {
        const row = document.createElement('div'); row.className = 'gb-item';
        const line = document.createElement('div'); line.className = 'mem-foot';
        const t = new Date(s.createdAt).toLocaleString();
        const lbl = document.createElement('span'); lbl.textContent = `${s.label} · ${t}`;
        const rb = document.createElement('button'); rb.className = 'tiny-btn'; rb.textContent = '回退到此版';
        rb.addEventListener('click', async () => {
          const ok = await openDialog({title: '时光机回退确认', message: `确定回退到「${s.label}」吗？所有记忆与聊天记录完全不受影响。`, okText: '确认回退'});
          if (!ok) return;
          try {
            await apiPost('api/create/rollback', {id: s.id});
            await refreshAll(); toast('已瞬间回退到该快照！');
          } catch (e) { toast('回退失败：' + e.message); }
        });
        line.append(lbl, rb); row.appendChild(line); snapList.appendChild(row);
      }
    }
  }

  function showProposal(proposal) {
    state.activeProposalId = proposal.proposalId;
    $('proposalSummary').textContent = proposal.summary || '配置变更审批卡';
    const rb = $('proposalRiskBadge');
    const rk = proposal.risk || {level: 'low', label: '等待主人许可'};
    rb.textContent = rk.label;
    rb.className = 'badge ' + (rk.level === 'high' ? 'risk-high' : rk.level === 'medium' ? 'risk-medium' : 'ok');
    const box = $('proposalDiffList'); box.innerHTML = '';
    if (!(proposal.changes || []).length) {
      box.textContent = '未检测到有效字段变更。';
    } else {
      for (const c of proposal.changes) {
        const row = document.createElement('div'); row.className = 'diff-row';
        const area = document.createElement('div'); area.className = 'diff-area'; area.textContent = c.area;
        const val = document.createElement('div'); val.textContent = `${c.field}：${c.before}  →  ${c.after}`;
        row.append(area, val); box.appendChild(row);
      }
    }
    $('proposalCard').hidden = false;
  }

  async function refreshAll() {
    const st = await apiGet('api/state');
    state.profile = st.profile; state.ranges = st.ranges || {};
    state.hasKey = st.hasKey; state.qqStatus = st.qqStatus;
    state.affect = st.affect; state.limit = st.limit;
    state.gateway = st.gateway; state.mcp = st.mcp;
    applyVisualUi(state.profile.ui, state.profile.characterName);
    populateSettings();
    try {
      state.glassbox = await apiGet('api/glassbox');
      renderGlassbox();
      renderMemory();
    } catch { /* busy */ }
    try { state.roster = await apiGet('api/roster'); renderRosterAndPool(); } catch {}
    try { state.createState = await apiGet('api/create/state'); renderCreateModeAndSlots(); } catch {}
    try { const cs = await apiGet('api/community/state'); state.communityChannels = cs.channels || []; renderCommunity(); } catch {}
    void refreshSkillsAndTeam();
    void refreshEpochStatus();
    renderStatus();
    updateEmptyHero();
  }

  function collectProfileFromForm() {
    const prev = state.profile;
    const params = {};
    qsa('[data-limbic-key]').forEach(el => {
      const v = Number(el.value);
      if (Number.isFinite(v)) params[el.dataset.limbicKey] = v;
    });
    return {
      ...prev,
      characterName: $('charNameInput').value.trim() || 'Threadline',
      identity: $('identityInput').value.trim() || prev.identity,
      style: $('styleInput').value,
      providerBaseUrl: $('providerBaseUrl').value.trim() || 'https://api.deepseek.com',
      providerModel: $('providerModel').value.trim(),
      live: $('liveToggle').checked,
      daily: Number($('dailyBudget').value) || 5,
      reasoning: $('reasoningSelect').value,
      autoDream: $('autoDreamToggle').checked,
      longChain: $('longChainToggle').checked,
      officeDesk: $('officeDeskToggle').checked,
      windowExplore: $('windowExploreToggle').checked,
      autonomy: $('autonomyToggle').checked,
      affect: $('affectToggle').checked,
      apperception: $('apperceptionToggle').checked,
      memoryEnabled: $('memoryEnabledToggle').checked,
      contextMode: $('contextModeSelect').value,
      wireLayout: $('wireLayoutSelect')?.value || 'legacy',
      customContextTokens: Number($('customContextTokens').value) || 32000,
      fusion: $('fusionToggle').checked && $('affectToggle').checked,
      python: $('pythonPath').value.trim(),
      timezoneMinutes: Number($('tzMinutes').value) || 480,
      parameters: Object.keys(params).length ? params : prev.parameters,
      qq: {bot: $('qqBot').value.trim(), owner: $('qqOwner').value.trim(), home: $('qqHome').value.trim(), sdk: $('qqSdk').value.trim()},
      gateway: {
        enabled: $('gwEnabled').checked,
        port: Number($('gwPort').value) || 18792,
        modelName: $('gwModelName').value.trim() || 'threadline-brain',
        apiKey: $('gwApiKey').value.trim(),
        includeEmotionTag: $('gwEmotionTag').checked,
      },
      ui: {
        ...(prev.ui || {}),
        theme: $('uiTheme').value,
        layout: $('uiLayout').value,
        autoAccent: $('uiAutoAccent').checked,
        accent: $('uiAutoAccent').checked ? (prev.ui?.accent || '') : $('uiAccent').value,
        bubbleRadius: Number($('uiBubbleRadius').value) || 18,
        fontSize: Number($('uiFontSize').value) || 15,
        bgBlur: Number($('uiBgBlur').value) || 12,
        bgOpacity: (Number($('uiBgOpacity').value) || 14) / 100,
        customCss: $('uiCustomCss').value,
        mirror: $('mirrorSelect').value,
      },
    };
  }

  async function saveProfile(nextProfile, key) {
    await apiPost('api/apply', {profile: nextProfile, ...(key !== undefined ? {key} : {})});
    await refreshAll();
  }

  async function applySkin(skin, persist = true) {
    if (!state.profile) return;
    const ui = {...(state.profile.ui || {}), skin};
    if (skin === 'chatgpt') { ui.layout = 'minimal'; ui.showGlassbox = false; }
    else if (skin === 'xhs') { ui.theme = 'paper'; ui.layout = 'portrait'; ui.showGlassbox = false; }
    else if (skin === 'vscode') { ui.theme = 'nightlight'; ui.layout = 'minimal'; ui.showGlassbox = true; }
    state.profile.ui = ui;
    applyVisualUi(ui, state.profile.characterName);
    populateSettings();
    if (persist) await saveProfile(state.profile).catch(() => {});
  }

  async function runUpdateCheck() {
    toast('正在检查 GitHub 最新版本…');
    try {
      const info = await apiGet('api/update-check');
      const body = $('updateModalBody');
      const link = $('updateDownloadLink');
      if (info.hasUpdate) {
        $('updateModalTitle').textContent = `发现新版本 v${info.latestVersion}`;
        body.innerHTML = `<p>当前版本：v${info.currentVersion} → 最新版本：<strong>v${info.latestVersion}</strong></p><p class="muted small">${info.notes || '包含最新功能优化与问题修复。'}</p>`;
        link.href = info.releaseUrl;
        link.hidden = false;
      } else if (info.ok) {
        $('updateModalTitle').textContent = '当前已是最新版本';
        body.innerHTML = `<p>你正在运行最新的 <strong>Threadline Studio v${info.currentVersion}</strong>，无需更新。</p>`;
        link.hidden = true;
      } else {
        $('updateModalTitle').textContent = '暂时无法连接更新服务器';
        body.innerHTML = `<p>当前版本：v${info.currentVersion}。网络检测返回 <code>${info.error}</code>，你可以直接前往 GitHub Releases 页面查看。</p>`;
        link.href = info.releaseUrl;
        link.hidden = false;
      }
      $('updateBoxText').textContent = info.hasUpdate
        ? `发现新版本 v${info.latestVersion}（当前 v${info.currentVersion}）`
        : `当前版本 v${info.currentVersion}${info.ok ? '（已是最新）' : ''}`;
      $('updateModal').hidden = false;
    } catch (e) { toast('检查更新失败：' + e.message); }
  }

  async function copyText(str, okMsg) {
    try { await navigator.clipboard.writeText(str); toast(okMsg); }
    catch { void openDialog({title: '手动复制', fields: [{key: 'v', label: '内容', value: str, multiline: true}], okText: '关闭'}); }
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function startComponentInstall(checkboxClass, mirror) {
    const ids = qsa(`.${checkboxClass}:checked`).map(cb => cb.value);
    if (!ids.length) { toast('未勾选任何组件'); return; }
    await apiPost('api/components/install', {ids, mirror});
    toast('已开始下载所选组件…');
    clearInterval(state.pollTimer);
    const poll = async () => {
      try {
        const job = await apiGet('api/components/job');
        const box = $('installJobBox'); box.innerHTML = '';
        for (const item of job.items || []) {
          const div = document.createElement('div'); div.className = 'gb-item';
          div.textContent = `${item.id} · ${item.percent}% · ${item.message}`;
          box.appendChild(div);
        }
        if (!job.running) { clearInterval(state.pollTimer); await refreshComponents(false); toast('组件处理完成'); }
      } catch { clearInterval(state.pollTimer); }
    };
    await poll();
    state.pollTimer = setInterval(poll, 1200);
  }

  function bindEvents() {

    // Empty Hero starter chips
    qsa('[data-starter]').forEach(btn => {
      btn.addEventListener('click', () => {
        $('chatInput').value = btn.dataset.starter;
        $('chatForm').requestSubmit();
      });
    });

    // Floating scroll-to-bottom button
    const chatLog = $('chatLog');
    chatLog.addEventListener('scroll', () => {
      const dist = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight;
      $('scrollBottomBtn').hidden = dist < 140;
    });
    $('scrollBottomBtn').addEventListener('click', () => chatLog.scrollTo({top: chatLog.scrollHeight, behavior: 'smooth'}));

    // Global Keyboard Shortcuts (Esc closes modals/drawer, Ctrl/Cmd+K opens Copilot, Ctrl/Cmd+B toggles sidebar)
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        ['inAppDialog', 'copilotModal', 'newResidentModal', 'guideModal', 'componentModal', 'updateModal', 'wizardModal']
          .forEach(id => { const el = $(id); if (el && !el.hidden) el.hidden = true; });
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        $('copilotModal').hidden = !$('copilotModal').hidden;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'b' || (e.shiftKey && e.key.toLowerCase() === 's'))) {
        e.preventDefault();
        $('appShell').classList.toggle('sidebar-collapsed');
      }
    });



    // 图四-Style `...` Overflow Menu & Copilot `+` Explore Menu
    $('moreMenuBtn').addEventListener('click', e => { e.stopPropagation(); $('morePopover').hidden = !$('morePopover').hidden; });
    $('copilotPlusBtn').addEventListener('click', e => { e.stopPropagation(); $('copilotPlusMenu').hidden = !$('copilotPlusMenu').hidden; });
    document.addEventListener('click', e => {
      if (!$('morePopover').hidden && !e.target.closest('.more-menu-wrap')) $('morePopover').hidden = true;
      if (!$('copilotPlusMenu').hidden && !e.target.closest('.copilot-plus-wrap')) $('copilotPlusMenu').hidden = true;
    });
    qsa('[data-mp-action]').forEach(btn => btn.addEventListener('click', () => {
      $('morePopover').hidden = true;
      const a = btn.dataset.mpAction;
      if (a === 'team' || a === 'skills') { switchView('settings'); qsa('[data-stab="brain"]')[0].click(); }
      else if (a === 'protocol') { $('copilotModal').hidden = false; qsa('[data-ctab="protocol"]')[0].click(); }
      else if (a === 'create') { $('copilotModal').hidden = false; qsa('[data-ctab="create"]')[0].click(); }
    }));

    // Context Mode KV-Cache Smart Default
    $('customContextTokens').addEventListener('input', e => { $('ctxTokensVal').textContent = e.target.value; });
    $('contextModeSelect').addEventListener('change', e => {
      if (e.target.value === 'long-agent') {
        $('apperceptionToggle').checked = false;
        $('affectToggle').checked = false;
        $('contextCacheHint').textContent = '轻量 Agent 会关闭每轮统觉。缓存排版仍由独立开关控制。';
      } else if (e.target.value === 'custom') {
        $('contextCacheHint').textContent = '按每估算 token 4 字节设置认知文本包上限。图片和模型输出另计。';
      } else {
        $('contextCacheHint').textContent = '动态心智模式：按记忆相关性、时间感与情绪动态拼凑上下文。';
      }
    });

    // Skills & Team & Mindless Sub-Agent actions
    $('compactHalfBtn').addEventListener('click', async () => {
      const r = await apiPost('api/context/compact-half', {});
      await refreshEpochStatus();
      toast(r.compacted ? `已半仓收束 ${r.droppedTurns} 轮对话，保留最近 ${r.keptTurns} 轮` : '当前轮次较少，暂无需压缩');
    });
    $('rolloverEpochBtn').addEventListener('click', async () => {
      const r = await apiPost('api/context/rollover', {});
      await refreshEpochStatus();
      toast(`已生成昨日交接卷轴并开启新周期 (${r.newEpoch})`);
    });
    $('addSkillBtn').addEventListener('click', async () => {
      const dlg = await openDialog({
        title: '新增角色专属 Skill（兼容 SKILL.md）',
        fields: [
          {key: 'name', label: '技能名称', placeholder: '如：论文润色 / 代码审查'},
          {key: 'description', label: '简短说明', placeholder: '何时触发这项技能'},
          {key: 'body', label: '技能指令正文', multiline: true, placeholder: '写出详细步骤或规范…'},
        ],
      });
      if (!dlg?.name?.trim()) return;
      await apiPost('api/skills/save', dlg);
      await refreshSkillsAndTeam();
      toast('已挂载新 Skill');
    });
    $('teamEnabledToggle').addEventListener('change', async e => {
      await apiPost('api/team/toggle', {enabled: e.target.checked});
      await refreshSkillsAndTeam();
      toast(e.target.checked ? '已开启多居民团队协作' : '已关闭团队协作');
    });
    $('sendTeamMsgBtn').addEventListener('click', async () => {
      const dlg = await openDialog({title: '在多居民协作频道留言', fields: [{key: 'text', label: '留言内容（所有居民可见）', multiline: true}]});
      if (!dlg?.text?.trim()) return;
      await apiPost('api/team/message', {text: dlg.text.trim()});
      await refreshSkillsAndTeam();
      toast('已发送到协作频道');
    });
    $('addSharedFileBtn').addEventListener('click', async () => {
      const dlg = await openDialog({
        title: '向共享工作台写入文件',
        fields: [
          {key: 'name', label: '文件名', value: 'shared-note.md'},
          {key: 'content', label: '文件内容', multiline: true},
        ],
      });
      if (!dlg?.name?.trim()) return;
      await apiPost('api/team/file', dlg);
      await refreshSkillsAndTeam();
      toast('已写入共享工作台');
    });
    $('spawnSubAgentBtn').addEventListener('click', async () => {
      const dlg = await openDialog({
        title: '派生无心智轻量工具子 Agent',
        message: '无心智子 Agent 不带情绪与记忆负担，专心帮你快速完成繁重子任务。',
        fields: [
          {key: 'role', label: '子 Agent 角色', value: '通用整理与代码子 Agent'},
          {key: 'task', label: '要执行的任务', multiline: true, placeholder: '描述需要子 Agent 完成的具体工作…'},
        ],
      });
      if (!dlg?.task?.trim()) return;
      toast('正在派生子 Agent 执行…');
      try {
        await apiPost('api/team/subagent', dlg);
        await refreshSkillsAndTeam();
        toast('子 Agent 执行完成，结果已显示在下方');
      } catch (e) { toast('子 Agent 执行失败：' + e.message); }
    });

    // Unified Style Popover
    $('styleMenuBtn').addEventListener('click', e => { e.stopPropagation(); $('stylePopover').hidden = !$('stylePopover').hidden; });
    document.addEventListener('click', e => {
      if (!$('stylePopover').hidden && !e.target.closest('.style-menu-wrap')) $('stylePopover').hidden = true;
      if (!$('starContextMenu').hidden && !e.target.closest('#starContextMenu')) $('starContextMenu').hidden = true;
    });
    $('styleCustomBtn').addEventListener('click', () => { $('stylePopover').hidden = true; switchView('settings'); qsa('[data-stab="appearance"]')[0].click(); });

    // Dynamic Video Wallpaper
    $('bgVideoFile').addEventListener('change', async e => {
      const f = e.target.files?.[0]; if (!f) return;
      if (f.size > 5.5 * 1024 * 1024) { toast('动态壁纸建议小于 5.5 MB 以保持丝滑流畅'); return; }
      state.profile.ui.bgVideoDataUrl = await readFileAsDataUrl(f);
      applyVisualUi(state.profile.ui, state.profile.characterName);
      toast('动态壁纸已预览（点「保存全部更改」持久化）');
    });

    // Virtual Avatar / Digital Human Stage
    const toggleStage = async () => {
      const next = !$('avatarStage').classList.contains('open');
      $('avatarStage').classList.toggle('open', next);
      $('toggleAvatarStageBtn').classList.toggle('active', next);
      if (state.profile) { state.profile.ui.avatarStageOpen = next; void saveProfile(state.profile).catch(() => {}); }
    };
    $('toggleAvatarStageBtn').addEventListener('click', toggleStage);
    $('closeAvatarStageBtn').addEventListener('click', toggleStage);
    $('configAvatarStageBtn').addEventListener('click', async () => {
      const dlg = await openDialog({
        title: '接入实时数字人 / 虚拟形象画面',
        message: '填入本地数字人网页地址（如 Open-LLM-VTuber / VTube Studio Web 地址 http://127.0.0.1:12393），留空则展示当前角色立绘。',
        fields: [{key: 'url', label: '本地数字人页面 URL', value: state.profile?.ui?.avatarStageUrl || '', placeholder: 'http://127.0.0.1:12393'}],
      });
      if (!dlg) return;
      state.profile.ui.avatarStageUrl = (dlg.url || '').trim();
      state.profile.ui.avatarStageOpen = true;
      await saveProfile(state.profile);
      toast('虚拟形象舞台已更新');
    });

    // DSH-Style Room Attachments & Quick Agent Mode
    $('attachFileBtn').addEventListener('click', () => $('attachFileInput').click());
    $('attachFileInput').addEventListener('change', async e => {
      const files = [...(e.target.files || [])].slice(0, 5);
      if (!files.length) return;
      for (const f of files) {
        if (f.type.startsWith('image/')) {
          const thumbUrl = await readFileAsDataUrl(f);
          state.attachments.push({name: f.name, kind: 'image', type: f.type, size: f.size, thumbUrl, summary: `图片附件 ${f.name} (${f.type}, ${formatBytes(f.size)})`});
        } else if (/^(text\/|application\/(json|javascript|xml))|\.(md|txt|json|js|mjs|ts|tsx|py|css|html|csv|yml|yaml|sql|sh|ps1)$/i.test(f.type + ' ' + f.name)) {
          const content = (await f.text()).slice(0, 1800);
          state.attachments.push({name: f.name, kind: 'text', type: f.type || 'text/plain', size: f.size, content});
        } else {
          state.attachments.push({name: f.name, kind: 'binary', type: f.type || 'application/octet-stream', size: f.size, summary: `文件附件 ${f.name} (${formatBytes(f.size)})`});
        }
      }
      renderAttachmentChips();
      toast(`已附加 ${files.length} 个文件`);
      e.target.value = '';
    });
    $('quickModeToggleBtn').addEventListener('click', async () => {
      const order = ['dynamic-mind', 'long-agent', 'custom'];
      const cur = state.profile?.contextMode || 'dynamic-mind';
      const nextMode = order[(order.indexOf(cur) + 1) % order.length];
      const next = {...state.profile, contextMode: nextMode, ...(nextMode === 'long-agent' ? {apperception: false, affect: false} : {})};
      await saveProfile(next);
      toast(nextMode === 'long-agent' ? '已切到轻量 Agent 模式' : nextMode === 'custom' ? '已切到自定义上下文长度模式' : '已切回动态心智上下文模式');
    });
    $('quickPermBtn').addEventListener('click', () => { switchView('settings'); qsa('[data-stab="brain"]')[0].click(); });

    // Full-Page Studio Copilot Workbench
    $('openCopilotToolsBtn').addEventListener('click', () => { $('copilotModal').hidden = false; });
    qsa('[data-cap-prompt]').forEach(btn => btn.addEventListener('click', () => {
      $('copilotFullInput').value = btn.dataset.capPrompt;
      $('copilotFullForm').requestSubmit();
    }));
    qsa('[data-cap-action]').forEach(btn => btn.addEventListener('click', () => {
      $('copilotModal').hidden = false;
      const act = btn.dataset.capAction;
      if (act === 'protocol') qsa('[data-ctab="protocol"]')[0].click();
      else qsa('[data-ctab="create"]')[0].click();
    }));
    $('copilotFullForm').addEventListener('submit', async e => {
      e.preventDefault();
      const instruction = $('copilotFullInput').value.trim(); if (!instruction) return;
      $('copilotFullInput').value = '';
      const log = $('copilotChatLog');
      $('copilotEmptyHero')?.classList.add('hidden');
      const u = document.createElement('div'); u.className = 'msg user'; u.innerHTML = '<div class="bubble"></div>'; u.firstChild.textContent = instruction;
      log.appendChild(u); log.scrollTop = log.scrollHeight;
      toast('软件管家正在思考并生成方案…');
      try {
        const res = await apiPost('api/copilot/ask', {instruction});
        const b = document.createElement('div'); b.className = 'msg bot'; b.innerHTML = '<div class="bubble"></div>'; b.firstChild.textContent = res.reply || '已生成配置提案，请在审批卡确认。';
        log.appendChild(b); log.scrollTop = log.scrollHeight;
        if (res.proposal) { $('copilotModal').hidden = false; showProposal(res.proposal); }
      } catch (err) {
        const b = document.createElement('div'); b.className = 'msg sys'; b.innerHTML = '<div class="bubble"></div>'; b.firstChild.textContent = `管家需要模型池里的 API Key 才能对话（${err.message}），或者你可以直接点下方「外部 AI 协议粘贴」免 Key 使用！`;
        log.appendChild(b);
      }
    });

    // Interactive Memory Star Map Canvas Events
    const starCanvas = $('starMapCanvas');
    starCanvas.addEventListener('wheel', e => {
      e.preventDefault();
      starView.zoom = Math.max(0.45, Math.min(3.2, starView.zoom * (e.deltaY < 0 ? 1.12 : 0.9)));
      drawStarMap();
    }, {passive: false});
    starCanvas.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const {wx, wy} = starWorldCoords(starCanvas, e.clientX, e.clientY);
      const hit = findStarAt(wx, wy);
      starView.lx = e.clientX; starView.ly = e.clientY;
      if (hit) { starView.draggingNode = hit; showStarDetail(hit); }
      else { starView.panning = true; }
    });
    window.addEventListener('mousemove', e => {
      if (starView.draggingNode) {
        starView.draggingNode.x += (e.clientX - starView.lx) / starView.zoom;
        starView.draggingNode.y += (e.clientY - starView.ly) / starView.zoom;
        starView.lx = e.clientX; starView.ly = e.clientY;
        drawStarMap();
      } else if (starView.panning) {
        if (starView.is3D) { starView.yaw += (e.clientX - starView.lx) * 0.008; starView.pitch = Math.max(-1.2, Math.min(1.2, starView.pitch + (e.clientY - starView.ly) * 0.008)); } else { starView.ox += e.clientX - starView.lx; starView.oy += e.clientY - starView.ly; }
        starView.lx = e.clientX; starView.ly = e.clientY;
        drawStarMap();
      }
    });
    window.addEventListener('mouseup', () => { starView.draggingNode = null; starView.panning = false; });
    starCanvas.addEventListener('contextmenu', e => {
      e.preventDefault();
      const {wx, wy, rx, ry} = starWorldCoords(starCanvas, e.clientX, e.clientY);
      const hit = findStarAt(wx, wy);
      if (!hit) return;
      state.selectedStar = hit;
      const menu = $('starContextMenu');
      menu.style.left = `${Math.min(starCanvas.clientWidth - 180, rx)}px`;
      menu.style.top = `${Math.min(starCanvas.clientHeight - 140, ry)}px`;
      menu.hidden = false;
      drawStarMap();
    });
    qsa('#starContextMenu [data-ctx]').forEach(btn => {
      btn.addEventListener('click', () => {
        $('starContextMenu').hidden = true;
        const n = state.selectedStar; if (!n) return;
        if (btn.dataset.ctx === 'inspect') showStarDetail(n);
        if (btn.dataset.ctx === 'edit') void editStarNode(n);
        if (btn.dataset.ctx === 'merge') void mergeStarNode(n);
        if (btn.dataset.ctx === 'archive') void archiveStarNode(n);
      });
    });
    $('closeStarDetailBtn').addEventListener('click', () => { $('starDetailCard').hidden = true; });
    $('starEditBtn').addEventListener('click', () => void editStarNode(state.selectedStar));
    $('starMergeBtn').addEventListener('click', () => void mergeStarNode(state.selectedStar));
    $('starArchiveBtn').addEventListener('click', () => void archiveStarNode(state.selectedStar));
    $('starSearchInput').addEventListener('input', () => drawStarMap());
    $('starResetZoomBtn').addEventListener('click', () => { starView.zoom = 1; starView.ox = 0; starView.oy = 0; starView.yaw = 0.45; starView.pitch = 0.22; drawStarMap(); });
    $('starToggle3DBtn')?.addEventListener('click', () => {
      starView.is3D = !starView.is3D;
      $('starToggle3DBtn').textContent = starView.is3D ? '切回 2D 星图' : '切换 3D 星空';
      drawStarMap();
    });
    const SENSORY_LABELS = {L0: 'L0 闭眼', L1: 'L1 氛围', L2: 'L2 看一眼', L3: 'L3 共屏'};
    async function refreshSensoryUi() {
      try {
        const s = await apiGet('api/sensory/status');
        const btn = $('curtainQuickBtn');
        if (btn) btn.textContent = s.curtain ? '已拉窗帘' : (SENSORY_LABELS[s.effectiveLevel] || 'L0 闭眼');
        if ($('sensoryLevelSelect')) $('sensoryLevelSelect').value = s.globalLevel || 'L0';
        if ($('sensoryCurtainBtn')) $('sensoryCurtainBtn').textContent = s.curtain ? '拉开窗帘恢复感知' : '一键拉窗帘';
        if ($('sensoryAuditText')) {
          $('sensoryAuditText').textContent = s.curtain
            ? '窗帘已拉上：已清空暂存信号，并暂停接收新信号。'
            : `当前有效等级 ${s.effectiveLevel} · 活跃信号 ${s.activeSignals?.length || 0} 条 · 最近审计 ${s.recentAudit?.length || 0} 条`;
        }
      } catch { /* ignore */ }
    }
    void refreshSensoryUi();
    async function refreshLivenessAura() {
      try {
        const lv = await apiGet('api/liveness/state');
        if (lv?.aura) {
          const auraEl = $('avatarStageAura');
          if (auraEl) { auraEl.style.background = `radial-gradient(circle, ${lv.aura.color}, transparent 70%)`; auraEl.style.animationDuration=`${lv.aura.breathSec}s`; }
          const subEl = $('avatarStageSub');
          if (subEl && !state.profile?.ui?.avatarStageUrl) subEl.textContent = lv.aura.caption;
        }
      } catch { /* ignore */ }
    }
    void refreshLivenessAura();
    
    $('curtainQuickBtn')?.addEventListener('click', async () => {
      try {
        const cur = await apiGet('api/sensory/status');
        await apiPost('api/sensory/curtain', {curtain: !cur.curtain});
        await refreshSensoryUi();
        toast(cur.curtain ? '已拉开窗帘' : '已一键拉窗帘，切断全部环境感知');
      } catch (err) { toast('切换失败：' + (err.message || err)); }
    });
    $('sensoryCurtainBtn')?.addEventListener('click', async () => {
      try {
        const cur = await apiGet('api/sensory/status');
        await apiPost('api/sensory/curtain', {curtain: !cur.curtain});
        await refreshSensoryUi();
      } catch (err) { toast('操作失败：' + (err.message || err)); }
    });
    $('sensoryLevelSelect')?.addEventListener('change', async e => {
      try {
        await apiPost('api/sensory/policy', {globalLevel: e.target.value});
        await refreshSensoryUi();
        toast('感官亮度已更新为 ' + e.target.value);
      } catch (err) { toast('保存失败：' + (err.message || err)); }
    });
    $('dreamDigestBtn')?.addEventListener('click', async () => {
      try {
        const d = await apiGet('api/dream-digest');
        const lines = [d.narrative, '', ...(d.highlights || []).map((h, i) => `${i + 1}. [${h.kind}] ${h.text}`)].join('\n');
        await openDialog({title: `${d.residentName} 的本周梦境手记`, message: lines, confirmText: '收下这份回忆'});
      } catch (err) { toast('生成梦境手记失败：' + (err.message || err)); }
    });
    $('exportCapsuleBtn')?.addEventListener('click', async () => {
      const dlg = await openDialog({
        title: '导出加密时空胶囊 (.tlcapsule)',
        message: '胶囊包含私人记忆。请设置独立长口令，并将口令与备份分开保管。',
        fields: [{key: 'pass', label: '加密口令', type: 'password', placeholder: '至少 6 位字符'}],
      });
      if (!dlg?.pass) return;
      try {
        const cap = await apiPost('api/capsule/export', {passphrase: dlg.pass});
        const blob = new Blob([JSON.stringify(cap, null, 2)], {type: 'application/json'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `threadline-${new Date().toISOString().slice(0, 10)}.tlcapsule.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast(`已导出加密时空胶囊（${cap.fileCount} 个文件）`);
      } catch (err) { toast('导出失败：' + (err.message || err)); }
    });
    $('restoreCapsuleBtn')?.addEventListener('click',()=> $('restoreCapsuleFile').click());
    $('restoreCapsuleFile')?.addEventListener('change',async e=>{
      const file=e.target.files[0];e.target.value='';
      if(!file)return;
      if(file.size>129*1024*1024){toast('胶囊超出大小上限');return;}
      const dlg=await openDialog({title:'还原到独立目录',message:'校验通过后会写入独立目录，当前居民继续使用原数据。',
        fields:[{key:'pass',label:'解密口令',type:'password'}]});
      if(!dlg?.pass)return;
      try{
        const capsule=JSON.parse(await file.text());
        const r=await apiPost('api/capsule/restore',{capsule,passphrase:dlg.pass});
        await openDialog({title:'独立副本已还原',message:`共 ${r.restoredFiles} 个文件。保存位置：${r.targetDir}`});
      }catch(err){toast('还原失败：'+err.message);}
    });
    $('issueSensoryClientBtn')?.addEventListener('click',async ()=>{
      const dlg=await openDialog({title:'授权客户端为当前居民推送摘要',
        message:'此凭证仅能推送感官摘要。',fields:[{key:'label',label:'客户端名称',placeholder:'例如 ActivityWatch'}]});
      if(!dlg)return;
      try{
        const client=await apiPost('api/sensory/clients/issue',{label:dlg.label||'本机客户端'});
        await openDialog({title:'客户端凭证',message:`凭证仅显示本次。撤销时使用编号 ${client.clientId}。`,
          fields:[{key:'token',label:'复制此凭证',value:client.token}]});
        await refreshSensoryUi();
      }catch(err){toast('授权失败：'+err.message);}
    });
    $('revokeSensoryClientBtn')?.addEventListener('click',async ()=>{
      const dlg=await openDialog({title:'撤销感官客户端',fields:[{key:'clientId',label:'客户端编号'}]});
      if(!dlg?.clientId)return;
      try{
        const result=await apiPost('api/sensory/clients/revoke',dlg);
        toast(result.ok?'已撤销':'客户端不存在');
        await refreshSensoryUi();
      }catch(err){toast('撤销失败：'+err.message);}
    });
    $('compareWireBtn')?.addEventListener('click', async () => {
      const box = $('wireCompareResult');
      if (!box) return;
      box.hidden = false;
      box.textContent = '正在只读分析账本缓存数据…';
      try {
        const r = await apiGet('api/wire-layout/compare');
        if (!r.ok) { box.textContent = '读取失败：' + (r.error || '未知错误'); return; }
        if (!r.analyzedCount) { box.textContent = '当前还没有带完整用量的已结算请求记录，先聊几轮后再来看对照吧。'; return; }
        const parts = Object.entries(r.byLayout || {}).map(([k, s]) => `${k}: ${s.count}轮 · 命中 ${(s.weightedCacheHitRate * 100).toFixed(1)}% · 中位输入 ${s.medianPromptTokens} · 均价 ¥${(s.avgCostMicros / 1e6).toFixed(5)}`);
        const c = r.apiComparison ?? r.comparison;
        if (c) {
          const hit = c.cacheHitRateDelta === null ? '—' : `${(c.cacheHitRateDelta * 100).toFixed(1)} 个百分点`;
          const cost = c.avgCostPctChange === null ? '—' : `${c.avgCostPctChange}%`;
          parts.push(`${c.scenario==='api-chat'?'API':'QQ'} 对照（旧版 ${c.legacyCount} / 分层 ${c.stagedCount}）：命中率差 ${hit}，请求估算费用变化 ${cost}`);
        } else parts.push('还没有可比较的排版样本');
        box.textContent = `[${r.source}] ` + parts.join(' | ');
      } catch (err) { box.textContent = '查询失败：' + (err.message || err); }
    });
    $('migrateAllMemBtn').addEventListener('click', async () => {
      const others = (state.roster?.residents || []).filter(r => r.id !== state.roster?.activeResidentId);
      if (!others.length) return toast('请先在左侧「+」新建另一个数字生命再迁移记忆');
      const dlg = await openDialog({
        title: '迁移当前记忆到其他数字生命',
        message: '将当前角色的公开笔记安全复制到目标角色目录（不会删除原记忆）。可选目标：' + others.map(o => `${o.id} (${o.name})`).join('、'),
        fields: [{key: 'id', label: '目标角色 ID', value: others[0].id}],
      });
      if (!dlg?.id?.trim()) return;
      const res = await apiPost('api/memory/migrate', {targetResidentId: dlg.id.trim()});
      toast(`已安全迁移 ${res.count} 条记忆到目标角色`);
    });

    // Sidebar collapse & navigation
    $('collapseSidebarBtn').addEventListener('click', () => $('appShell').classList.toggle('sidebar-collapsed'));
    $('expandSidebarBtn').addEventListener('click', () => $('appShell').classList.remove('sidebar-collapsed'));
    qsa('.nav-item[data-view]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
    qsa('.vsc-tab').forEach(tab => tab.addEventListener('click', () => switchView(tab.dataset.vscTab)));

    // 3-Skin Switcher (Topbar & Settings)
    qsa('[data-skin-pick]').forEach(btn => btn.addEventListener('click', () => { $('stylePopover').hidden = true; void applySkin(btn.dataset.skinPick, true); }));
    qsa('[data-skin-card]').forEach(btn => btn.addEventListener('click', () => void applySkin(btn.dataset.skinCard, false)));

    // Sub-tabs helper
    const bindTabs = (attr, prefix) => {
      qsa(`[data-${attr}]`).forEach(btn => {
        btn.addEventListener('click', () => {
          const parent = btn.parentElement;
          parent.querySelectorAll(`[data-${attr}]`).forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const scope = parent.parentElement;
          scope.querySelectorAll(`[id^="${prefix}-"]`).forEach(p => p.classList.remove('active'));
          $(`${prefix}-${btn.dataset[attr]}`).classList.add('active');
        });
      });
    };
    bindTabs('gtab', 'gtab'); bindTabs('mtab', 'mtab'); bindTabs('stab', 'stab'); bindTabs('gtut', 'gtut');
    bindTabs('ctab', 'ctab');
    bindTabs('ptab', 'ptab');
    $('shareIncNotes').addEventListener('change', e => { $('shareNotesPicker').hidden = !e.target.checked; });
    $('exportPackJsonBtn').addEventListener('click', async () => {
      try {
        const pack = await buildCurrentSharePack();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2)], {type: 'application/json'}));
        a.download = `${(pack.meta.title || 'threadline-pack').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')}.tlpack.json`;
        a.click();
        toast('已安全导出分享包（已自动剥离隐私与密钥）');
      } catch (e) { toast('导出失败：' + e.message); }
    });
    $('copyPackJsonBtn').addEventListener('click', async () => {
      try {
        const pack = await buildCurrentSharePack();
        await copyText(JSON.stringify(pack, null, 2), '已复制分享包 JSON');
      } catch (e) { toast('复制失败：' + e.message); }
    });
    $('exportPosterBtn').addEventListener('click', async () => {
      try {
        const pack = await buildCurrentSharePack();
        const pngBlob = await generateStegoPosterPng(pack);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(pngBlob);
        a.download = `${(pack.meta.title || 'threadline-card').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')}-card.png`;
        a.click();
        toast('已生成隐写海报图 PNG！发到小红书/QQ群别人保存拖进来就能领养');
      } catch (e) { toast('生成海报失败：' + e.message); }
    });

    // Import .tlpack.json OR Stego PNG Poster Card -> opens Copilot Approval Preview Card!
    $('importPackBtn').addEventListener('click', () => $('importPackFile').click());
    $('importPackFile').addEventListener('change', async e => {
      const f = e.target.files?.[0]; if (!f) return;
      try {
        let packObj = null;
        if (f.name.toLowerCase().endsWith('.png') || f.type === 'image/png') {
          const bytes = new Uint8Array(await f.arrayBuffer());
          const b64 = extractTextFromPng(bytes, 'threadline_pack');
          if (!b64) throw new Error('这张 PNG 里没有检测到 Threadline 隐写分享数据');
          packObj = JSON.parse(decodeURIComponent(escape(atob(b64))));
        } else {
          packObj = JSON.parse(await f.text());
        }
        const prop = await apiPost('api/community/import-preview', {pack: packObj});
        $('copilotModal').hidden = false;
        showProposal(prop);
        toast('已解析社区作品，请核对审批卡后点允许领养');
      } catch (err) { toast('导入失败：' + err.message); }
      e.target.value = '';
    });

    // GitHub Inspiration & Plugin Market search
    const runMarketSearch = async q => {
      const query = String(q || '').trim(); if (!query) return;
      const box = $('marketResults'); box.innerHTML = '<div class="muted small">正在从 GitHub 拉取开源作品…</div>';
      try {
        const res = await apiPost('api/copilot/search-github', {query});
        const items = res.result?.items || res.result?.repos || [];
        box.innerHTML = '';
        if (!items.length) box.innerHTML = '<div class="muted small">暂未搜到匹配仓库，可以换个关键词试试。</div>';
        else {
          for (const repo of items.slice(0, 8)) {
            const card = document.createElement('div'); card.className = 'mem-card';
            const title = document.createElement('strong'); title.textContent = repo.full_name || repo.name;
            const desc = document.createElement('div'); desc.className = 'muted small'; desc.textContent = repo.description || '开源项目';
            const foot = document.createElement('div'); foot.className = 'mem-foot';
            const stars = document.createElement('span'); stars.textContent = ` ${repo.stargazers_count ?? repo.stars ?? 0}`;
            const a = document.createElement('a'); a.className = 'link-btn'; a.href = repo.html_url || repo.url || '#';
            a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = '查看仓库';
            foot.append(stars, a); card.append(title, desc, foot); box.appendChild(card);
          }
        }
      } catch (err) { box.innerHTML = `<div class="muted small">检索失败：${err.message}</div>`; }
    };
    $('marketSearchBtn').addEventListener('click', () => void runMarketSearch($('marketSearchInput').value));
    qsa('[data-market-q]').forEach(btn => btn.addEventListener('click', () => {
      $('marketSearchInput').value = btn.dataset.marketQ;
      void runMarketSearch(btn.dataset.marketQ);
    }));

    // Safe Mode, Create Mode Presets, GitHub Search & Shell Factory Reset
    $('exitSafeModeBtn').addEventListener('click', () => { window.location.search = ''; });
    $('enterSafeModeBtn').addEventListener('click', () => { window.location.search = '?safe=1'; });
    $('factoryResetShellBtn').addEventListener('click', async () => {
      const ok = await openDialog({title: '恢复默认纯净外壳', message: '将重置外观并清空 DIY 扩展（会自动拍快照备份，绝不影响任何数字生命的记忆、笔记和情绪）。', okText: '确认恢复'});
      if (!ok) return;
      try { await apiPost('api/create/factory-reset', {}); await refreshAll(); toast('已恢复默认纯净外壳（记忆零损伤）'); }
      catch (e) { toast('恢复失败：' + e.message); }
    });
    qsa('[data-create-preset]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const presets = {
          pomodoro: {id: 'pomo-timer', name: '番茄钟小组件', slot: 'room-widget', kind: 'pomodoro', title: '专注番茄钟', minutes: 25},
          countdown: {id: 'bday-countdown', name: '重要日子倒计时', slot: 'room-widget', kind: 'countdown', title: '特别日子倒计时', targetDate: '2026-12-25'},
          notecard: {id: 'daily-memo', name: '每日灵感便签', slot: 'room-widget', kind: 'note-card', title: '今日小目标', body: '写完今天的任务，然后早点休息。'},
        };
        const ext = presets[btn.dataset.createPreset];
        const prop = await apiPost('api/copilot/parse', {text: JSON.stringify({format: 'threadline-patch-v1', summary: `创造模式新增：${ext.name}`, extension: ext})});
        showProposal(prop);
        toast('已生成创造模式审批卡，请确认后热加载');
      });
    });
    $('githubSearchBtn').addEventListener('click', async () => {
      const q = $('githubSearchInput').value.trim();
      if (!q) return;
      toast('管家正在联网检索 GitHub…');
      const box = $('githubSearchResults'); box.textContent = '搜索中…';
      try {
        const res = await apiPost('api/copilot/search-github', {query: q});
        const items = res.result?.items || res.result?.repos || [];
        box.innerHTML = '';
        if (!items.length) box.textContent = '未搜到相关仓库（或当前网络不可达 GitHub）。';
        else {
          for (const repo of items.slice(0, 6)) {
            const card = document.createElement('div'); card.className = 'gb-item';
            const a = document.createElement('a');
            a.href = repo.html_url || repo.url || '#'; a.target = '_blank'; a.rel = 'noopener noreferrer';
            a.textContent = `${repo.full_name || repo.name} ( ${repo.stargazers_count ?? repo.stars ?? 0})`;
            const d = document.createElement('div'); d.className = 'muted small'; d.textContent = repo.description || '';
            card.append(a, d); box.appendChild(card);
          }
        }
      } catch (e) { box.textContent = '检索失败：' + e.message; }
    });


    // New Resident Modal
    $('addResidentBtn').addEventListener('click', () => { $('newResidentModal').hidden = false; });
    $('closeNewResBtn').addEventListener('click', () => { $('newResidentModal').hidden = true; });
    $('cancelNewResBtn').addEventListener('click', () => { $('newResidentModal').hidden = true; });
    $('confirmNewResBtn').addEventListener('click', async () => {
      const name = $('newResName').value.trim();
      if (!name) { toast('请先起个名字'); return; }
      try {
        await apiPost('api/residents/create', {
          name,
          tagline: $('newResTagline').value.trim(),
          roleMode: $('newResRoleMode').value,
          providerId: $('newResProvider').value,
          identity: $('newResIdentity').value.trim(),
          switchNow: true,
        });
        $('newResidentModal').hidden = true;
        $('newResName').value = ''; $('newResTagline').value = ''; $('newResIdentity').value = '';
        $('chatLog').innerHTML = '';
        await refreshAll();
        addMessage('sys', `欢迎新居民「${name}」入住！已为其创建独立记忆与存档。`);
        toast(`已创建并进入 ${name} 的房间`);
      } catch (e) { toast('创建失败：' + e.message); }
    });

    // Multi-API Provider Pool & Agent Matrix
    $('addProviderBtn').addEventListener('click', async () => {
      const dlg = await openDialog({
        title: '新增 API 模型池',
        message: '可同时添加多个服务商，分别分配给不同数字生命和软件管家。',
        fields: [
          {key: 'label', label: '显示名称', placeholder: '如：Claude 中转 / 本地 Qwen'},
          {key: 'baseUrl', label: 'API Base URL', value: 'https://api.openai.com/v1'},
          {key: 'model', label: '默认模型名（可选）', placeholder: '如：gpt-4o-mini'},
          {key: 'apiKey', label: 'API Key（可选，仅存内存）', type: 'password', placeholder: 'sk-...'},
        ],
      });
      if (!dlg || !dlg.label?.trim() || !dlg.baseUrl?.trim()) return;
      const label = dlg.label.trim(), baseUrl = dlg.baseUrl.trim(), model = (dlg.model || '').trim(), apiKey = (dlg.apiKey || '').trim();
      try {
        await apiPost('api/providers/save', {provider: {label, baseUrl, model}, apiKey});
        toast('已添加到模型池');
        await refreshAll();
      } catch (e) { toast('添加失败：' + e.message); }
    });
    $('copilotProviderSelect').addEventListener('change', async e => {
      try { await apiPost('api/providers/copilot', {providerId: e.target.value}); toast('已更新软件管家所用模型'); }
      catch (err) { toast(err.message); }
    });
    $('saveResidentAgentBtn').addEventListener('click', async () => {
      try {
        await apiPost('api/residents/update', {
          roleMode: $('residentRoleMode').value,
          providerId: $('residentProviderSelect').value,
          workspaceDir: $('residentWorkspaceDir').value.trim(),
          permissions: {
            officeRead: $('permOfficeRead').checked,
            officeWrite: $('permOfficeWrite').checked,
            workspaceRead: $('permWsRead').checked,
            workspaceWrite: $('permWsWrite').checked,
            webExplore: $('permWeb').checked,
            mcpRead: $('permMcpRead').checked,
            mcpWrite: $('permMcpWrite').checked,
            requireApprovalForWrite: $('permApproval').checked,
          },
        });
        toast('当前角色工作台与权限已保存');
        await refreshAll();
      } catch (e) { toast('保存失败：' + e.message); }
    });

    // Studio Copilot Modal & Universal Config Protocol
    $('openCopilotBtn').addEventListener('click', () => switchView('copilot'));
    $('closeCopilotBtn').addEventListener('click', () => { $('copilotModal').hidden = true; });
    $('copyProtocolBtn').addEventListener('click', async () => {
      try {
        const res = await apiGet('api/copilot/protocol');
        await copyText(res.protocol, '已复制通用配置协议！直接发给任意外部 AI 即可');
      } catch (e) { toast('获取协议失败：' + e.message); }
    });
    $('parseProtocolBtn').addEventListener('click', async () => {
      try {
        const prop = await apiPost('api/copilot/parse', {text: $('copilotPasteInput').value});
        showProposal(prop);
        toast('解析成功，请核对下方审批卡');
      } catch (e) { toast('解析失败：' + e.message); }
    });
    $('askCopilotBtn').addEventListener('click', async () => {
      const instruction = $('copilotAskInput').value.trim();
      if (!instruction) return;
      toast('软件管家正在分析并生成提案…');
      try {
        const res = await apiPost('api/copilot/ask', {instruction});
        $('copilotReplyBox').hidden = false;
        $('copilotReplyBox').textContent = res.reply || '已生成提案';
        if (res.proposal) showProposal(res.proposal);
      } catch (e) { toast('管家调用失败（请先给管家所用模型填 Key）：' + e.message); }
    });
    $('approveProposalBtn').addEventListener('click', async () => {
      if (!state.activeProposalId) return;
      try {
        await apiPost('api/copilot/approve', {proposalId: state.activeProposalId});
        state.activeProposalId = null;
        $('proposalCard').hidden = true;
        $('copilotModal').hidden = true;
        await refreshAll();
        toast('已按你的许可执行全部配置改动！');
      } catch (e) { toast('执行失败：' + e.message); }
    });
    $('rejectProposalBtn').addEventListener('click', async () => {
      if (state.activeProposalId) await apiPost('api/copilot/reject', {proposalId: state.activeProposalId}).catch(() => {});
      state.activeProposalId = null;
      $('proposalCard').hidden = true;
      toast('已取消本次变更');
    });


    // Smooth Accordions
    qsa('.accordion-trigger').forEach(btn => {
      btn.addEventListener('click', () => btn.closest('.accordion-item').classList.toggle('open'));
    });

    // Glassbox drawer toggle
    const toggleGlass = async () => {
      const next = !$('glassboxDrawer').classList.contains('open');
      $('glassboxDrawer').classList.toggle('open', next);
      if (state.profile) {
        state.profile.ui.showGlassbox = next;
        void saveProfile(state.profile).catch(() => {});
      }
    };
    $('toggleGlassboxBtn').addEventListener('click', toggleGlass);
    $('statusPill').addEventListener('click', toggleGlass);
    $('closeGlassBtn').addEventListener('click', toggleGlass);
    $('refreshGlassBtn').addEventListener('click', () => void refreshAll());

    // Theme toggle
    $('toggleThemeBtn').addEventListener('click', async () => {
      if (!state.profile) return;
      state.profile.ui.theme = state.profile.ui.theme === 'nightlight' ? 'paper' : 'nightlight';
      applyVisualUi(state.profile.ui, state.profile.characterName);
      populateSettings();
      await saveProfile(state.profile).catch(() => {});
    });

    // Update checker
    $('checkUpdateBtn').addEventListener('click', () => void runUpdateCheck());
    $('settingsCheckUpdateBtn').addEventListener('click', () => void runUpdateCheck());
    $('vsbUpdateBtn').addEventListener('click', () => void runUpdateCheck());
    $('closeUpdateModalBtn').addEventListener('click', () => { $('updateModal').hidden = true; });
    $('closeUpdateOkBtn').addEventListener('click', () => { $('updateModal').hidden = true; });

    // Dream banner
    $('viewDreamBtn').addEventListener('click', () => { switchView('memory'); qsa('[data-mtab="dreams"]')[0].click(); });
    $('dismissDreamBtn').addEventListener('click', () => { $('dreamBanner').hidden = true; });

    // Chat submit with auto-growing textarea & Shimmer Thinking
    const inputEl = $('chatInput');
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(150, inputEl.scrollHeight) + 'px';
    });
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chatForm').requestSubmit(); }
    });
    $('chatForm').addEventListener('submit', async e => {
      e.preventDefault();
      const text = inputEl.value.trim();
      if (!text || $('sendBtn').disabled) return;
      inputEl.value = ''; inputEl.style.height = 'auto';
      addMessage('user', text);
      $('thinkingBar').hidden = false;
      $('thinkingText').textContent = state.profile?.live ? 'Thinking… 正在翻找记忆并组织回复' : 'Thinking… 离线体验模拟中';
      $('sendBtn').disabled = true;
      try {
        const atts = state.attachments.slice(); state.attachments = []; renderAttachmentChips();
        const res = await apiPost('api/chat', {text, attachments: atts});
        const meta = res.trace ? `回忆 ${res.trace.recalled} 条 · ${res.live ? '在线大脑' : '离线体验'}` : (res.live ? '在线大脑' : '离线体验');
        addMessage('bot', res.text || (res.silent ? '（安静地看着你，没有说话）' : '…'), meta, res.bubbles);
        if(res.deliverables?.length)document.dispatchEvent(new CustomEvent('threadline-deliverables',{detail:res.deliverables}));
        void refreshLivenessAura();
        if (!res.live) addMessage('sys', '当前是离线体验模式。点左侧「新手教程」或「外观与设置 → 大脑与性格」填上 API Key 即可唤醒真实大脑。');
        await refreshAll();
      } catch (err) {
        addMessage('sys', `发送遇到问题：${err.message}`);
      } finally {
        $('thinkingBar').hidden = true;
        $('sendBtn').disabled = false;
      }
    });

    // Glassbox quick actions
    $('actJournalBtn').addEventListener('click', async () => {
      toast('正在整理记忆并写梦境日记…');
      try { await apiPost('api/journal', {automatic: false}); toast('整理完成'); await refreshAll(); }
      catch (e) { toast('失败：' + e.message); }
    });
    $('actAutonomyBtn').addEventListener('click', async () => {
      try { const r = await apiPost('api/autonomy', {}); toast(r.skipped ? `已跳过：${r.reason}` : '完成一次自主活动'); await refreshAll(); }
      catch (e) { toast('失败：' + e.message); }
    });
    $('actReflectBtn').addEventListener('click', async () => {
      try { const r = await apiPost('api/reflect', {}); toast(r.skipped ? `已跳过：${r.reason}` : '反思完成'); await refreshAll(); }
      catch (e) { toast('失败：' + e.message); }
    });

    // Dummy-Proof One-Click Connector Cards
    const guideTextMap = {
      vtuber: {
        title: '已为「实时数字人 / VTuber」配好流式大脑 + 情绪表情',
        steps: [
          '打开你的数字人软件（如 Open-LLM-VTuber / Fay），找到「大语言模型 (LLM) → OpenAI 兼容」设置。',
          '点下方「第 1 步」把地址粘进 Base URL 框，点「第 2 步」把模型名粘进 Model 框，API Key 随便填任意字符（如 123）。',
          '保持本软件在后台运行，现在直接对着数字人说话，TA 就会用 Threadline 的记忆和情绪开口回应你！',
        ],
      },
      cortico: {
        title: '已为「Cortico / Coopanion 桌宠」配好大脑与状态流',
        steps: [
          '打开 Coopanion / Cortico 设置里的「模型提供方」，选择 OpenAI 兼容接口。',
          '分别点下方按钮复制「地址」和「模型名」贴进去保存。',
          '若想联动桌宠气泡与动作，可将实时状态流指向同端口的 /v1/events。',
        ],
      },
      astrbot: {
        title: '已为「AstrBot / SillyTavern」配好大脑通道',
        steps: [
          '打开 AstrBot 面板（或 SillyTavern）→ 新增「OpenAI 兼容」模型提供方。',
          '点下方按钮分别复制「地址」和「模型名」粘进去，API Key 随便填任意字符。',
          '设为当前默认模型后，微信 / QQ / Telegram 里的对话都会自动共用这颗长期记忆大脑！',
        ],
      },
      dsh: {
        title: '已为「DeepSeek Harness (DSH)」配好寄生大脑',
        steps: [
          '在 DSH 外部模型配置里填入下方复制的地址和模型名。',
          '如需把 Threadline 情绪/思考状态推给 DSH 桌宠，直接运行项目里的 tools/bridges/dsh-cortico-bridge.mjs。',
          '你也可以在「外观与设置」里直接导入 DSH 的 pet.json 桌宠包在这里养。',
        ],
      },
    };
    qsa('[data-quick-connect]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const target = btn.dataset.quickConnect;
        toast('正在自动配置通道…');
        try {
          const res = await apiPost('api/gateway/quick-setup', {target});
          if(!res.ok)throw Error('本地网关未启动');
          state.quickResult = res;
          const meta = guideTextMap[target];
          $('quickGuideTitle').textContent = meta.title;
          const ol = $('quickGuideSteps'); ol.innerHTML = '';
          for (const s of meta.steps) { const li = document.createElement('li'); li.textContent = s; ol.appendChild(li); }
          $('quickGuideBox').hidden = false;
          await refreshAll();
          toast('通道已自动配好！照着下方 1、2 步复制即可');
        } catch (e) { toast('自动配置失败：' + e.message); }
      });
    });
    $('copyQuickUrlBtn').addEventListener('click', () => {
      const url = state.quickResult?.baseUrl || `http://127.0.0.1:${$('gwPort').value || 18792}/v1`;
      void copyText(url, '已复制地址（Base URL）');
    });
    $('copyQuickModelBtn').addEventListener('click', () => {
      const m = state.quickResult?.modelName || $('gwModelName').value || 'threadline-brain';
      void copyText(m, '已复制模型名');
    });
    $('copyQuickAllBtn').addEventListener('click', () => {
      const url = state.quickResult?.baseUrl || `http://127.0.0.1:${$('gwPort').value || 18792}/v1`;
      const m = state.quickResult?.modelName || $('gwModelName').value || 'threadline-brain';
      const sse = state.quickResult?.statusStream || `http://127.0.0.1:${$('gwPort').value || 18792}/v1/events`;
      void copyText(`Base URL: ${url}\nModel: ${m}\nAPI Key: ${state.quickResult?.apiKey || ''}\nStatus Stream (SSE): ${sse}`, '已复制完整配置块');
    });
    $('testGwBtn').addEventListener('click', async () => {
      try {
        const st = await apiGet('api/gateway');
        toast(st.running ? `通道完全畅通！（端口 ${st.port}）` : '通道未启动，请先点击上方卡片');
      } catch (e) { toast('检测失败：' + e.message); }
    });

    // Memory actions
    $('geekProvenanceToggle').addEventListener('change', e => { state.geekProvenance = e.target.checked; renderMemory(); });
    $('newNoteForm').addEventListener('submit', async e => {
      e.preventDefault();
      const body = $('newNoteBody').value.trim(); if (!body) return;
      try { await apiPost('api/memory/note-save', {kind: $('newNoteKind').value, body}); $('newNoteBody').value = ''; toast('小纸条已记下来'); await refreshAll(); }
      catch (err) { toast('保存失败：' + err.message); }
    });
    const exportNotes = async () => {
      const data = await apiGet('api/notes');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
      a.download = 'threadline-notes-backup.json'; a.click();
    };
    $('exportNotesBtn').addEventListener('click', exportNotes);
    $('backupNotesBtn').addEventListener('click', exportNotes);
    $('importNotesBtn').addEventListener('click', () => $('importNotesFile').click());
    $('importNotesFile').addEventListener('change', async e => {
      const file = e.target.files?.[0]; if (!file) return;
      try {
        if (file.size > 1024 * 1024) throw new Error('单批最多 1 MB，请拆成小文件');
        const extension = file.name.split('.').at(-1).toLowerCase();
        const format = {json:'json', jsonl:'jsonl', md:'markdown', csv:'csv'}[extension] ?? 'auto';
        const preview = await apiPost('api/memory/import/preview', {content:await file.text(), format});
        if (!preview.notes.length) { toast('没有可导入的记忆'); return; }
        const accepted = await openDialog({title:'预览导入的记忆', okText:'导入预览中的记忆',
          message:[`待导入 ${preview.notes.length} 条未核实笔记。跳过 ${preview.counts.blocked} 条可疑内容，脱敏 ${preview.counts.redactedSecrets} 条。`,
            ...preview.warnings, ...preview.notes.map((note,index)=>`${index+1}. ${note}`)].join('\n\n')});
        if (!accepted) return;
        const result = await apiPost('api/memory/import/commit', {batchId:preview.batchId});
        toast(`已导入 ${result.imported} 条，跳过 ${result.duplicates} 条重复记忆`);
        await refreshAll();
      } catch (err) { toast('导入失败：' + err.message); }
      finally { e.target.value = ''; }
    });

    // Advanced Gateway / MCP / QQ
    $('saveGatewayBtn').addEventListener('click', async () => {
      try { await saveProfile(collectProfileFromForm()); toast('网关设置已保存'); }
      catch (e) { toast('保存失败：' + e.message); }
    });
    $('mcpInsertSampleBtn').addEventListener('click', () => {
      $('mcpConfigInput').value = JSON.stringify({
        mcpServers: {
          filesystem: {command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], enabled: false, allowWrite: false},
          remote_example: {url: 'http://127.0.0.1:3001/mcp', enabled: false, allowWrite: false},
        },
      }, null, 2);
    });
    $('saveMcpBtn').addEventListener('click', async () => {
      try { await apiPost('api/mcp/apply', JSON.parse($('mcpConfigInput').value || '{}')); toast('MCP 已更新'); await refreshAll(); }
      catch (e) { toast('MCP 保存失败：' + e.message); }
    });
    $('saveQqBtn').addEventListener('click', async () => { try { await saveProfile(collectProfileFromForm()); toast('QQ 配置已保存'); } catch (e) { toast(e.message); } });
    $('connectQqBtn').addEventListener('click', async () => { try { await apiPost('api/connect-qq', {}); toast('正在连接 QQ…'); await refreshAll(); } catch (e) { toast(e.message); } });
    $('disconnectQqBtn').addEventListener('click', async () => { try { await apiPost('api/disconnect-qq', {}); toast('已断开 QQ'); await refreshAll(); } catch (e) { toast(e.message); } });

    // DIY Controls
    $('uiBubbleRadius').addEventListener('input', e => { $('bubbleRadiusVal').textContent = e.target.value; });
    $('uiFontSize').addEventListener('input', e => { $('fontSizeVal').textContent = e.target.value; });
    $('uiBgBlur').addEventListener('input', e => { $('bgBlurVal').textContent = e.target.value; });
    $('uiBgOpacity').addEventListener('input', e => { $('bgOpacityVal').textContent = e.target.value; });
    $('dailyBudget').addEventListener('input', e => { $('dailyVal').textContent = e.target.value; });

    $('avatarFile').addEventListener('change', async e => {
      const f = e.target.files?.[0]; if (!f) return;
      const url = await readFileAsDataUrl(f);
      state.profile.ui.avatarDataUrl = url;
      if ($('uiAutoAccent').checked) { const a = await extractAccentFromDataUrl(url); if (a) state.profile.ui.accent = a; }
      applyVisualUi(state.profile.ui, state.profile.characterName);
      toast('头像已更新（点「保存全部更改」持久化）');
    });
    $('portraitFile').addEventListener('change', async e => {
      const f = e.target.files?.[0]; if (!f) return;
      state.profile.ui.portraitDataUrl = await readFileAsDataUrl(f); state.profile.ui.layout = 'portrait';
      applyVisualUi(state.profile.ui, state.profile.characterName); populateSettings(); toast('立绘已预览');
    });
    $('bgFile').addEventListener('change', async e => {
      const f = e.target.files?.[0]; if (!f) return;
      state.profile.ui.bgDataUrl = await readFileAsDataUrl(f);
      applyVisualUi(state.profile.ui, state.profile.characterName); toast('背景图已预览');
    });
    $('petFile').addEventListener('change', async e => {
      const f = e.target.files?.[0]; if (!f) return;
      if (f.name.endsWith('.json')) {
        try {
          const parsed = JSON.parse(await f.text());
          state.profile.ui.petPack = {name: parsed.name || f.name, image: parsed.image || parsed.icon || '', scale: 1};
          state.profile.ui.layout = 'pet'; applyVisualUi(state.profile.ui, state.profile.characterName); toast('桌宠包已导入');
        } catch { toast('pet.json 无法解析'); }
      } else {
        state.profile.ui.petPack = {name: f.name, image: await readFileAsDataUrl(f), scale: 1};
        state.profile.ui.layout = 'pet'; applyVisualUi(state.profile.ui, state.profile.characterName); populateSettings(); toast('桌宠已预览');
      }
    });
    $('clearImagesBtn').addEventListener('click', () => {
      state.profile.ui.avatarDataUrl = ''; state.profile.ui.portraitDataUrl = ''; state.profile.ui.bgDataUrl = ''; state.profile.ui.petPack = null;
      applyVisualUi(state.profile.ui, state.profile.characterName); toast('已清空图片预览');
    });
    $('resetAppearanceBtn').addEventListener('click', () => {
      state.profile.ui = {...state.profile.ui, skin: 'chatgpt', theme: 'paper', layout: 'minimal', accent: '', autoAccent: true, avatarDataUrl: '', portraitDataUrl: '', bgDataUrl: '', bgBlur: 12, bgOpacity: 0.14, bubbleRadius: 18, fontSize: 15, customCss: '', petPack: null};
      applyVisualUi(state.profile.ui, state.profile.characterName); populateSettings(); toast('已恢复默认外观');
    });
    $('exportThemeBtn').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify({format: 'threadline-theme-v1', ui: state.profile.ui}, null, 2)], {type: 'application/json'}));
      a.download = 'threadline-skin.json'; a.click();
    });
    $('importThemeBtn').addEventListener('click', () => $('importThemeFile').click());
    $('importThemeFile').addEventListener('change', async e => {
      const f = e.target.files?.[0]; if (!f) return;
      try { const d = JSON.parse(await f.text()); state.profile.ui = {...state.profile.ui, ...(d.ui || d)}; applyVisualUi(state.profile.ui, state.profile.characterName); populateSettings(); toast('皮肤包已导入'); }
      catch { toast('皮肤包格式无效'); }
      e.target.value = '';
    });
    $('charCardFile').addEventListener('change', async e => {
      const f = e.target.files?.[0]; if (!f) return;
      try {
        const card = JSON.parse(await f.text()); const data = card.data || card;
        if (data.name) $('charNameInput').value = data.name;
        const parts = [data.description, data.personality, data.scenario].filter(Boolean);
        if (parts.length) $('identityInput').value = parts.join('\n\n').slice(0, 3900);
        if (data.mes_example || data.style) $('styleInput').value = String(data.style || data.mes_example).slice(0, 15000);
        toast('角色卡已填入');
      } catch { toast('角色卡解析失败'); }
      e.target.value = '';
    });
    qsa('[data-provider]').forEach(btn => {
      btn.addEventListener('click', () => {
        const map = {deepseek: ['https://api.deepseek.com', ''], openai: ['https://api.openai.com/v1', 'gpt-4o-mini'], ollama: ['http://127.0.0.1:11434/v1', 'qwen2.5:7b'], lmstudio: ['http://127.0.0.1:1234/v1', 'local-model']};
        const [u, m] = map[btn.dataset.provider]; $('providerBaseUrl').value = u; $('providerModel').value = m; toast('已填入服务商模板');
      });
    });
    $('checkKeyBtn').addEventListener('click', async () => {
      $('keyStatusMsg').textContent = '测通中…';
      try { await apiPost('api/check-key', {key: $('apiKeyInput').value.trim(), baseUrl: $('providerBaseUrl').value.trim()}); $('keyStatusMsg').textContent = '连接成功'; }
      catch (e) { $('keyStatusMsg').textContent = `失败：${e.message}`; }
    });
    $('saveAllSettingsBtn').addEventListener('click', async () => {
      try { const key = $('apiKeyInput').value.trim(); await saveProfile(collectProfileFromForm(), key || undefined); toast('全部设置已保存生效'); }
      catch (e) { toast('保存失败：' + e.message); }
    });

    // Components & Storage
    $('openComponentsBtn').addEventListener('click', async () => { await refreshComponents(false); $('componentModal').hidden = false; });
    $('closeCompModalBtn').addEventListener('click', () => { $('componentModal').hidden = true; });
    $('skipCompBtn').addEventListener('click', async () => {
      $('componentModal').hidden = true;
      if ($('dontAskCompAgain').checked && state.profile) { state.profile.ui.componentPromptDismissed = true; await saveProfile(state.profile).catch(() => {}); }
    });
    $('downloadCompModalBtn').addEventListener('click', async () => {
      $('componentModal').hidden = true; switchView('settings'); qsa('[data-stab="components"]')[0].click();
      await startComponentInstall('comp-check-modal', $('modalMirrorSelect').value);
    });
    $('installSelectedBtn').addEventListener('click', () => void startComponentInstall('comp-check-panel', $('mirrorSelect').value));
    $('refreshComponentsBtn').addEventListener('click', () => void refreshComponents(false));
    $('refreshStorageBtn').addEventListener('click', () => void refreshStorage());
    $('maintainStorageBtn').addEventListener('click', async () => {
      try { const r = await apiPost('api/storage/maintain', {}); toast(`清理完成（当前 ${formatBytes(r.after?.totalBytes ?? 0)}，记忆零损伤）`); await refreshStorage(); }
      catch (e) { toast('清理失败：' + e.message); }
    });

    // Beginner Guide & Wizard
    $('openGuideBtn').addEventListener('click', () => { $('guideModal').hidden = false; });
    $('closeGuideBtn').addEventListener('click', () => { $('guideModal').hidden = true; });
    $('guideOkBtn').addEventListener('click', () => { $('guideModal').hidden = true; });
    const updateWizardUi = () => {
      qsa('.wstep').forEach(el => el.classList.remove('active'));
      $(`wstep-${state.wizardStep}`).classList.add('active');
      qsa('.step-dot').forEach(el => el.classList.toggle('active', Number(el.dataset.wstep) === state.wizardStep));
      $('wizPrevBtn').hidden = state.wizardStep === 1;
      $('wizNextBtn').hidden = state.wizardStep === 3;
      $('wizFinishBtn').hidden = state.wizardStep !== 3;
    };
    const openWizard = () => {
      $('guideModal').hidden = true; state.wizardStep = 1;
      $('wizName').value = state.profile?.characterName || '小线';
      $('wizIdentity').value = state.profile?.identity || '';
      $('wizBaseUrl').value = state.profile?.providerBaseUrl || 'https://api.deepseek.com';
      $('wizDaily').value = state.profile?.daily ?? 5;
      updateWizardUi(); $('wizardModal').hidden = false;
    };
    $('guideReopenWizBtn').addEventListener('click', openWizard);
    $('reopenWizardBtn').addEventListener('click', openWizard);
    qsa('[data-wskin]').forEach(btn => btn.addEventListener('click', () => {
      qsa('[data-wskin]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active'); state.wizardSkin = btn.dataset.wskin;
    }));
    $('wizTestKeyBtn').addEventListener('click', async () => {
      $('wizKeyMsg').textContent = '测通中…';
      try { await apiPost('api/check-key', {key: $('wizApiKey').value.trim(), baseUrl: $('wizBaseUrl').value.trim()}); $('wizKeyMsg').textContent = '已测通'; }
      catch (e) { $('wizKeyMsg').textContent = e.message; }
    });
    $('wizAvatar').addEventListener('change', async e => {
      const f = e.target.files?.[0]; if (!f) return;
      const url = await readFileAsDataUrl(f); state.profile.ui.avatarDataUrl = url;
      const a = await extractAccentFromDataUrl(url); if (a) state.profile.ui.accent = a;
    });
    $('wizPrevBtn').addEventListener('click', () => { state.wizardStep = Math.max(1, state.wizardStep - 1); updateWizardUi(); });
    $('wizNextBtn').addEventListener('click', () => { state.wizardStep = Math.min(3, state.wizardStep + 1); updateWizardUi(); });
    $('skipWizardBtn').addEventListener('click', async () => {
      $('wizardModal').hidden = true;
      if (state.profile) { state.profile.ui.onboardingDone = true; await saveProfile(state.profile).catch(() => {}); await refreshComponents(true); }
    });
    $('wizFinishBtn').addEventListener('click', async () => {
      const key = $('wizApiKey').value.trim();
      await applySkin(state.wizardSkin, false);
      const next = {
        ...state.profile,
        characterName: $('wizName').value.trim() || 'Threadline',
        identity: $('wizIdentity').value.trim() || state.profile.identity,
        providerBaseUrl: $('wizBaseUrl').value.trim() || 'https://api.deepseek.com',
        daily: Number($('wizDaily').value) || 5,
        live: Boolean(key),
        ui: {...state.profile.ui, onboardingDone: true},
      };
      try { await saveProfile(next, key || undefined); $('wizardModal').hidden = true; toast('欢迎入住，开始聊天吧'); await refreshComponents(true); }
      catch (e) { toast('保存失败：' + e.message); }
    });
  }

  async function boot() {
    bindEvents();
    await refreshAll();
    setTimeout(() => $('splashScreen').classList.add('done'), 550);
    updateEmptyHero();
    if (!state.profile?.ui?.onboardingDone) {
      $('wizName').value = state.profile?.characterName || '小线';
      $('wizIdentity').value = state.profile?.identity || '';
      $('wizardModal').hidden = false;
    } else {
      await refreshComponents(true);
    }
  }


  window.addEventListener('error', () => {
    if (!state.safeMode && $('safeModeBanner')) {
      $('safeModeBanner').hidden = false;
    }
  });

  void boot();
})();


/* ==========================================================================
   Threadline Studio v2.9.0 · Hierarchical Navigation, Progressive Accordions,
   Thinking Shimmer Steps & Office Workspace Artifact Drawer
   ========================================================================== */
(() => {
  if (window.__tlUiPolishInit) return;
  window.__tlUiPolishInit = true;

  const SVG_CHEVRON = '<svg class="ct-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
  const SVG_DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
  const SVG_CODE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
  const SVG_FOLDER = '<svg class="ct-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  const SVG_SPARK = '<svg class="ct-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9L12 3z"/></svg>';
  const SVG_SLIDERS = '<svg class="ct-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="2" y1="14" x2="6" y2="14"/><line x1="10" y1="8" x2="14" y2="8"/><line x1="18" y1="16" x2="22" y2="16"/></svg>';
  const SVG_CLOCK = '<svg class="ct-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>';
  const SVG_SHIELD = '<svg class="ct-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
  const SVG_PLUG = '<svg class="ct-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 0 1-12 0V8z"/></svg>';
  const SVG_STAR = '<svg class="ct-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.2"/><circle cx="5" cy="7" r="1.4"/><circle cx="19" cy="8" r="1.4"/><circle cx="7" cy="18" r="1.4"/><circle cx="18" cy="17" r="1.4"/><line x1="6.3" y1="7.8" x2="10.2" y2="10.8"/><line x1="17.7" y1="8.7" x2="13.8" y2="10.9"/><line x1="8.1" y1="16.9" x2="10.7" y2="13.7"/><line x1="16.8" y1="16.1" x2="13.6" y2="13.5"/></svg>';
  const SVG_DOWN = '<svg class="tl-acc-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  const byId = id => document.getElementById(id);

  function triggerNativeView(viewName) {
    const btn = document.querySelector(`.nav-item[data-view="${viewName}"]`);
    if (btn) btn.click();
  }

  function openSettingsSubtab(stab, focusText) {
    triggerNativeView('settings');
    setTimeout(() => {
      const tab = document.querySelector(`.pill-tab[data-stab="${stab}"]`);
      if (tab) tab.click();
      if (focusText) {
        setTimeout(() => focusAccordionByTitle(focusText), 80);
      }
    }, 30);
  }

  function openMemorySubtab(mtab) {
    triggerNativeView('memory');
    setTimeout(() => {
      const tab = document.querySelector(`#view-memory [data-mtab="${mtab}"], #view-memory .pill-tab[data-tab="${mtab}"]`);
      if (tab) tab.click();
    }, 40);
  }

  function focusAccordionByTitle(keyword) {
    const cards = Array.from(document.querySelectorAll('.tl-acc-card'));
    const target = cards.find(c => (c.dataset.accTitle || '').includes(keyword));
    if (!target) return;
    target.classList.add('open');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('flash-focus');
    setTimeout(() => target.classList.remove('flash-focus'), 1100);
  }

  // ---- 1. Contextual Hierarchical Tree for Sub-Sidebar ----
  const TREE_MAP = {
    room: {
      heading: '对话与工作区',
      groups: [
        {
          title: '办公与实时透视', icon: SVG_FOLDER, open: true,
          items: [
            { label: '办公工作区侧栏', badge: 'Canvas', icon: SVG_DOC, act: () => toggleWorkspaceDrawer(true) },
            { label: '玻璃箱实时透视', badge: 'Live', icon: SVG_SPARK, act: () => byId('toggleGlassboxBtn')?.click() },
            { label: '3D 记忆星图', badge: '3D', icon: SVG_STAR, act: () => openMemorySubtab('starmap') },
            { label: '虚拟形象舞台', icon: SVG_FOLDER, act: () => byId('toggleAvatarStageBtn')?.click() }
          ]
        },
        {
          title: '快捷场景控制', icon: SVG_SLIDERS, open: false,
          items: [
            { label: '隐私窗帘切换', icon: SVG_SHIELD, act: () => byId('curtainQuickBtn')?.click() },
            { label: '新建数字生命', icon: SVG_SPARK, act: () => byId('addResidentBtn')?.click() },
            { label: '满血组件体检', icon: SVG_SLIDERS, act: () => byId('openComponentsBtn')?.click() },
            { label: '新手使用指南', icon: SVG_DOC, act: () => byId('openGuideBtn')?.click() }
          ]
        }
      ]
    },
    memory: {
      heading: '资料空间与记忆',
      groups: [
        {
          title: '记忆视图', icon: SVG_STAR, open: true,
          items: [
            { label: '全部记忆与检索', icon: SVG_DOC, act: () => triggerNativeView('memory') },
            { label: '3D 记忆星图', badge: '3D', icon: SVG_STAR, act: () => openMemorySubtab('starmap') },
            { label: '个人状态档案', icon: SVG_FOLDER, act: () => openMemorySubtab('states') },
            { label: '长期笔记库', icon: SVG_DOC, act: () => openMemorySubtab('notes') },
            { label: '梦境日记与涌现特质', icon: SVG_CLOCK, act: () => openMemorySubtab('dreams') }
          ]
        },
        {
          title: '导入与时空胶囊', icon: SVG_SHIELD, open: true,
          items: [
            { label: '加密时间胶囊备份', icon: SVG_SHIELD, act: () => openSettingsSubtab('brain', '时空胶囊') },
            { label: '聊天记录迁移导入', badge: 'QQ/WX', icon: SVG_DOC, act: () => openSettingsSubtab('brain', '感官隐私') }
          ]
        }
      ]
    },
    schedule: {
      heading: '后台节律与隐私',
      groups: [
        {
          title: '自主意识节律', icon: SVG_CLOCK, open: true,
          items: [
            { label: '打开此刻玻璃箱', icon: SVG_CLOCK, act: () => { triggerNativeView('room'); setTimeout(() => byId('toggleGlassboxBtn')?.click(), 60); } },
            { label: '立刻执行睡前整理', icon: SVG_SPARK, act: () => { triggerNativeView('room'); byId('actJournalBtn')?.click(); } },
            { label: '触发一次轻度反思', icon: SVG_SPARK, act: () => { triggerNativeView('room'); byId('actReflectBtn')?.click(); } }
          ]
        },
        {
          title: '隐私与成本边界', icon: SVG_SHIELD, open: true,
          items: [
            { label: '感官隐私闸门', icon: SVG_SHIELD, act: () => openSettingsSubtab('brain', '感官隐私') },
            { label: '缓存排版与工具权限', badge: 'staged-v1', icon: SVG_SLIDERS, act: () => openSettingsSubtab('brain', '上下文缓存') },
            { label: '防烧钱预算红线', icon: SVG_SHIELD, act: () => openSettingsSubtab('brain', '预算红线') }
          ]
        }
      ]
    },
    custom: {
      heading: '自定义与扩展',
      groups: [
        {
          title: '智能体与连接', icon: SVG_PLUG, open: true,
          items: [
            { label: '软件管家 Copilot', badge: '审批卡', icon: SVG_SPARK, act: () => triggerNativeView('copilot') },
            { label: '一键生态连接', badge: 'OpenAI', icon: SVG_PLUG, act: () => triggerNativeView('ecosystem') },
            { label: '多 API 模型池', icon: SVG_SLIDERS, act: () => openSettingsSubtab('brain', '多 API 模型池') }
          ]
        },
        {
          title: '技能与多角色团队', icon: SVG_FOLDER, open: true,
          items: [
            { label: '居民技能文件 SKILL.md', icon: SVG_CODE, act: () => openSettingsSubtab('brain', 'SKILL.md') },
            { label: '团队协作与子 Agent', icon: SVG_FOLDER, act: () => openSettingsSubtab('brain', '多居民团队') },
            { label: '创造模式与时光机', icon: SVG_CLOCK, act: () => openSettingsSubtab('storage', '创造模式') }
          ]
        }
      ]
    },
    community: {
      heading: '探索与社区',
      groups: [
        {
          title: '创作者广场', icon: SVG_SPARK, open: true,
          items: [
            { label: '社区作品领养', icon: SVG_FOLDER, act: () => triggerNativeView('community') },
            { label: 'GitHub 灵感市场', icon: SVG_PLUG, act: () => triggerNativeView('community') }
          ]
        }
      ]
    },
    settings: {
      heading: '外观与系统设置',
      groups: [
        {
          title: '视觉与个性化', icon: SVG_SLIDERS, open: true,
          items: [
            { label: '界面风格与皮肤', icon: SVG_SLIDERS, act: () => openSettingsSubtab('appearance', '界面风格') },
            { label: '立绘、背景与桌宠', icon: SVG_FOLDER, act: () => openSettingsSubtab('appearance', '形象、背景') },
            { label: '自定义 CSS 皮肤包', icon: SVG_CODE, act: () => openSettingsSubtab('appearance', '自定义 CSS') }
          ]
        },
        {
          title: '核心大脑与维护', icon: SVG_SHIELD, open: true,
          items: [
            { label: '人设卡与模型预算', icon: SVG_DOC, act: () => openSettingsSubtab('brain', '角色与人设') },
            { label: '认知层与 Limbic 情感', icon: SVG_SPARK, act: () => openSettingsSubtab('brain', 'Limbic') },
            { label: '满血组件中心', icon: SVG_PLUG, act: () => openSettingsSubtab('components', '满血组件') },
            { label: '无损清理与版本更新', icon: SVG_CLOCK, act: () => openSettingsSubtab('storage', '存储空间') }
          ]
        }
      ]
    }
  };

  function renderContextTree(railKey) {
    const box = byId('contextTree');
    if (!box) return;
    const cfg = TREE_MAP[railKey] || TREE_MAP.room;
    box.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ct-section-title';
    head.textContent = cfg.heading;
    box.appendChild(head);

    cfg.groups.forEach(g => {
      const grp = document.createElement('div');
      grp.className = 'ct-group' + (g.open ? ' open' : '');

      const pBtn = document.createElement('button');
      pBtn.type = 'button';
      pBtn.className = 'ct-parent';
      pBtn.innerHTML = `${g.icon}<span>${g.title}</span>${SVG_CHEVRON}`;
      pBtn.addEventListener('click', () => grp.classList.toggle('open'));

      const wrap = document.createElement('div');
      wrap.className = 'ct-children-wrap';
      const list = document.createElement('div');
      list.className = 'ct-children';

      g.items.forEach(it => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ct-item';
        b.innerHTML = `${it.icon}<span>${it.label}</span>${it.badge ? `<span class="ct-badge">${it.badge}</span>` : ''}`;
        b.addEventListener('click', () => {
          box.querySelectorAll('.ct-item').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          it.act();
        });
        list.appendChild(b);
      });

      wrap.appendChild(list);
      grp.appendChild(pBtn);
      grp.appendChild(wrap);
      box.appendChild(grp);
    });
  }

  function initIconRail() {
    const railBtns = document.querySelectorAll('#iconRail .rail-btn[data-rail]');
    railBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.rail;
        railBtns.forEach(b => b.classList.toggle('active', b === btn));
        const sb = byId('sidebar');
        if (sb && sb.classList.contains('collapsed')) {
          sb.classList.remove('collapsed');
        }
        renderContextTree(key);
        if (key === 'room') triggerNativeView('room');
        else if (key === 'memory') triggerNativeView('memory');
        else if (key === 'schedule') triggerNativeView('room');
        else if (key === 'custom') triggerNativeView('copilot');
        else if (key === 'community') triggerNativeView('community');
        else if (key === 'settings') triggerNativeView('settings');
      });
    });

    document.querySelectorAll('#iconRail .rail-btn[data-rail-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.railAction;
        if (act === 'theme') byId('toggleThemeBtn')?.click();
        if (act === 'workspace') toggleWorkspaceDrawer();
      });
    });

    renderContextTree('room');
  }

  // ---- 2. Progressive Disclosure Accordions for Settings & Ecosystem ----
  function upgradePanelBoxesToAccordions() {
    const containers = ['#view-settings .sub-panel', '#view-ecosystem .eco-grid', '#view-community .page-wrap'];
    containers.forEach(sel => {
      document.querySelectorAll(sel).forEach(scope => {
        const boxes = Array.from(scope.querySelectorAll(':scope > .panel-box, :scope > .eco-grid > .panel-box'));
        boxes.forEach((box, idx) => {
          if (box.classList.contains('tl-acc-card')) return;
          const h3 = box.querySelector('h3');
          if (!h3) return;
          const titleText = h3.textContent.trim();
          const firstP = box.querySelector('p.muted, .muted');
          const subText = firstP ? firstP.textContent.trim().slice(0, 56) : '点击展开配置此模块';

          const children = Array.from(box.childNodes).filter(n => n !== h3);
          box.innerHTML = '';
          box.classList.add('tl-acc-card');
          if (idx === 0) box.classList.add('open');
          box.dataset.accTitle = titleText;

          const headBtn = document.createElement('button');
          headBtn.type = 'button';
          headBtn.className = 'tl-acc-head';
          const ico = titleText.includes('CSS') || titleText.includes('SKILL') ? SVG_CODE
            : titleText.includes('隐私') || titleText.includes('预算') || titleText.includes('胶囊') ? SVG_SHIELD
            : titleText.includes('缓存') || titleText.includes('风格') ? SVG_SLIDERS
            : titleText.includes('组件') || titleText.includes('连接') || titleText.includes('池') ? SVG_PLUG
            : SVG_FOLDER;
          headBtn.innerHTML = `<span class="tl-acc-ico">${ico}</span><div class="tl-acc-meta"><div class="tl-acc-title"></div><div class="tl-acc-sub"></div></div>${SVG_DOWN}`;
          headBtn.querySelector('.tl-acc-title').textContent = titleText;
          headBtn.querySelector('.tl-acc-sub').textContent = subText;
          headBtn.addEventListener('click', () => box.classList.toggle('open'));

          const wrap = document.createElement('div');
          wrap.className = 'tl-acc-body-wrap';
          const body = document.createElement('div');
          body.className = 'tl-acc-body';
          const inner = document.createElement('div');
          inner.className = 'tl-acc-inner';
          children.forEach(n => inner.appendChild(n));
          body.appendChild(inner);
          wrap.appendChild(body);
          box.appendChild(headBtn);
          box.appendChild(wrap);
        });
      });
    });
  }

  // ---- 3. Thinking Bar Shimmer & Auto-Progressing Expandable Steps ----
  function initThinkingEnhancer() {
    const bar = byId('thinkingBar');
    const toggle = byId('thinkingToggleBtn');
    const steps = byId('thinkingSteps');
    if (!bar || !toggle || !steps) return;

    toggle.addEventListener('click', () => {
      const open = steps.hidden;
      steps.hidden = !open;
      bar.classList.toggle('steps-open', open);
    });

    let stepTimer = null;
    const obs = new MutationObserver(() => {
      if (!bar.hidden) {
        const items = Array.from(steps.querySelectorAll('.tstep'));
        let cur = 0;
        const paint = () => {
          items.forEach((el, i) => {
            el.classList.toggle('done', i < cur);
            el.classList.toggle('active', i === cur);
          });
        };
        paint();
        clearInterval(stepTimer);
        stepTimer = setInterval(() => {
          cur = Math.min(items.length - 1, cur + 1);
          paint();
        }, 1600);
      } else {
        clearInterval(stepTimer);
      }
    });
    obs.observe(bar, { attributes: true, attributeFilter: ['hidden'] });
  }

  // ---- 4. Office Workspace & Agent Artifacts Side Panel ----
  const wsArtifacts = [];
  let wsActiveId = null;

  function toggleWorkspaceDrawer(forceOpen) {
    const drawer = byId('workspaceDrawer');
    const btn = byId('toggleWorkspaceBtn');
    if (!drawer) return;
    const next = typeof forceOpen === 'boolean' ? forceOpen : !drawer.classList.contains('open');
    drawer.classList.toggle('open', next);
    btn?.classList.toggle('active', next);
    if (next) syncOfficeDeskArtifacts();
  }

  function addOrOpenArtifact({ id, title, kind = 'doc', content = '', fileRef = null }, openNow = false) {
    const existing = wsArtifacts.find(a => a.id === id);
    if (existing) {
      existing.content = content || existing.content;
    } else {
      wsArtifacts.unshift({ id, title, kind, content, fileRef });
    }
    if (openNow || !wsActiveId) wsActiveId = id;
    renderWorkspace();
    if (openNow) toggleWorkspaceDrawer(true);
  }

  async function selectWorkspaceArtifact(item) {
    wsActiveId = item.id;
    renderWorkspace();
    if (!item.fileRef || item.loaded) return;
    try {
      const response=await fetch('api/office/read',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({path:item.fileRef.path,sha256:item.fileRef.sha256})});
      const artifact=await response.json();
      if(!response.ok)throw Error('交付物已变更或当前不可读取');
      item.content=artifact.text;
      item.loaded=true;
    }catch(error){item.content=error.message;}
    if(wsActiveId===item.id)renderWorkspace();
  }

  function renderWorkspace() {
    const tabsEl = byId('wsTabs');
    const treeEl = byId('wsTreeList');
    const viewerEl = byId('wsViewer');
    if (!tabsEl || !treeEl || !viewerEl) return;

    tabsEl.innerHTML = '';
    treeEl.innerHTML = '';

    if (!wsArtifacts.length) {
      treeEl.innerHTML = '<div style="font-size:12px;color:var(--ink-3);padding:8px;">暂无提交内容</div>';
      return;
    }

    wsArtifacts.slice(0, 12).forEach(item => {
      const ico = item.kind === 'code' ? SVG_CODE : SVG_DOC;
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'ws-tab' + (item.id === wsActiveId ? ' active' : '');
      t.innerHTML = `${ico}<span></span>`;
      t.querySelector('span').textContent = item.title;
      t.addEventListener('click', () => void selectWorkspaceArtifact(item));
      tabsEl.appendChild(t);

      const f = document.createElement('button');
      f.type = 'button';
      f.className = 'ws-file-btn' + (item.id === wsActiveId ? ' active' : '');
      f.innerHTML = `${ico}<span></span>`;
      f.querySelector('span').textContent = item.title;
      f.addEventListener('click', () => void selectWorkspaceArtifact(item));
      treeEl.appendChild(f);
    });

    const cur = wsArtifacts.find(a => a.id === wsActiveId) || wsArtifacts[0];
    if (cur) {
      viewerEl.innerHTML = `<div class="ws-doc-title"><span></span><span style="font-size:11.5px;color:var(--ink-3);font-weight:400">${cur.kind === 'code' ? '代码片段' : '文档交付物'}</span></div><pre class="ws-doc-pre"></pre>`;
      viewerEl.querySelector('.ws-doc-title span').textContent = cur.title;
      viewerEl.querySelector('.ws-doc-pre').textContent = cur.content;
    }
  }

  function syncOfficeDeskArtifacts() {
    const desk = byId('gbOfficeFiles');
    if (!desk) return;
    const text = desk.textContent.trim();
    if (!text || text.includes('书桌还是空的')) return;
    addOrOpenArtifact({
      id: 'office-desk-index',
      title: '书桌工作文件索引.md',
      kind: 'doc',
      content: text
    }, false);
  }

  document.addEventListener('threadline-resident-change',()=>{
    wsArtifacts.length=0;wsActiveId=null;renderWorkspace();
    const viewer=byId('wsViewer');if(viewer)viewer.textContent='';
  });
  document.addEventListener('threadline-deliverables',event=>{
    for(const file of event.detail){
      addOrOpenArtifact({id:'dsh:'+file.sha256+':'+file.path,title:file.path,kind:'doc',fileRef:file,
        content:`交付位置：${file.path}\n大小：${file.bytes} 字节\nSHA-256：${file.sha256}`},false);
    }
    toggleWorkspaceDrawer(true);
  });

  function scanBotMessageForArtifacts(msgEl) {
    if (!msgEl || msgEl.dataset.wsScanned) return;
    if (!msgEl.classList.contains('bot')) return;
    msgEl.dataset.wsScanned = '1';

    const raw = (msgEl.innerText || '').trim();
    if (raw.length < 160 && !msgEl.querySelector('pre, code')) return;

    const firstLine = raw.split('\n').map(s => s.trim()).find(s => s.length > 2) || 'Agent 交付文档';
    const cleanTitle = firstLine.replace(/^[#*\-\s]+/, '').slice(0, 22) + (msgEl.querySelector('pre') ? '.code' : '.md');
    const id = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);

    addOrOpenArtifact({
      id,
      title: cleanTitle,
      kind: msgEl.querySelector('pre') ? 'code' : 'doc',
      content: raw
    }, false);

    const row = document.createElement('div');
    row.className = 'artifact-chip-row';
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'artifact-chip';
    chip.innerHTML = `${msgEl.querySelector('pre') ? SVG_CODE : SVG_DOC}<span></span>`;
    chip.querySelector('span').textContent = `在工作区打开 · ${cleanTitle}`;
    chip.addEventListener('click', () => addOrOpenArtifact({ id, title: cleanTitle, kind: msgEl.querySelector('pre') ? 'code' : 'doc', content: raw }, true));
    row.appendChild(chip);
    msgEl.appendChild(row);
  }

  function initWorkspaceDrawer() {
    byId('toggleWorkspaceBtn')?.addEventListener('click', () => toggleWorkspaceDrawer());
    byId('closeWorkspaceBtn')?.addEventListener('click', () => toggleWorkspaceDrawer(false));
    byId('wsToggleTreeBtn')?.addEventListener('click', () => byId('wsTree')?.classList.toggle('hidden-tree'));
    byId('wsCopyBtn')?.addEventListener('click', () => {
      const cur = wsArtifacts.find(a => a.id === wsActiveId);
      if (cur) navigator.clipboard?.writeText(cur.content);
    });
    byId('wsDownloadBtn')?.addEventListener('click', () => {
      const cur = wsArtifacts.find(a => a.id === wsActiveId);
      if (!cur) return;
      const blob = new Blob([cur.content], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = cur.title.replace(/[\\/:*?"<>|]/g, '_');
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    // Keyboard shortcut Ctrl+Shift+W
    window.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        toggleWorkspaceDrawer();
      }
    });

    // Watch chatLog for new Agent messages and automatically attach Workspace deliverable chips
    const chatLog = byId('chatLog');
    if (chatLog) {
      const mo = new MutationObserver(muts => {
        muts.forEach(m => m.addedNodes.forEach(n => {
          if (n.nodeType === 1) {
            if (n.classList?.contains('bot')) scanBotMessageForArtifacts(n);
            n.querySelectorAll?.('.msg.bot').forEach(scanBotMessageForArtifacts);
          }
        }));
      });
      mo.observe(chatLog, { childList: true, subtree: true });
    }
  }

  function boot() {
    initIconRail();
    upgradePanelBoxesToAccordions();
    initThinkingEnhancer();
    initWorkspaceDrawer();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 20);
})();
