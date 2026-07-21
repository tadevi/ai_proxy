import { useState } from 'react';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Model, type Route } from '../api';
type Mapping = { alias: string; routes: Route[] };
export function Mappings() {
  const qc = useQueryClient();
  const mappings = useQuery({
    queryKey: ['mappings'],
    queryFn: () => api<Mapping[]>('/api/mappings'),
  });
  const models = useQuery({ queryKey: ['models'], queryFn: () => api<Model[]>('/api/models') });
  const save = useMutation({
    mutationFn: ({ alias, routes }: { alias: string; routes: Route[] }) =>
      api(`/api/mappings/${alias}`, {
        method: 'PUT',
        body: JSON.stringify({
          routes: routes.map((r) => ({ modelId: r.modelId, enabled: r.enabled })),
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mappings'] }),
  });
  function update(alias: string, routes: Route[]) {
    qc.setQueryData<Mapping[]>(['mappings'], (old) =>
      old?.map((m) => (m.alias === alias ? { ...m, routes } : m)),
    );
    save.mutate({ alias, routes });
  }
  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Mappings</h1>
        <p className="muted mt-1">
          Models are attempted from top to bottom. Changes save immediately.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        {mappings.data?.map((m) => (
          <MappingCard
            key={m.alias}
            mapping={m}
            models={models.data ?? []}
            update={(r) => update(m.alias, r)}
          />
        ))}
      </div>
    </>
  );
}
function MappingCard({
  mapping,
  models,
  update,
}: {
  mapping: Mapping;
  models: Model[];
  update: (r: Route[]) => void;
}) {
  const [choice, setChoice] = useState('');
  function drag(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const from = mapping.routes.findIndex((r) => r.modelId === e.active.id),
      to = mapping.routes.findIndex((r) => r.modelId === e.over!.id);
    update(arrayMove(mapping.routes, from, to));
  }
  function add() {
    const m = models.find((x) => x.id === choice);
    if (!m || mapping.routes.some((r) => r.modelId === m.id)) return;
    update([
      ...mapping.routes,
      {
        routeId: 'new-' + m.id,
        modelId: m.id,
        enabled: true,
        position: mapping.routes.length,
        displayName: m.displayName,
        gatewayModelId: m.gatewayModelId,
        latestTestStatus: m.latestTestStatus,
      },
    ]);
    setChoice('');
  }
  return (
    <section className="card">
      <h2 className="mb-1 text-lg font-semibold capitalize">{mapping.alias}</h2>
      <p className="muted mb-4">Priority fallback</p>
      <DndContext collisionDetection={closestCenter} onDragEnd={drag}>
        <SortableContext
          items={mapping.routes.map((r) => r.modelId)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-2">
            {mapping.routes.map((r, i) => (
              <SortableRoute
                key={r.modelId}
                route={r}
                index={i}
                toggle={() =>
                  update(
                    mapping.routes.map((x) =>
                      x.modelId === r.modelId ? { ...x, enabled: !x.enabled } : x,
                    ),
                  )
                }
                remove={() => update(mapping.routes.filter((x) => x.modelId !== r.modelId))}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <div className="mt-4 flex gap-2">
        <select
          aria-label={`Add model to ${mapping.alias}`}
          className="input min-w-0"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
        >
          <option value="">Add model…</option>
          {models
            .filter((m) => !mapping.routes.some((r) => r.modelId === m.id))
            .map((m) => (
              <option value={m.id} key={m.id}>
                {m.displayName}
              </option>
            ))}
        </select>
        <button className="btn" disabled={!choice} onClick={add}>
          Add
        </button>
      </div>
    </section>
  );
}
function SortableRoute({
  route,
  index,
  toggle,
  remove,
}: {
  route: Route;
  index: number;
  toggle: () => void;
  remove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: route.modelId,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-3"
    >
      <div className="flex items-center gap-2">
        <button
          aria-label="Drag to reorder"
          className="cursor-grab text-zinc-500"
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
        <span className="text-sm text-zinc-500">{index + 1}</span>
        <span className="min-w-0 flex-1 truncate text-sm">{route.displayName}</span>
        <button className="text-xs text-zinc-400" onClick={toggle}>
          {route.enabled ? 'On' : 'Off'}
        </button>
        <button aria-label="Remove" className="text-red-400" onClick={remove}>
          ×
        </button>
      </div>
      <p className="mt-1 truncate pl-10 font-mono text-xs text-zinc-500">{route.gatewayModelId}</p>
    </div>
  );
}
