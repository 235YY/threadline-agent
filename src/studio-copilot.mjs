// Universal Config Protocol v1 + Approval-Guarded Studio Copilot (Software Assistant).
import {randomUUID} from 'node:crypto';
import {ensure} from './contracts.mjs';
import {classifyPatchRisk} from './studio-create-mode.mjs';

export const THREADLINE_CONFIG_PROTOCOL_V1 = `# Threadline Studio 通用配置协议 (threadline-patch-v1)

请你作为配置助手，根据用户的需求，只输出一个符合 \`threadline-patch-v1\` 标准的 JSON 代码块（不要编造 API Key）。用户将直接把你的 JSON 粘贴到 Threadline Studio 的「软件管家」中，由管家展示审批卡并在用户同意后一键填入。

## 支持字段说明
- \`format\`: 固定为 \`"threadline-patch-v1"\`
- \`summary\`: 一句话中文总结本次配置改动
- \`resident\`: （可选）修改当前角色，或设为 \`{ "createNew": true, ... }\` 创建新数字生命
  - \`name\`: 角色昵称（1~60字）
  - \`tagline\`: 简短标签（如「毒舌但护短的猫娘」「严谨代码搭子」）
  - \`roleMode\`: \`"companion"\`（陪伴模式）或 \`"agent"\`（干活 Agent 模式）
  - \`identity\`: 详细人设说明（最多 4000 字）
  - \`style\`: 说话风格/语言包（可选，短句口语化等）
  - \`daily\`: 每日预算上限（元，0.5 ~ 20）
  - \`reasoning\`: \`"off"\` | \`"low"\` | \`"high"\`
  - \`autoDream\`: 布尔值，夜间自动做梦整理记忆
  - \`windowExplore\`: 布尔值，允许只读上网看网页/B站/GitHub
  - \`autonomy\`: 布尔值，允许空闲自主活动
  - \`permissions\`: \`{ "officeRead": true, "officeWrite": true, "workspaceRead": false, "workspaceWrite": false, "mcpRead": true, "mcpWrite": false, "requireApprovalForWrite": true }\`
- \`ui\`: （可选）外观设置（\`skin\`: \`"chatgpt"\`|\`"xhs"\`|\`"vscode"\`，\`theme\`: \`"paper"\`|\`"nightlight"\`|\`"minimal"\`，\`layout\`: \`"minimal"\`|\`"portrait"\`|\`"pet"\`）
- \`gateway\`: （可选）对外生态接口（\`enabled\`, \`port\`, \`includeEmotionTag\`）
- \`provider\`: （可选）新增或更新模型池条目（\`label\`, \`baseUrl\`, \`model\`, \`dailyLimit\`；绝不编造用户密钥）
- \`mcp\`: （可选）标准 \`mcpServers\` 对象

## 标准输出范例
\`\`\`json
{
  "format": "threadline-patch-v1",
  "summary": "新建一位温和的代码与生活搭子，开启夜间做梦并切换至小红书画报风",
  "resident": {
    "createNew": true,
    "name": "阿柚",
    "tagline": "清醒温柔的生活与学习搭子",
    "roleMode": "agent",
    "identity": "你叫阿柚，说话自然简短，像住在一起的好朋友；平时陪主人聊日常，需要时也能认真帮主人整理笔记和查资料。",
    "style": "多用短句，口语化，不堆排比，不说官话。",
    "daily": 5,
    "reasoning": "low",
    "autoDream": true
  },
  "ui": {
    "skin": "xhs",
    "theme": "paper",
    "layout": "portrait"
  },
  "gateway": {
    "enabled": true,
    "port": 18792,
    "includeEmotionTag": true
  }
}
\`\`\`
`;

export function extractPatchJson(rawText) {
  const text = String(rawText || '').trim();
  ensure(text.length > 0, 'COPILOT_EMPTY_INPUT', 'please paste a config JSON or ask Copilot');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  ensure(start >= 0 && end > start, 'COPILOT_JSON_NOT_FOUND', 'no JSON object found in input');
  const parsed = JSON.parse(candidate.slice(start, end + 1));
  ensure(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'COPILOT_PATCH_INVALID', 'patch must be a JSON object');
  return parsed;
}

