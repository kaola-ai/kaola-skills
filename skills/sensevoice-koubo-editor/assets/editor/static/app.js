/* ===== 状态 ===== */
const state = {
  rawSegments: [],      // [{id,start,end,text}, ...] 来自转写
  timeSegments: [],     // 更细的剪辑时间线；SenseVoice 下为逐字时间
  waveform: {step: 0.1, bins: []},
  keepIntervals: [],    // [{start,end,text,reason}, ...] 保留段
  duration: 0,
  currentTime: 0,
  previewMode: true,
  playbackRate: 1,
  sourceName: '',
  outputName: '',
  projects: [],
  projectId: '',
  dirty: false,
  activeSegId: -1,
  textSelectionIds: [],
  // 拖拽
  dragging: null,       // {i, edge} 正在拖某段保留区间 i 的 left/right 边
};
const $ = sel => document.querySelector(sel);
const TEXT_TIMELINE_LEAD = 0.12;
const CUT_START_PAD = 0.02;
const CUT_END_PAD = 0.01;
const LONG_PAUSE_SECONDS = 0.5;
const PREVIEW_SKIP_LEAD = 0.03;
const fmt = s => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), x = Math.floor(s % 60);
  return `${m}:${String(x).padStart(2,'0')}`;
};
const fmtMs = s => {
  const m = Math.floor(s/60), x = Math.floor(s%60), y = Math.floor((s%1)*10);
  return `${m}:${String(x).padStart(2,'0')}.${y}`;
};

/* ===== 区间代数 ===== */
function subtractInterval(intervals, cs, ce) {
  const out = [];
  for (const it of intervals) {
    if (ce <= it.start || cs >= it.end) { out.push({...it}); continue; }
    if (cs > it.start) out.push({...it, end: cs});
    if (ce < it.end) out.push({...it, start: ce});
  }
  return out;
}
function addInterval(intervals, ns, ne, text='', reason='') {
  const seg = {start: ns, end: ne, text: text || '', reason: reason || ''};
  const all = [...intervals, seg].sort((a,b)=>a.start-b.start);
  const merged = [];
  for (const it of all) {
    const last = merged[merged.length-1];
    if (last && it.start <= last.end + 0.01) {
      // 相邻或重叠：合并，保留更靠后的文字（通常是完整句）
      last.end = Math.max(last.end, it.end);
      if ((it.text||'').length > (last.text||'').length) { last.text = it.text; last.reason = it.reason; }
    } else merged.push(it);
  }
  return merged;
}

function segmentsOverlapping(start, end) {
  const source = state.timeSegments.length ? state.timeSegments : state.rawSegments;
  return source.filter(seg => {
    const overlap = Math.min(seg.end, end) - Math.max(seg.start, start);
    const span = Math.max(0.001, seg.end - seg.start);
    const center = (seg.start + seg.end) / 2;
    return overlap / span >= 0.5 || (center >= start && center <= end);
  });
}

function textUnitsInSegment(seg) {
  if (!state.timeSegments.length) return [seg];
  const units = state.timeSegments.filter(unit => unit.end > seg.start + 0.001 && unit.start < seg.end - 0.001);
  return units.length ? units : [seg];
}

function normalizeToTranscriptSegments(intervals) {
  const source = state.timeSegments.length ? state.timeSegments : state.rawSegments;
  if (!source.length) return intervals.filter(it=>it.end>it.start).sort((a,b)=>a.start-b.start);
  const picked = new Map();
  for (const it of intervals) {
    for (const seg of segmentsOverlapping(it.start, it.end)) picked.set(seg.id, seg);
  }
  const selected = [...picked.values()].sort((a,b)=>a.start-b.start);
  const normalized = [];
  let current = null;
  for (const seg of selected) {
    if (current && seg.start <= current.end + 0.01) {
      current.end = Math.max(current.end, seg.end);
      current.text += seg.text || '';
    } else {
      if (current) normalized.push(current);
      current = {start: seg.start, end: seg.end, text: seg.text || '', reason: '按转写段整段保留'};
    }
  }
  if (current) normalized.push(current);
  return normalized;
}

function nearestSegmentBoundary(time, edge) {
  const source = state.timeSegments.length ? state.timeSegments : state.rawSegments;
  if (!source.length) return time;
  let best = time;
  let bestDistance = Infinity;
  for (const seg of source) {
    const candidates = edge === 'left' ? [seg.start] : [seg.end];
    for (const candidate of candidates) {
      const distance = Math.abs(candidate - time);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }
  return best;
}

function roundToStep(value, step=0.01) {
  return Math.round(value / step) * step;
}

function waveformEdgeAt(time, searchRadius=0.08) {
  const bins = state.waveform?.bins || [];
  const step = state.waveform?.step || 0.01;
  if (!bins.length) return null;
  const targetIndex = Math.max(0, Math.min(bins.length - 1, Math.round(time / step)));
  const radiusBins = Math.max(1, Math.round(searchRadius / step));
  let best = null;
  for (let i = Math.max(1, targetIndex - radiusBins); i <= Math.min(bins.length - 1, targetIndex + radiusBins); i++) {
    const prev = bins[i - 1] || {rms_n: 0, peak_n: 0};
    const cur = bins[i] || {rms_n: 0, peak_n: 0};
    const score = Math.abs((cur.rms_n || 0) - (prev.rms_n || 0)) + Math.abs((cur.peak_n || 0) - (prev.peak_n || 0)) * 0.5;
    const distancePenalty = Math.abs(i - targetIndex) * 0.015;
    const rankedScore = score - distancePenalty;
    if (!best || rankedScore > best.rankedScore) {
      best = {time: roundToStep(i * step, step), score, rankedScore};
    }
  }
  return best && best.score >= 0.16 ? best : null;
}

function refineTimeByWaveform(time) {
  const edge = waveformEdgeAt(time);
  if (edge) return Number(edge.time.toFixed(2));
  return Number(time.toFixed(2));
}

function refineRangeByWaveform(range) {
  const start = refineTimeByWaveform(range.start);
  const end = refineTimeByWaveform(range.end);
  if (end > start + 0.03) return {...range, start, end, reason: '按文字选择后，用 0.01 秒声音波形突变校准剪点'};
  return {...range, start: Number(range.start.toFixed(2)), end: Number(range.end.toFixed(2)), reason: '按文字选择剪辑；未找到明显波形突变时保留文字时间'};
}

function isSpeechWaveBin(bin) {
  return (bin.rms_n || 0) >= 0.02 || (bin.peak_n || 0) >= 0.03 || (bin.delta || 0) >= 0.08;
}

function mergeSpeechSpans(spans, maxGap=0.25) {
  const merged = [];
  for (const span of spans.sort((a,b)=>a.start-b.start)) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end + maxGap) last.end = Math.max(last.end, span.end);
    else merged.push({...span});
  }
  return merged;
}

