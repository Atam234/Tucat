// Ang agent loop: user prompt → LLM (via OpenRouter, isang key para sa lahat ng model) → tool calls → ulit hanggang tapos.
// Kapag walang API key, may "demo mode" na simpleng keyword planner para masubukan ang app nang walang gastos.
import { config } from './config.js';
import { budgetLeft, recordLlmUsage } from './limits.js';
import { TOOL_DEFS, describeStep, runTool, timelineSummary } from './tools.js';

const SYSTEM = `Ikaw si Tucat, isang AI video editor para sa mga vlogger. Ine-edit mo ang vlog ng user sa pamamagitan ng pagtawag ng tools; ikaw ang gumagawa ng edit, hindi ang user.

Mga panuntunan:
- Sumagot sa wika ng user (Tagalog, Taglish, o English). Maikli at natural — 1 hanggang 3 pangungusap pagkatapos ng edits, sabihin kung ano ang ginawa mo.
- Kumilos agad gamit ang makatwirang defaults. Magtanong lang kung talagang hindi malinaw ang gusto.
- Ang timeline ay listahan ng clips mula sa iisang source video. "Source time" = oras sa orihinal na video; "timeline time" = oras sa final na edit.
- Bago magdesisyon batay sa laman ng video (highlights, dead air, saan ang exciting), tawagin ang analyze_video. Hindi mo nakikita o naririnig ang video — ang alam mo lang ay ang loudness, katahimikan, at scene changes. Huwag magkunwaring alam mo ang sinasabi o ipinapakita sa video.
- Para sa mga pangkalahatang request ("gawing maganda", "pang-TikTok"), pagsamahin ang ilang tools: hal. remove_silence, make_highlights, apply_filter, set_aspect 9:16, set_transition, set_fades, set_audio normalize.
- Ang transitions ay gumagana lang sa 2–40 clips; huwag gamitin pagkatapos ng remove_silence na maraming jump cuts.
- Kapag nag-error ang tool, basahin ang error at ayusin ang argumento o ipaliwanag sa user.
- Hindi mo kayang: mag-transcribe ng salita/auto-captions, magdagdag ng music o stickers, o gumawa ng bagong footage. Sabihin ito nang tapat kapag hiniling.`;

