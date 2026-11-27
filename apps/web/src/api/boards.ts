import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type {
  Board,
  BoardCreateTicketInput,
  BoardInput,
  BoardMoveInput,
  BoardPatch,
  BoardPrefs,
  BoardSummary,
  BoardView,
  BoardZoneInput,
  Ticket,
} from "@yourtask/contracts";
import { api } from "./client";

/** Доски (R-2.18, R-2.19; docs/adr/0022). */
export const boardKeys = {
  all: ["boards"] as const,
  list: ["boards", "list"] as const,
  one: (id: string) => ["boards", "one", id] as const,
};

export type LoadedBoard = BoardView & { overflow: number };

export function useBoards() {
  return useQuery({
    queryKey: boardKeys.list,
    queryFn: ({ signal }) => api<{ items: BoardSummary[] }>("/api/v1/boards", { signal }),
  });
}

/** q — уточнение фильтра из адреса: часть состояния доски, как чипы и дорожки (R-2.18). */
export function useBoard(id: string, q = "") {
  return useQuery({
    queryKey: [...boardKeys.one(id), q],
    queryFn: ({ signal }) =>
      api<LoadedBoard>(`/api/v1/boards/${encodeURIComponent(id)}${q ? `?q=${encodeURIComponent(q)}` : ""}`, { signal }),
    enabled: Boolean(id),
  });
}

export function useCreateBoard() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: BoardInput) => api<Board>("/api/v1/boards", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => client.invalidateQueries({ queryKey: boardKeys.all }),
  });
}

export function useUpdateBoard(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: BoardPatch) =>
      api<Board>(`/api/v1/boards/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => client.invalidateQueries({ queryKey: boardKeys.all }),
  });
}

export function useDeleteBoard(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>(`/api/v1/boards/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: boardKeys.list }),
  });
}

export function useSetZones(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (zones: BoardZoneInput[]) =>
      api<Board>(`/api/v1/boards/${encodeURIComponent(id)}/zones`, { method: "PUT", body: JSON.stringify({ zones }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: boardKeys.one(id) }),
  });
}

/** Личные настройки: сохраняются молча, доска меняется сразу (у других — нет). */
export function useSavePrefs(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (prefs: BoardPrefs) =>
      api<BoardPrefs>(`/api/v1/boards/${encodeURIComponent(id)}/prefs`, {
        method: "PUT",
        body: JSON.stringify(prefs),
      }),
    onMutate: (prefs) => {
      client.setQueriesData<LoadedBoard>({ queryKey: boardKeys.one(id) }, (old) => (old ? { ...old, prefs } : old));
    },
  });
}

/** Перенос карточки: сразу на месте (оптимистично), затем ответ сервера; ошибка — откат и причина. */
export function useMoveCard(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: BoardMoveInput & { statusName?: string }) => {
      const { statusName, ...body } = input;
      void statusName;
      return api<{ ticket: Ticket }>(`/api/v1/boards/${encodeURIComponent(id)}/move`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: boardKeys.one(id) });
      const before = client.getQueriesData<LoadedBoard>({ queryKey: boardKeys.one(id) });
      if (input.statusId) {
        const ranks = new Map((input.order ?? []).map((key, index) => [key, (index + 1) * 1024]));
        client.setQueriesData<LoadedBoard>(
          { queryKey: boardKeys.one(id) },
          (old) =>
            old && {
              ...old,
              cards: old.cards.map((card) => {
                const rank = ranks.get(card.key) ?? card.rank;
                if (card.key !== input.key) return { ...card, rank };
                const status = old.schemes[card.scheme]?.find((item) => item.id === input.statusId);
                return status
                  ? {
                      ...card,
                      rank,
                      statusId: status.id,
                      statusName: status.name,
                      category: status.category,
                      waiting: status.waiting,
                    }
                  : { ...card, rank };
              }),
            },
        );
      }
      return { before };
    },
    onError: (_error, _input, context) => {
      for (const [key, value] of context?.before ?? []) client.setQueryData(key, value);
    },
    onSettled: () => client.invalidateQueries({ queryKey: boardKeys.one(id) }),
  });
}

export function useReorder(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (order: string[]) =>
      api<void>(`/api/v1/boards/${encodeURIComponent(id)}/order`, { method: "POST", body: JSON.stringify({ order }) }),
    onMutate: (order) => {
      const ranks = new Map(order.map((key, index) => [key, (index + 1) * 1024]));
      client.setQueriesData<LoadedBoard>({ queryKey: boardKeys.one(id) }, (old) =>
        old ? { ...old, cards: old.cards.map((card) => ({ ...card, rank: ranks.get(card.key) ?? card.rank })) } : old,
      );
    },
    onSettled: () => client.invalidateQueries({ queryKey: boardKeys.one(id) }),
  });
}

export function useCreateOnBoard(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: BoardCreateTicketInput) =>
      api<{ ticket: Ticket; onBoard: boolean }>(`/api/v1/boards/${encodeURIComponent(id)}/tickets`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: boardKeys.one(id) }),
  });
}

/**
 * Живые изменения (R-2.18, R-3.3): сервер шлёт «тикеты поменялись», открытые доски перечитываются.
 * Несколько событий подряд — одно перечитывание. EventSource сам переподключается.
 */
export function useLiveTickets() {
  const client = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/api/v1/events");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void client.invalidateQueries({ queryKey: boardKeys.all, refetchType: "active" }), 250);
    };
    source.addEventListener("tickets", onChange);
    // Колокольчик (YT-18): сигнал только своему получателю; список перечитывается через API с правами.
    const onNotify = () => void client.invalidateQueries({ queryKey: ["notifications"] });
    source.addEventListener("notifications", onNotify);
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [client]);
}