function speechSpansBetween(start, end) {
  const bins = state.waveform?.bins || [];
  const step = state.waveform?.step || 0.1;
  const spans = bins
    .filter(bin => bin.t >= start - 0.25 && bin.t <= end + 0.25 && isSpeechWaveBin(bin))
    .map(bin => ({start: bin.t, end: bin.t + step}));
  return mergeSpeechSpans(spans);
}

function tokenWeight(text) {
  if (!text || /\s/.test(text)) return 0.15;
  if (/^[，。、；：？！,.!?;:、]$/.test(text)) return 0.25;
  return 1;
}

function timeAtSpeechProgress(spans, progress) {
  if (!spans.length) return 0;
  const total = spans.reduce((sum, span) => sum + Math.max(0, span.end - span.start), 0);
  if (total <= 0) return spans[0].start;
  let target = Math.max(0, Math.min(1, progress)) * total;
  for (const span of spans) {
    const length = Math.max(0, span.end - span.start);
    if (target <= length) return span.start + target;
    target -= length;
  }
  return spans[spans.length - 1].end;
}

function alignUnitsToWaveform(units) {
  if (!state.waveform?.bins?.length || !units.length) return units;
  const groups = new Map();
  for (const unit of units) {
    const key = Number.isFinite(unit.utterance_index) ? unit.utterance_index : unit.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(unit);
  }
  const aligned = [];
  for (const group of groups.values()) {
    const sorted = group.slice().sort((a,b)=>a.start-b.start || a.id-b.id);
    const groupStart = Math.min(...sorted.map(unit => unit.start));
    const groupEnd = Math.max(...sorted.map(unit => unit.end));
    const spans = speechSpansBetween(groupStart, groupEnd);
    if (!spans.length) {
      aligned.push(...sorted);
      continue;
    }
    const weights = sorted.map(unit => tokenWeight(unit.text));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || sorted.length;
    let cursor = 0;
    sorted.forEach((unit, index) => {
      const next = cursor + weights[index];
      const start = timeAtSpeechProgress(spans, cursor / totalWeight);
      const end = timeAtSpeechProgress(spans, next / totalWeight);
      aligned.push({
        ...unit,
        start: Number(start.toFixed(3)),
        end: Number(Math.max(end, start + 0.02).toFixed(3)),
        start_01: Number(roundToStep(start, 0.1).toFixed(1)),
        end_01: Number(roundToStep(Math.max(end, start + 0.02), 0.1).toFixed(1)),
        waveform_aligned: true,
      });
      cursor = next;
    });
  }
  return aligned.sort((a,b)=>a.start-b.start || a.id-b.id);
}

function applyTextTimelineLead(units) {
  return units.map(unit => {
    const start = Math.max(0, unit.start - TEXT_TIMELINE_LEAD);
    const end = Math.max(start + 0.02, unit.end - TEXT_TIMELINE_LEAD);
    return {
      ...unit,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      start_01: Number(roundToStep(start, state.waveform?.step || 0.01).toFixed(2)),
      end_01: Number(roundToStep(end, state.waveform?.step || 0.01).toFixed(2)),
      timeline_lead: TEXT_TIMELINE_LEAD,
    };
  });
}

function waveformDisplayBins() {
  const bins = state.waveform?.bins || [];
  if (bins.length <= 2400) return bins;
  const groupSize = Math.ceil(bins.length / 2400);
  const result = [];
  for (let i = 0; i < bins.length; i += groupSize) {
    const group = bins.slice(i, i + groupSize);
    const best = group.reduce((winner, bin) => {
      const score = (bin.peak_n || 0) + (bin.rms_n || 0) + (bin.delta || 0);
      const winnerScore = (winner.peak_n || 0) + (winner.rms_n || 0) + (winner.delta || 0);
      return score > winnerScore ? bin : winner;
    }, group[0]);
    result.push(best);
  }
  return result;
}

/* 把保留区间与全时长交错成 keep/cut 块 */
function buildBlocks(intervals, duration) {
  const blocks = [];
  let cursor = 0;
  for (const it of intervals) {
    if (it.start > cursor) blocks.push({type:'cut', start:cursor, end:it.start});
    blocks.push({type:'keep', start:it.start, end:it.end, text:it.text||'', reason:it.reason||''});
    cursor = it.end;
  }
  if (cursor < duration) blocks.push({type:'cut', start:cursor, end:duration});
  return blocks;
}