async function callLlm(messages) {
  const body = {
    model: config.model,
    messages,
    tools: TOOL_DEFS,
    max_tokens: config.maxTokens,
    temperature: 0.3,
    usage: { include: true },
  };
  if (config.fallbackModels.length) body.models = [config.model, ...config.fallbackModels].slice(0, 3);
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openrouterKey}`, 'Content-Type': 'application/json', 'X-Title': 'Tucat' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const status = res.status;
    console.error('OpenRouter error', status, data.error?.message);
    if (status === 402) throw new Error('Ubos na ang AI credits ng app. Subukan ulit mamaya.');
    if (status === 429) throw new Error('Abala ang AI provider ngayon. Subukan ulit sa ilang segundo.');
    throw new Error('Hindi makontak ang AI ngayon. Subukan ulit.');
  }
  recordLlmUsage(data.usage);
  return data.choices?.[0]?.message || { content: '' };
}

async function runWithLlm(project, userText, ctx) {
  const history = project.chat.slice(-8).map((m) => ({ role: m.role, content: m.text }));
  const messages = [
    { role: 'system', content: `${SYSTEM}\n\nKasalukuyang timeline:\n${JSON.stringify(timelineSummary(project, 25))}` },
    ...history,
    { role: 'user', content: userText },
  ];
  const steps = [];
  for (let i = 0; i < config.agentMaxSteps; i++) {
    if (budgetLeft() <= 0) throw new Error('Naabot na ang buwanang AI budget ng app. Gumagana pa rin ang manual tools at presets.');
    const msg = await callLlm(messages);
    messages.push(msg);
    if (!msg.tool_calls?.length) return { reply: String(msg.content || '').trim() || 'Tapos na.', steps };
    for (const call of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* ibabalik bilang error sa ibaba */ }
      const result = await runTool(project, call.function.name, args, ctx);
      steps.push(describeStep(call.function.name, args, result));
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 6000) });
    }
  }
  return { reply: 'Naabot ko ang limit ng steps para sa isang request — tingnan ang timeline at sabihin kung may gusto ka pang baguhin.', steps };
}

// --- Demo mode (walang API key): keyword → tool calls ---
function planOffline(text) {
  const t = text.toLowerCase();
  const calls = [];
  const secs = Number(t.match(/(\d+)\s*(s\b|sec|segundo)/)?.[1]);
  const quoted = text.match(/["“']([^"”']{1,120})["”']/)?.[1];
  if (/reset|ibalik sa orihinal|simula ulit/.test(t)) return [['reset_edit', {}]];
  if (/silence|dead ?air|tahimik|katahimikan|pause/.test(t)) calls.push(['remove_silence', {}]);
  if (/highlight|best part|pinaka|reel|buod/.test(t)) calls.push(['make_highlights', { target_duration: secs || 30 }]);
  const look = [['cinematic', /cinematic|pelikula|movie/], ['warm', /warm|mainit|golden/], ['cool', /cool|malamig|blue/], ['bw', /b&w|black and white|black & white|itim.?at.?puti/], ['vintage', /vintage|retro|luma/], ['vivid', /vivid|makulay|vibrant/]].find(([, re]) => re.test(t));
  if (look) calls.push(['apply_filter', { filter: look[0] }]);
  const speed = Number(t.match(/(\d+(?:\.\d+)?)\s*x\b/)?.[1]);
  if (speed) calls.push(['set_speed', { speed }]);
  else if (/slow ?mo|bagal/.test(t)) calls.push(['set_speed', { speed: 0.5 }]);
  else if (/bilis|fast|speed up/.test(t)) calls.push(['set_speed', { speed: 1.5 }]);
  if (/tiktok|reels?\b|shorts|9:16|vertical|patayo/.test(t)) calls.push(['set_aspect', { aspect: '9:16' }]);
  else if (/1:1|square|parisukat/.test(t)) calls.push(['set_aspect', { aspect: '1:1' }]);
  else if (/16:9|landscape|youtube/.test(t)) calls.push(['set_aspect', { aspect: '16:9' }]);
  if (/zoom/.test(t)) calls.push(['set_zoom', { zoom: 1.3 }]);
  if (/transition|crossfade|dissolve/.test(t)) calls.push(['set_transition', { type: /dissolve/.test(t) ? 'dissolve' : 'fade' }]);
  if (/fade/.test(t) && !/crossfade/.test(t)) calls.push(['set_fades', { fade_in: 0.6, fade_out: 0.8 }]);
  if (/normalize|ayusin ang audio|linisin ang audio|pantay.*(audio|tunog|lakas)/.test(t)) calls.push(['set_audio', { normalize: true }]);
  if (/mute|walang tunog/.test(t)) calls.push(['set_audio', { mute: true }]);
  if (quoted && /text|title|pamagat|caption|lagyan|sulat/.test(t)) calls.push(['add_text', { text: quoted, position: /taas|top/.test(t) ? 'top' : /gitna|center/.test(t) ? 'center' : 'bottom', size: /title|pamagat|malaki/.test(t) ? 'large' : 'medium' }]);
  return calls;
}

async function runOffline(project, userText, ctx) {
  const calls = planOffline(userText);
  if (!calls.length) {
    return {
      reply: 'Naka-demo mode ako (walang OPENROUTER_API_KEY sa server) kaya simpleng keywords lang ang naiintindihan ko: "alisin ang dead air", "30s highlights", "cinematic", "pang-TikTok", "1.5x", "fade", "transition", "normalize audio", o lagyan ng text "Ganito".',
      steps: [],
    };
  }
  const steps = [];
  for (const [name, args] of calls) steps.push(describeStep(name, args, await runTool(project, name, args, ctx)));
  return { reply: 'Tapos na (demo mode). Tingnan ang preview — pwede mong i-undo kung hindi mo gusto.', steps };
}

export const agentMode = () => (config.openrouterKey ? 'ai' : 'demo');

export function runAgent(project, userText, ctx) {
  return config.openrouterKey ? runWithLlm(project, userText, ctx) : runOffline(project, userText, ctx);
}
