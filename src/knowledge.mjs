import { normalizeKnowledgeExport } from './knowledge-import.mjs';
import { readHiveMind } from './core/store.ts';
import { fingerprint } from './core/continuity.ts';
import { BrainError, saveBrainRecord, brainSnapshot } from './brain.mjs';

// Explicit normalized imports only: never scan folders or execute imported content.
export async function importKnowledge(file, input) {
  let { entries, scope, project, source, dryRun = true } = input;
  let issues = [];
  if (input.format !== undefined) {
    const normalized = normalizeKnowledgeExport(input.format, input.payload);
    entries = normalized.entries; issues = normalized.issues;
  }
  if (!Array.isArray(entries) || entries.length > 100 || !entries.length ||
      !['general', 'project'].includes(scope) || (scope === 'project' && (typeof project !== 'string' || !project.trim() || project.length > 160)) ||
      !source || !['user', 'agent', 'import'].includes(source.type) ||
      typeof source.threadId !== 'string' || source.threadId.length > 160 ||
      typeof source.provider !== 'string' || source.provider.length > 80 || typeof dryRun !== 'boolean')
    throw new BrainError(400, 'Provide 1–100 entries, scope, project when needed, and source.');
  const valid = entries.map((entry) => {
    if (!entry || typeof entry.text !== 'string' || !entry.text || entry.text.length > 12000 ||
        typeof entry.speaker !== 'string' || entry.speaker.length > 80 ||
        typeof entry.origin !== 'string' || entry.origin.length > 1000 ||
        typeof entry.recordedAt !== 'string' || entry.recordedAt.length > 40 || !Number.isFinite(Date.parse(entry.recordedAt)))
      throw new BrainError(400, 'Each entry needs text (up to 12000 characters), speaker, origin and an ISO date.');
    const data = { text: entry.text, speaker: entry.speaker, origin: entry.origin, recordedAt: entry.recordedAt };
    return { id: `evidence-${fingerprint({ data, scope, project: scope === 'project' ? project : null, source })}`,
      kind: 'evidence', scope, project, title: entry.text.slice(0, 100), source, data };
  });
  const state = (await readHiveMind(file)).continuity;
  const known = new Set(state?.records.map(r => r.id));
  const report = { dryRun, created: [], duplicates: [], excluded: [], failed: [], issues };
  for (const record of valid) {
    if (state?.forgotten.includes(record.id)) { report.excluded.push(record.id); continue; }
    if (known.has(record.id)) { report.duplicates.push(record.id); continue; }
    if (!dryRun) {
      try { await saveBrainRecord(file, record); }
      catch (error) { report.failed.push({ id: record.id, message: error.message }); continue; }
    }
    known.add(record.id);
    report.created.push(record.id);
  }
  return report;
}

export async function knowledgeView(file, input = {}) {
  const { query = '', projects, view = 'timeline' } = input;
  if (!['timeline', 'table', 'evidence'].includes(view)) throw new BrainError(400, 'Unknown knowledge view.');
  const snapshot = await brainSnapshot(file, { query, projects, includeHistory: true });
  const normalize = value => String(value).trim().toLowerCase().replace(/[\s_-]+/gu, '');
  const all = (await readHiveMind(file)).continuity?.records ?? [];
  const visible = {records: all.filter(r => !projects || r.scope === 'general' || projects.some(p => normalize(p) === normalize(r.project)))};
  const byId = new Map(visible.records.map(r => [r.id, r]));
  const records = snapshot.records.filter(r => (view === 'evidence' ? r.kind === 'evidence' : ['evidence', 'decision', 'interpretation'].includes(r.kind)));
  const rows = records.filter(r => r.kind !== 'interpretation' || r.data.active).map(r => ({
    ...r, originals: (r.data.referenceIds ?? []).map(id => byId.get(id)).filter(Boolean),
  }));
  return { ...snapshot, records: undefined, view, rows: rows.sort((a,b) => a.createdAt.localeCompare(b.createdAt)),
    truncated: snapshot.total > 200 };
}