/* 判断某转写段在保留/剪掉。保留片段会贴齐转写段，所以不再显示“半”。 */
function segStatus(seg) {
  let overlap = 0;
  for (const it of state.keepIntervals) {
    if (it.end <= seg.start || it.start >= seg.end) continue;
    overlap += Math.min(it.end, seg.end) - Math.max(it.start, seg.start);
  }
  const span = seg.end - seg.start;
  if (span <= 0) return {status:'kept', ratio:0};
  if (overlap <= 0.001) return {status:'cut', ratio:0};
  if (span <= 1.2 && overlap / span < 0.5) return {status:'cut', ratio:overlap/span};
  return {status:'kept', ratio:Math.min(1, overlap/span)};
}

/* 切换一整段转写的保留/剪掉 */
function toggleSeg(seg) {
  const {status} = segStatus(seg);
  if (status === 'kept') {
    state.keepIntervals = subtractInterval(state.keepIntervals, seg.start, seg.end);
  } else {
    // cut / partial -> 整段保留
    state.keepIntervals = subtractInterval(state.keepIntervals, seg.start, seg.end);
    state.keepIntervals = addInterval(state.keepIntervals, seg.start, seg.end, seg.text, '用户在转写面板整段保留');
  }
  state.dirty = true;
  refreshAll();
}

function toggleTextUnit(unit) {
  toggleSeg(unit);
}

function togglePause(pause) {
  const {status} = segStatus(pause);
  if (status === 'kept') {
    state.keepIntervals = subtractInterval(state.keepIntervals, pause.start, pause.end);
  } else {
    state.keepIntervals = addInterval(state.keepIntervals, pause.start, pause.end, '', '用户恢复语言之间的停顿');
  }
  state.dirty = true;
  refreshAll();
}

function rangesFromUnits(units) {
  const sorted = units
    .filter(unit => Number.isFinite(unit.start) && Number.isFinite(unit.end) && unit.end > unit.start)
    .sort((a,b)=>a.start-b.start);
  const ranges = [];
  let current = null;
  for (const unit of sorted) {
    if (current && unit.start <= current.end + 0.01) {
      current.end = Math.max(current.end, unit.end);
      current.text += unit.text || '';
    } else {
      if (current) ranges.push(current);
      current = {start: unit.start, end: unit.end, text: unit.text || ''};
    }
  }
  if (current) ranges.push(current);
  return ranges;
}

function selectedTextUnits() {
  const ids = new Set(state.textSelectionIds);
  return (state.timeSegments.length ? state.timeSegments : state.rawSegments).filter(unit => ids.has(unit.id));
}

function paddedCutRange(range) {
  return {
    ...range,
    start: Math.max(0, Number((range.start - CUT_START_PAD).toFixed(3))),
    end: Number((range.end + CUT_END_PAD).toFixed(3)),
  };
}

function applyTextSelection(keep) {
  const units = selectedTextUnits();
  if (!units.length) return;
  let intervals = state.keepIntervals;
  for (const range of rangesFromUnits(units)) {
    if (keep) {
      const keepRange = {
        ...range,
        reason: '用户按文字选择保留；按 0.01 秒逐字时间线精确恢复',
      };
      intervals = addInterval(intervals, keepRange.start, keepRange.end, keepRange.text, keepRange.reason);
    } else {
      const cutRange = paddedCutRange(range);
      intervals = subtractInterval(intervals, cutRange.start, cutRange.end);
    }
  }
  intervals = normalizeToTranscriptSegments(intervals);
  if (!keep) {
    for (const unit of units) {
      const cutUnit = paddedCutRange(unit);
      intervals = subtractInterval(intervals, cutUnit.start, cutUnit.end);
    }
  }
  state.keepIntervals = intervals.filter(it => it.end > it.start + 0.01);
  state.dirty = true;
  state.textSelectionIds = [];
  const selection = window.getSelection();
  if (selection) selection.removeAllRanges();
  refreshAll();
}

function playTextSelection() {
  const ranges = rangesFromUnits(selectedTextUnits());
  if (!ranges.length) return;
  seekTo(ranges[0].start);
  $('#video').play();
}

function updateTextSelectionUi() {
  const selected = new Set(state.textSelectionIds);
  document.querySelectorAll('.word-token').forEach(token => {
    token.classList.toggle('selected', selected.has(+token.dataset.id));
  });
  const units = selectedTextUnits();
  const label = $('#text-selection-count');
  if (label) {
    const text = units.map(unit => unit.text).join('');
    label.textContent = units.length ? `已选 ${units.length} 字 · ${text.slice(0, 18)}${text.length > 18 ? '…' : ''}` : '未选择文字';
  }
  ['#btn-play-selected', '#btn-cut-selected', '#btn-keep-selected'].forEach(sel => {
    const button = $(sel);
    if (button) button.disabled = !units.length;
  });
}

function captureTextSelection() {
  const editor = $('#text-editor');
  if (!editor) return;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    state.textSelectionIds = [];
    updateTextSelectionUi();
    return;
  }
  const range = selection.getRangeAt(0);
  const ids = [];
  editor.querySelectorAll('.word-token').forEach(token => {
    try {
      if (range.intersectsNode(token)) ids.push(+token.dataset.id);
    } catch (e) {}
  });
  state.textSelectionIds = ids;
  updateTextSelectionUi();
}

