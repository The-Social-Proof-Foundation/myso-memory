import type { ChatModel } from "./models";

export const TITLE_MODEL_ID = "google/gemini-2.0-flash-001";
export const ARTIFACT_MODEL_ID = "anthropic/claude-3.5-haiku";

export type PricingCatalogModel = {
  aliases: string[];
  display_name: string;
  input_mist_per_1m: number;
  output_mist_per_1m: number;
};

export type PricingCatalogResponse = {
  version: string;
  source?: string;
  effective_date?: string;
  models: PricingCatalogModel[];
  reference_mist_per_1m_in: number;
  reference_mist_per_1m_out: number;
  reference_model_count: number;
  mist_per_myso: number;
};

function mistToMyso(mist: number, mistPerMyso: number): string {
  return (mist / mistPerMyso).toFixed(3);
}

export function catalogModelsToChatModels(
  catalog: PricingCatalogResponse,
  allowedIds?: Set<string>,
): ChatModel[] {
  const mistPerMyso = catalog.mist_per_myso || 1_000_000_000;
  const models: ChatModel[] = [];
  const seen = new Set<string>();

  for (const entry of catalog.models) {
    const id = entry.aliases[0];
    if (!id || seen.has(id)) {
      continue;
    }
    if (allowedIds && !allowedIds.has(id)) {
      continue;
    }
    seen.add(id);
    const provider = id.includes("/") ? id.split("/")[0] : "other";
    const inMyso = mistToMyso(entry.input_mist_per_1m, mistPerMyso);
    const outMyso = mistToMyso(entry.output_mist_per_1m, mistPerMyso);
    models.push({
      id,
      name: entry.display_name,
      provider,
      description: `~${inMyso} MYSO in / ${outMyso} MYSO out per 1M tokens (catalog)`,
    });
  }
  return models;
}

export async function fetchPricingCatalog(): Promise<PricingCatalogResponse | null> {
  const base =
    process.env.AI_CREDIT_ORACLE_URL ||
    process.env.NEXT_PUBLIC_AI_CREDIT_ORACLE_URL;
  if (!base) {
    return null;
  }
  const url = `${base.replace(/\/$/, "")}/v1/ai-credit/catalog`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as PricingCatalogResponse;
  } catch {
    return null;
  }
}
