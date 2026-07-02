"use client";

import useSWR from "swr";
import { chatModels, type ChatModel } from "./models";
import {
  catalogModelsToChatModels,
  fetchPricingCatalog,
  type PricingCatalogResponse,
} from "./catalog";

async function loadChatModels(): Promise<ChatModel[]> {
  const catalog = await fetchPricingCatalog();
  if (!catalog?.models?.length) {
    return chatModels;
  }
  const allowedIds = new Set(chatModels.map((m) => m.id));
  const fromCatalog = catalogModelsToChatModels(catalog, allowedIds);
  if (fromCatalog.length === 0) {
    return chatModels;
  }
  // Preserve static models not in catalog (e.g. thinking variants).
  const catalogIds = new Set(fromCatalog.map((m) => m.id));
  const extras = chatModels.filter((m) => !catalogIds.has(m.id));
  return [...fromCatalog, ...extras];
}

export function useChatModels(): {
  models: ChatModel[];
  catalog: PricingCatalogResponse | null;
  isLoading: boolean;
} {
  const { data, isLoading } = useSWR("ai-credit-catalog-models", loadChatModels, {
    revalidateOnFocus: false,
  });

  const { data: catalog } = useSWR("ai-credit-catalog", fetchPricingCatalog, {
    revalidateOnFocus: false,
  });

  return {
    models: data ?? chatModels,
    catalog: catalog ?? null,
    isLoading,
  };
}

export function groupModelsByProvider(models: ChatModel[]): Record<string, ChatModel[]> {
  return models.reduce(
    (acc, model) => {
      if (!acc[model.provider]) {
        acc[model.provider] = [];
      }
      acc[model.provider].push(model);
      return acc;
    },
    {} as Record<string, ChatModel[]>,
  );
}