function copyTextEditorSelection(event) {
  const editor = $('#text-editor');
  const selection = window.getSelection();
  if (!editor || !selection || selection.rangeCount === 0 || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const copied = [];
  editor.querySelectorAll('.word-token').forEach(token => {
    try {
      if (range.intersectsNode(token)) copied.push(token.textContent || '');
    } catch (e) {}
  });
  if (!copied.length) return;
  event.preventDefault();
  event.clipboardData.setData('text/plain', copied.join(''));
}

function isAllKept() {
  if (state.duration <= 0) return false;
  const intervals = state.keepIntervals
    .filter(it=>it.end>it.start)
    .sort((a,b)=>a.start-b.start);
  let cursor = 0;
  for (const it of intervals) {
    if (it.start > cursor + 0.01) return false;
    cursor = Math.max(cursor, it.end);
  }
  return cursor >= state.duration - 0.01;
}

function keepAll() {
  if (state.duration <= 0 || isAllKept()) return;
  state.keepIntervals = [{
    start: 0,
    end: state.duration,
    text: '',
    reason: '用户一键全部保留',
  }];
  state.dirty = true;
  refreshAll();
}

function clearAll() {
  if (!state.keepIntervals.length) return;
  if (!confirm('确定要清空当前原片的所有保留片段吗？')) return;
  state.keepIntervals = [];
  state.dirty = true;
  refreshAll();
}

function updateBulkButtons() {
  $('#btn-keep-all').disabled = state.duration <= 0 || isAllKept();
  $('#btn-clear-all').disabled = state.keepIntervals.length === 0;
}

/* ===== 加载数据 ===== */
async function loadProjects() {
  const data = await fetch('/api/projects').then(r=>r.json());
  state.projects = (data.projects||[]).filter(p=>p.available);
  const saved = localStorage.getItem('cut-podcast-project');
  state.projectId = state.projects.some(p=>p.id===saved)
    ? saved
    : (state.projects.some(p=>p.id===data.default) ? data.default : state.projects[0]?.id || '');
  const select = $('#project-select');
  select.innerHTML = '';
  state.projects.forEach(p => {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = p.label;
    select.appendChild(option);
  });
  select.value = state.projectId;
  select.disabled = state.projects.length < 2;
}

async function loadData() {
  const q = '?project=' + encodeURIComponent(state.projectId);
  const [rawR, keepR, waveformR] = await Promise.all([
    fetch('/api/raw'+q).then(r=>r.json()),
    fetch('/api/keep'+q).then(r=>r.json()),
    fetch('/api/waveform'+q).then(r=>r.json()).catch(()=>({step:0.1,bins:[]})),
  ]);
  state.rawSegments = (rawR.segments||[]).map((s,i)=>({id:i, start:s.start, end:s.end, text:s.text||''}));
  state.timeSegments = (rawR.chars&&rawR.chars.length ? rawR.chars : rawR.segments||[])
    .map((s,i)=>({
      id:i,
      start:Number.isFinite(s.start) ? s.start : s.start_01,
      end:Number.isFinite(s.end) ? s.end : s.end_01,
      text:s.text||'',
      utterance_index:s.utterance_index,
      char_index:s.char_index,
    }))
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
  state.waveform = {step: waveformR.step || 0.1, bins: waveformR.bins || []};
  state.timeSegments = applyTextTimelineLead(alignUnitsToWaveform(state.timeSegments));
  state.keepIntervals = normalizeToTranscriptSegments((keepR.keep_intervals||[]).map(it=>({start:it.start, end:it.end, text:it.text||'', reason:it.reason||''})));
  state.duration = rawR.duration || keepR.duration || (state.rawSegments.at(-1)?.end || 0);
  const project = state.projects.find(p=>p.id===state.projectId);
  const modelName = rawR.engine ? ` · ${rawR.engine}` : '';
  const precision = rawR.precision?.time_step_seconds ? ` · ${rawR.precision.time_step_seconds}s逐字线` : '';
  const waveformName = state.waveform.bins.length ? ` · 波形${state.waveform.step}s校准` : '';
  const alignName = state.timeSegments.some(unit => unit.waveform_aligned) ? ' · 逐字按波形重排' : '';
  const leadName = state.timeSegments.some(unit => unit.timeline_lead) ? ` · 文字提前${TEXT_TIMELINE_LEAD}s` : '';
  state.sourceName = `${rawR.source || keepR.source || project?.video || ''}${modelName}${precision}${waveformName}${alignName}${leadName}`;
  state.outputName = keepR.output || '';
  state.currentTime = 0;
  state.activeSegId = -1;
  state.textSelectionIds = [];
  state.dirty = false;
  $('#source-name').textContent = state.sourceName ? `原片：${state.sourceName}` : '';
  const video = $('#video');
  video.pause();
  video.src = '/api/video' + q;
  video.load();
  const topDownload = $('#btn-download-top');
  topDownload.classList.add('hidden');
  topDownload.removeAttribute('href');
  refreshAll();
  checkExistingOutput();
}

async function switchProject(nextId) {
  if (!nextId || nextId === state.projectId) return;
  const previousId = state.projectId;
  if (state.dirty && !await saveKeep(true)) throw new Error('当前原片的修改保存失败');
  state.projectId = nextId;
  try {
    await loadData();
    localStorage.setItem('cut-podcast-project', nextId);
  } catch (err) {
    state.projectId = previousId;
    $('#project-select').value = previousId;
    throw err;
  }
}

// 检测硬盘上是否已有渲染好的成片（刷新页面后也能直接下载，不必重渲染）
async function checkExistingOutput() {
  const out = state.outputName;
  const projectId = state.projectId;
  try {
    const params = new URLSearchParams({project: projectId});
    if (out) params.set('out', out);
    const r = await fetch('/api/output?' + params.toString(), { headers: { Range: 'bytes=0-0' } });
    if ((r.status === 206 || r.status === 200) && projectId === state.projectId) showOutputLink(out, projectId);
  } catch(e) {}
}
function showOutputLink(out, projectId=state.projectId) {
  if (projectId !== state.projectId) return;
  const params = new URLSearchParams({project: projectId, t: String(Date.now())});
  if (out) params.set('out', out);
  const url = '/api/output?' + params.toString();
  const btn = $('#btn-download-top');
  btn.href = url;
  btn.download = out || 'output.mp4';
  btn.classList.remove('hidden');
}

/* ===== 渲染：时间轴 ===== */
function renderTimeline() {
  const tl = $('#timeline');
  tl.innerHTML = '';
  const dur = Math.max(state.duration, 1);
  for (const bin of waveformDisplayBins()) {
    const bar = document.createElement('div');
    bar.className = 'wf-bar';
    bar.style.left = (bin.t / dur * 100) + '%';
    bar.style.width = Math.max(0.08, ((state.waveform.step || 0.1) / dur * 100)) + '%';
    bar.style.height = Math.max(2, (bin.peak_n || bin.rms_n || 0) * 74) + 'px';
    if ((bin.delta || 0) >= 0.16) bar.classList.add('edge');
    tl.appendChild(bar);
  }
  const blocks = buildBlocks(state.keepIntervals, state.duration);
  for (let i=0;i<blocks.length;i++) {
    const b = blocks[i];
    const el = document.createElement('div');
    el.className = `tl-block ${b.type}`;
    el.title = b.type === 'keep' ? '点击跳到这个保留片段的位置' : '点击跳到这个剪掉片段的位置';
    el.style.left = (b.start/dur*100) + '%';
    el.style.width = ((b.end-b.start)/dur*100) + '%';
    const txt = document.createElement('div'); txt.className='tl-text';
    txt.textContent = b.type==='keep' ? (b.text||'保留') : '剪掉';
    el.appendChild(txt);
    const d = document.createElement('div'); d.className='tl-dur';
    d.textContent = (b.end-b.start).toFixed(1)+'s';
    el.appendChild(d);
    if (b.type === 'keep') {
      const lh = document.createElement('div'); lh.className='handle left';
      lh.onmousedown = e => startDrag(e, i, 'left', blocks);
      el.appendChild(lh);
      const rh = document.createElement('div'); rh.className='handle right';
      rh.onmousedown = e => startDrag(e, i, 'right', blocks);
      el.appendChild(rh);
      // 导出此片段按钮
      const expBtn = document.createElement('button');
      expBtn.className = 'tl-export-btn';
      expBtn.title = '导出此片段';
      expBtn.textContent = '⬇';
      expBtn.onclick = e => {
        e.stopPropagation();
        e.preventDefault();
        exportSegment(b, expBtn);
      };
      el.appendChild(expBtn);
    }
    el.onclick = e => {
      if (state.dragging) return;
      if (e.target.closest('.handle')) return;  // 拖拽手柄交给 mousedown，不定位
      // 定位到点击的精确位置，而不是块起点
      const rect = tl.getBoundingClientRect();
      seekTo((e.clientX - rect.left)/rect.width * state.duration);
    };
    tl.appendChild(el);
  }
  updatePlayhead();
}
function updatePlayhead() {
  const ph = $('#playhead');
  const dur = Math.max(state.duration, 1);
  ph.style.left = (state.currentTime/dur*100) + '%';
}

/* ===== 渲染：按文字剪辑区 ===== */
function renderTextEditor() {
  const box = $('#text-editor');
  if (!box) return;
  box.innerHTML = '';
  const source = state.timeSegments.length ? state.timeSegments : state.rawSegments;
  const selected = new Set(state.textSelectionIds);
  let previousUnit = null;
  for (const unit of source) {
    if (previousUnit && unit.start - previousUnit.end >= LONG_PAUSE_SECONDS) {
      const pause = {
        start: previousUnit.end,
        end: unit.start,
        text: '',
      };
      const pauseStatus = segStatus(pause).status;
      const pauseToken = document.createElement('span');
      pauseToken.className = `pause-token is-${pauseStatus}`;
      pauseToken.textContent = `空白 ${Number((pause.end - pause.start).toFixed(2))}s`;
      pauseToken.title = `${fmtMs(pause.start)}–${fmtMs(pause.end)} · 点击${pauseStatus==='kept'?'剪掉':'恢复'}这段停顿；复制文稿时不会复制它`;
      pauseToken.onclick = e => {
        e.stopPropagation();
        seekTo(pause.start);
        togglePause(pause);
      };
      box.appendChild(pauseToken);
    }
    const status = segStatus(unit).status;
    const token = document.createElement('span');
    token.className = `word-token is-${status}${selected.has(unit.id) ? ' selected' : ''}`;
    token.dataset.id = unit.id;
    token.textContent = unit.text || '';
    token.title = `${fmtMs(unit.start)}–${fmtMs(unit.end)} · 单击定位，拖选后可剪掉/恢复`;
    token.onclick = () => seekTo(unit.start);
    box.appendChild(token);
    if ('。！？?!'.includes(unit.text || '')) box.appendChild(document.createTextNode('\n'));
    previousUnit = unit;
  }
  updateTextSelectionUi();
}

/* ===== 渲染：转写面板 ===== */
function renderTranscript() {
  const box = $('#transcript');
  box.innerHTML = '';
  let kept=0, cut=0, charKept=0, charCut=0;
  for (const seg of state.rawSegments) {
    const st = segStatus(seg);
    if (st.status==='kept') kept++; else cut++;
    const units = textUnitsInSegment(seg);
    let keptUnits = 0;
    for (const unit of units) {
      const unitStatus = segStatus(unit).status;
      if (unitStatus === 'kept') { keptUnits++; charKept++; }
      else charCut++;
    }
    const row = document.createElement('div');
    row.className = `seg-row is-${st.status}`;
    row.dataset.id = seg.id;
    row.onclick = () => seekTo(seg.start);
    const meta = document.createElement('div'); meta.className='seg-meta';
    const time = document.createElement('div'); time.className='seg-time';
    time.textContent = fmtMs(seg.start);
    const badge = document.createElement('div'); badge.className=`seg-badge ${st.status}`;
    badge.textContent = st.status==='kept'?'留':'剪';
    meta.appendChild(time); meta.appendChild(badge);
    const text = document.createElement('div'); text.className='seg-text';
    text.title = '点击单个字：剪掉/恢复；点击行空白：定位播放';
    for (const unit of units) {
      const unitStatus = segStatus(unit).status;
      const token = document.createElement('span');
      token.className = `char-token is-${unitStatus}`;
      token.textContent = unit.text || '';
      token.title = `${fmtMs(unit.start)}–${fmtMs(unit.end)} · 点击${unitStatus==='kept'?'剪掉':'恢复'}`;
      token.onclick = e => {
        e.stopPropagation();
        seekTo(unit.start);
        toggleTextUnit(unit);
      };
      text.appendChild(token);
    }
    const tog = document.createElement('button'); tog.className='seg-toggle';
    tog.textContent = st.status==='kept'?'整句剪掉':'整句保留';
    tog.title = `这一行 ${units.length} 个字，当前保留 ${keptUnits} 个`;
    tog.onclick = e => { e.stopPropagation(); toggleSeg(seg); };
    row.appendChild(meta); row.appendChild(text); row.appendChild(tog);
    box.appendChild(row);
  }
  const unitLabel = state.timeSegments.length
    ? `${state.timeSegments.length} 字 · 留 ${charKept} · 剪 ${charCut}`
    : `${state.rawSegments.length} 段 · 留 ${kept} · 剪 ${cut}`;
  $('#seg-count').textContent = `${state.rawSegments.length} 行 · ${unitLabel}`;
  markActiveSeg(false);
}

/* ===== 渲染：剪后文稿 ===== */
function renderCutText() {
  const box = $('#cut-text');
  const kept = state.keepIntervals.filter(it=>it.end>it.start).sort((a,b)=>a.start-b.start);
  const total = kept.reduce((s,it)=>s+(it.end-it.start),0);
  const removed = state.duration - total;
  $('#kept-count').textContent = `保留 ${fmt(total)} / 共 ${fmt(state.duration)} · 剪掉 ${fmt(Math.max(0,removed))}`;
  $('#cut-duration').textContent = `剪后 ${fmt(total)}`;
  // 从逐字时间线重建剪后文稿；没有逐字数据时回退到可读转写段。
  const source = state.timeSegments.length ? state.timeSegments : state.rawSegments;
  const text = source
    .filter(seg => segStatus(seg).status !== 'cut')
    .map(seg => seg.text.trim())
    .join('');
  box.textContent = text || '（无保留内容）';
}

function intervalText(it) {
  const source = state.timeSegments.length ? state.timeSegments : state.rawSegments;
  const generated = source
    .filter(seg => seg.end > it.start && seg.start < it.end)
    .map(seg => seg.text.trim())
    .join('');
  return generated || (it.text||'').trim();
}

function renderClipList() {
  const box = $('#clip-list');
  const kept = state.keepIntervals.filter(it=>it.end>it.start).sort((a,b)=>a.start-b.start);
  $('#clip-count').textContent = kept.length ? `共 ${kept.length} 个 · 可单独导出` : '暂无片段';
  box.innerHTML = '';
  kept.forEach((it, index) => {
    const row = document.createElement('div');
    row.className = 'clip-row';

    const body = document.createElement('button');
    body.className = 'clip-body';
    body.title = '定位并播放这个片段';
    body.onclick = () => {
      seekTo(it.start);
      $('#video').play();
    };

    const meta = document.createElement('div');
    meta.className = 'clip-meta';
    meta.textContent = `片段 ${String(index+1).padStart(2,'0')} · ${fmtMs(it.start)}–${fmtMs(it.end)} · ${(it.end-it.start).toFixed(1)} 秒`;
    const text = document.createElement('div');
    text.className = 'clip-text';
    text.textContent = intervalText(it) || '（无对应文稿）';
    body.appendChild(meta);
    body.appendChild(text);

    const exportBtn = document.createElement('button');
    exportBtn.className = 'clip-export';
    exportBtn.textContent = '导出 MP4';
    exportBtn.title = `单独导出片段 ${index+1}`;
    exportBtn.onclick = () => exportSegment(it, exportBtn, index+1);

    row.appendChild(body);
    row.appendChild(exportBtn);
    box.appendChild(row);
  });
}

function refreshAll() { renderTimeline(); renderTextEditor(); renderTranscript(); renderCutText(); renderClipList(); updateBulkButtons(); }

/* ===== 拖拽边缘 ===== */
function startDrag(e, blockIdx, edge, blocks) {
  e.preventDefault(); e.stopPropagation();
  const block = blocks[blockIdx];
  const keepIndex = state.keepIntervals.findIndex(it => Math.abs(it.start-block.start)<0.01 && Math.abs(it.end-block.end)<0.01);
  if (keepIndex < 0) return;
  state.dragging = {keepIndex, edge};
  document.body.style.cursor = 'ew-resize';
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragUp);
}
function onDragMove(e) {
  if (!state.dragging) return;
  const tl = $('#timeline');
  const rect = tl.getBoundingClientRect();
  const t = Math.max(0, Math.min(state.duration, (e.clientX - rect.left)/rect.width * state.duration));
  const {keepIndex: idx, edge} = state.dragging;
  if (idx < 0 || idx >= state.keepIntervals.length) return;
  const it = state.keepIntervals[idx];
  if (edge === 'left') {
    const snapped = nearestSegmentBoundary(t, 'left');
    const newStart = Math.min(snapped, it.end - 0.1);
    state.keepIntervals[idx] = {...it, start: newStart};
  } else {
    const snapped = nearestSegmentBoundary(t, 'right');
    const newEnd = Math.max(snapped, it.start + 0.1);
    state.keepIntervals[idx] = {...it, end: newEnd};
  }
  state.dirty = true;
  // 拖拽中只重画时间轴，不重画转写（性能）
  renderTimeline();
}
function onDragUp() {
  state.keepIntervals = normalizeToTranscriptSegments(state.keepIntervals);
  state.dragging = null;
  document.body.style.cursor = '';
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragUp);
  refreshAll();
}