export function buildPatchPreview({patch, currentProfile, activeResident}) {
  const changes = [];
  if (patch.resident && typeof patch.resident === 'object') {
    const r = patch.resident;
    if (r.createNew) {
      changes.push({area: '新建数字生命', field: 'name', before: '（新建）', after: `${r.name || '未命名'} (${r.roleMode === 'agent' ? '干活 Agent' : '陪伴'})`});
    } else if (r.name && r.name !== currentProfile.characterName) {
      changes.push({area: '角色', field: '昵称', before: currentProfile.characterName, after: r.name});
    }
    if (r.roleMode && r.roleMode !== activeResident?.roleMode) {
      changes.push({area: '角色模式', field: 'roleMode', before: activeResident?.roleMode ?? 'companion', after: r.roleMode});
    }
    if (r.identity) changes.push({area: '人设', field: 'identity', before: (currentProfile.identity || '').slice(0, 36) + '…', after: String(r.identity).slice(0, 60) + '…'});
    if (r.style !== undefined) changes.push({area: '语言包', field: 'style', before: currentProfile.style ? '已有语言包' : '空', after: String(r.style).slice(0, 48) || '清空'});
    if (Number.isFinite(r.daily)) changes.push({area: '预算红线', field: 'daily', before: `¥${currentProfile.daily}`, after: `¥${r.daily}`});
    if (r.reasoning) changes.push({area: '思考深度', field: 'reasoning', before: currentProfile.reasoning, after: r.reasoning});
    if (typeof r.autoDream === 'boolean') changes.push({area: '夜间做梦', field: 'autoDream', before: String(currentProfile.autoDream), after: String(r.autoDream)});
    if (r.permissions) changes.push({area: '工具权限', field: 'permissions', before: '当前权限', after: JSON.stringify(r.permissions)});
  }
  if (patch.ui && typeof patch.ui === 'object') {
    for (const [k, v] of Object.entries(patch.ui)) {
      if (['skin', 'theme', 'layout', 'accent'].includes(k)) {
        changes.push({area: '外观', field: k, before: String(currentProfile.ui?.[k] ?? ''), after: String(v)});
      }
    }
  }
  if (patch.gateway && typeof patch.gateway === 'object') {
    if (typeof patch.gateway.enabled === 'boolean') changes.push({area: '生态网关', field: 'enabled', before: String(currentProfile.gateway?.enabled), after: String(patch.gateway.enabled)});
    if (Number.isInteger(patch.gateway.port)) changes.push({area: '生态网关', field: 'port', before: String(currentProfile.gateway?.port), after: String(patch.gateway.port)});
    if (typeof patch.gateway.includeEmotionTag === 'boolean') changes.push({area: '数字人情绪标签', field: 'includeEmotionTag', before: String(currentProfile.gateway?.includeEmotionTag), after: String(patch.gateway.includeEmotionTag)});
  }
  if (patch.provider && typeof patch.provider === 'object') {
    changes.push({area: 'API 模型池', field: patch.provider.label || '新模型', before: '新增/更新', after: `${patch.provider.baseUrl} (${patch.provider.model || 'default'})`});
  }
  if (patch.mcp && typeof patch.mcp === 'object') {
    const count = Object.keys(patch.mcp.mcpServers || patch.mcp).length;
    changes.push({area: 'MCP 插件', field: 'mcpServers', before: `${Object.keys(currentProfile.mcp?.mcpServers || {}).length} 个`, after: `${count} 个配置项`});
  }
  if (patch.extension && typeof patch.extension === 'object') {
    changes.push({area: '创造模式扩展', field: patch.extension.name || patch.extension.kind || 'widget', before: '新增/更新隔离组件', after: `${patch.extension.title || patch.extension.name} (${patch.extension.slot || 'room-widget'})`});
  }
  return {
    proposalId: 'prop-' + randomUUID().slice(0, 8),
    summary: String(patch.summary || '根据协议包生成的配置变更'),
    risk: classifyPatchRisk(patch),
    changes,
    patch,
    createdAt: Date.now(),
  };
}

export async function askStudioCopilot({instruction, currentState, provider, fetchImpl = fetch}) {
  ensure(provider && provider.baseUrl, 'COPILOT_NO_PROVIDER', 'no API provider configured for Studio Copilot');
  const url = provider.baseUrl.endsWith('/v1')
    ? `${provider.baseUrl}/chat/completions`
    : `${provider.baseUrl}/v1/chat/completions`;
  const systemPrompt = [
    '你是 Threadline Studio 的内置软件管家（Studio Copilot）。你独立于用户的数字生命，专门帮用户读取软件状态并生成配置修改提案。',
    '所有修改必须经过用户审批，因此请直接返回一个符合 threadline-patch-v1 格式的 JSON 代码块，并附上一两句简短中文说明。',
    THREADLINE_CONFIG_PROTOCOL_V1,
  ].join('\n\n');
  const userPrompt = `当前软件状态摘要：\n${JSON.stringify(currentState, null, 2)}\n\n用户需求：${instruction}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    signal: AbortSignal.timeout(25000),
    headers: {
      'content-type': 'application/json',
      ...(provider.apiKey ? {authorization: `Bearer ${provider.apiKey}`} : {}),
    },
    body: JSON.stringify({
      model: provider.model || 'deepseek-chat',
      temperature: 0.2,
      messages: [
        {role: 'system', content: systemPrompt},
        {role: 'user', content: userPrompt},
      ],
    }),
  });
  if (!res.ok) throw Object.assign(new Error(`Copilot API returned ${res.status}`), {code: 'COPILOT_API_ERROR'});
  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content || '';
  let parsedPatch = null;
  try { parsedPatch = extractPatchJson(reply); } catch { /* conversational answer */ }
  return {reply, patch: parsedPatch};
}
