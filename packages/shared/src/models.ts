import { EFFORTS } from './schemas.ts';
import type { DagNode, Effort } from './types.ts';

type Settings = Pick<DagNode, 'model' | 'effort'>;

/**
 * The model and effort of a node made by merging `parents`. All on the same setting: that one.
 * Otherwise (deterministic): the model that comes first by name among the parents' models, with
 * the highest effort among the parents on that model. `mixedModels` lists the different models,
 * so the merge dialog can warn. A null setting stands for the default (`defaults`).
 */
export function mergeModelSettings(
  parents: Settings[],
  defaults: { model: string; effort: Effort },
): { model: string | null; effort: Effort | null; mixedModels: string[] } {
  const effective = parents.map((p) => ({ model: p.model ?? defaults.model, effort: p.effort ?? defaults.effort }));
  const models = [...new Set(effective.map((p) => p.model))].sort();
  const same = (a: Settings, b: Settings) => a.model === b.model && a.effort === b.effort;
  if (parents.every((p) => same(p, parents[0]))) return { ...parents[0], mixedModels: [] };

  const model = models[0];
  const efforts = effective.filter((p) => p.model === model).map((p) => EFFORTS.indexOf(p.effort));
  return { model, effort: EFFORTS[Math.max(...efforts)], mixedModels: models.length > 1 ? models : [] };
}