/* ===== 播放 / 预览跳剪 ===== */
function seekTo(t) {
  const v = $('#video');
  v.currentTime = Math.max(0, Math.min(state.duration||v.duration||0, t));
  state.currentTime = v.currentTime;
  updatePlayhead(); markActiveSeg();
}
function togglePlay() {
  const v = $('#video');
  if (v.paused) v.play(); else v.pause();
}
let rafId = null;
/* 预览跳剪：逐帧检测剪点，避免浏览器 timeupdate 太慢导致漏出剪掉字。 */
function checkPreviewSkip() {
  if (!state.previewMode) return;
  const v = $('#video');
  if (v.paused || v.seeking) return;
  const t = v.currentTime;
  const current = state.keepIntervals.find(it => t >= it.start - 0.02 && t < it.end);
  if (current) {
    if (t < current.end - PREVIEW_SKIP_LEAD) return;
    const nextAfterCurrent = state.keepIntervals.filter(it=>it.start >= current.end - 0.001).sort((a,b)=>a.start-b.start)[0];
    if (nextAfterCurrent) v.currentTime = nextAfterCurrent.start + 0.01;
    return;
  }
  const next = state.keepIntervals.filter(it=>it.start > t).sort((a,b)=>a.start-b.start)[0];
  if (next) v.currentTime = next.start + 0.01;
}
function previewLoop() {
  const v = $('#video');
  checkPreviewSkip();
  state.currentTime = v.currentTime || 0;
  updatePlayhead(); markActiveSeg();
  $('#time').textContent = `${fmt(state.currentTime)} / ${fmt(state.duration)}`;
  rafId = requestAnimationFrame(previewLoop);
}
function markActiveSeg() {
  const t = state.currentTime;
  let activeId = -1;
  for (const seg of state.rawSegments) { if (t >= seg.start && t < seg.end) { activeId = seg.id; break; } }
  document.querySelectorAll('.seg-row').forEach(r => r.classList.toggle('active', +r.dataset.id === activeId));
  let activeUnitId = -1;
  for (const unit of state.timeSegments) { if (t >= unit.start && t < unit.end) { activeUnitId = unit.id; break; } }
  document.querySelectorAll('.word-token').forEach(token => token.classList.toggle('active', +token.dataset.id === activeUnitId));
  if (activeId !== -1) {
    state.activeSegId = activeId;
  }
}

/* ===== 顶栏动作 ===== */
async function saveKeep(quiet=false) {
  const body = JSON.stringify({
    project: state.projectId,
    keep: {
      duration: state.duration, source: state.sourceName,
      keep_intervals: state.keepIntervals.map(it=>({start:it.start, end:it.end, text:it.text, reason:it.reason})),
    },
  });
  const r = await fetch('/api/keep', {method:'POST', headers:{'Content-Type':'application/json'}, body});
  const j = await r.json();
  if (j.ok) state.dirty = false;
  if (!quiet) flash($('#btn-save'), j.ok ? '已保存' : '保存失败');
  return j.ok;
}
function flash(btn, msg) {
  const old = btn.textContent; btn.textContent = msg;
  setTimeout(()=>btn.textContent=old, 1200);
}
function exportJSON() {
  const data = {duration: state.duration, source: state.sourceName, keep_intervals: state.keepIntervals};
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.sourceName||'keep') + '_保留片段.json';
  a.click(); URL.revokeObjectURL(a.href);
}
async function exportSegment(seg, btn, clipNumber=null) {
  const oldText = btn?.textContent;
  if (btn) { btn.textContent = '导出中…'; btn.disabled = true; }
  try {
    const base = (state.sourceName||'segment').replace(/\.[^.]+$/,'');
    const clipLabel = clipNumber == null ? '' : `_片段${String(clipNumber).padStart(2,'0')}`;
    const name = `${base}${clipLabel}_${fmtMs(seg.start).replace(/:/g,'-')}-${fmtMs(seg.end).replace(/:/g,'-')}.mp4`;
    const params = new URLSearchParams({project: state.projectId, start: String(seg.start), end: String(seg.end), name});
    const resp = await fetch('/api/segment?' + params.toString());
    if (!resp.ok) { const e = await resp.json().catch(()=>({error:'导出失败'})); throw new Error(e.error); }
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name; a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    alert('导出片段失败：' + err.message);
  } finally {
    if (btn) { btn.textContent = oldText || '导出 MP4'; btn.disabled = false; }
  }
}
function syncPreviewButton() {
  const b = $('#btn-preview');
  b.classList.toggle('on', state.previewMode);
  b.classList.toggle('off', !state.previewMode);
  b.textContent = state.previewMode ? '预览跳剪：开' : '预览跳剪：关';
}
function togglePreview() {
  state.previewMode = !state.previewMode;
  syncPreviewButton();
}

/* ===== 渲染出片 ===== */
let pollTimer = null;
async function startRender() {
  if (!await saveKeep()) return;
  $('#render-modal').classList.remove('hidden');
  $('#render-status').textContent = '提交中…'; $('#render-status').className='render-status';
  $('#render-log').textContent = '';
  $('#btn-play-output').classList.add('hidden');
  const r = await fetch('/api/render', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project:state.projectId})});
  const j = await r.json();
  if (!j.job) { $('#render-status').textContent='提交失败：'+(j.error||'未知错误'); $('#render-status').className='render-status error'; return; }
  pollRender(j.job);
}
function pollRender(job) {
  if (pollTimer) clearTimeout(pollTimer);
  const tick = async () => {
    try {
      const r = await fetch(`/api/render/status?job=${encodeURIComponent(job)}`);
      const j = await r.json();
      if (j.log) $('#render-log').textContent = j.log.split('\n').slice(-40).join('\n');
      if (j.status === 'done') {
        $('#render-status').textContent = `完成！${j.elapsed ? '耗时 '+j.elapsed+'s' : ''}`; $('#render-status').className='render-status done';
        $('#btn-play-output').classList.remove('hidden');
        const out = j.output || '';
        const outputParams = new URLSearchParams({project: state.projectId, t: String(Date.now())});
        if (out) outputParams.set('out', out);
        const outputUrl = '/api/output?' + outputParams.toString();
        $('#output-video').src = outputUrl;
        $('#btn-download').href = outputUrl;
        $('#btn-download').download = out || 'output.mp4';
        if (out) showOutputLink(out);
        pollTimer = null;
        return;
      }
      if (j.status === 'error') {
        $('#render-status').textContent = '失败：'+(j.error||''); $('#render-status').className='render-status error';
        pollTimer = null; return;
      }
      $('#render-status').textContent = '渲染中… ' + (j.phase||'');
      pollTimer = setTimeout(tick, 800);
    } catch(e) { pollTimer = setTimeout(tick, 1500); }
  };
  tick();
}
function showOutput() {
  $('#render-modal').classList.add('hidden');
  $('#output-modal').classList.remove('hidden');
}

/* ===== 初始化 ===== */
function init() {
  const v = $('#video');
  v.addEventListener('loadedmetadata', () => {
    if (!state.duration) { state.duration = v.duration||0; refreshAll(); }
  });
  v.addEventListener('timeupdate', () => { state.currentTime = v.currentTime; checkPreviewSkip(); });
  v.addEventListener('play', () => { if (!rafId) previewLoop(); });
  v.addEventListener('pause', () => {});
  v.addEventListener('ratechange', () => { state.playbackRate = v.playbackRate; });
  $('#btn-play').onclick = togglePlay;
  $('#rate').onchange = e => { v.playbackRate = parseFloat(e.target.value); };
  $('#btn-preview').onclick = togglePreview;
  syncPreviewButton();
  $('#btn-keep-all').onclick = keepAll;
  $('#btn-clear-all').onclick = clearAll;
  $('#btn-play-selected').onclick = playTextSelection;
  $('#btn-cut-selected').onclick = () => applyTextSelection(false);
  $('#btn-keep-selected').onclick = () => applyTextSelection(true);
  $('#btn-export').onclick = exportJSON;
  $('#btn-save').onclick = () => saveKeep();
  $('#btn-render').onclick = startRender;
  $('#project-select').onchange = async e => {
    const select = e.currentTarget;
    select.disabled = true;
    try { await switchProject(select.value); }
    catch (err) { alert('切换原片失败：' + err.message); }
    finally { select.disabled = state.projects.length < 2; }
  };
  $('#btn-render-close').onclick = () => $('#render-modal').classList.add('hidden');
  $('#btn-play-output').onclick = showOutput;
  $('#btn-output-close').onclick = () => $('#output-modal').classList.add('hidden');
  // 点击时间轴空白定位
  $('#timeline').addEventListener('click', e => {
    if (state.dragging) return;
    if (e.target.closest('.tl-block') || e.target.closest('.handle')) return;
    const rect = $('#timeline').getBoundingClientRect();
    seekTo((e.clientX - rect.left)/rect.width * state.duration);
  });
  // 鼠标移动显示时间提示
  const tip = $('#time-tip');
  const tbox = document.querySelector('.timeline-box');
  tbox.addEventListener('mousemove', e => {
    const rect = $('#timeline').getBoundingClientRect();
    const t = Math.max(0, Math.min(state.duration, (e.clientX - rect.left)/rect.width * state.duration));
    tip.textContent = fmtMs(t);
    tip.style.left = (e.clientX - rect.left) + 'px';
    tip.classList.remove('hidden');
  });
  tbox.addEventListener('mouseleave', () => tip.classList.add('hidden'));
  $('#text-editor').addEventListener('mouseup', () => setTimeout(captureTextSelection, 0));
  $('#text-editor').addEventListener('keyup', () => setTimeout(captureTextSelection, 0));
  $('#text-editor').addEventListener('copy', copyTextEditorSelection);
  // 键盘
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowLeft') { seekTo(v.currentTime - 5); }
    else if (e.code === 'ArrowRight') { seekTo(v.currentTime + 5); }
    else if (e.key === 'j') { togglePreview(); }
  });
  (async () => { await loadProjects(); await loadData(); })().catch(err => {
    $('#transcript').textContent = '加载失败：' + err.message;
  });
}
document.addEventListener('DOMContentLoaded', init);
