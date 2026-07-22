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
import { ChevronDown, GripVertical, Plus, X } from 'lucide-react';
import { api, type Mapping, type MappingRoute, type ModelBinding } from '../api';

export function Mappings() {
  const qc = useQueryClient();
  const mappings = useQuery({
    queryKey: ['mappings'],
    queryFn: () => api<Mapping[]>('/api/mappings'),
  });
  const bindings = useQuery({
    queryKey: ['bindings'],
    queryFn: () => api<ModelBinding[]>('/api/bindings'),
  });
  const save = useMutation({
    mutationFn: ({ alias, routes }: { alias: string; routes: MappingRoute[] }) =>
      api(`/api/mappings/${alias}`, {
        method: 'PUT',
        body: JSON.stringify({
          routes: routes.map((r) => ({ bindingId: r.bindingId, enabled: r.enabled })),
        }),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['mappings'] }),
  });
  function update(alias: string, routes: MappingRoute[]) {
    qc.setQueryData<Mapping[]>(['mappings'], (old) =>
      old?.map((m) => (m.alias === alias ? { ...m, routes } : m)),
    );
    save.mutate({ alias, routes });
  }
  return (
    <div>
      <div className="mb-7">
        <h1 className="text-2xl font-bold tracking-tight">Mappings</h1>
        <p className="mt-1.5 max-w-2xl text-[14.5px] text-zinc-400">
          Bindings are attempted from top to bottom; the gateway picks which token to use
          within each. Changes save immediately.
        </p>
        {save.error && <p className="mt-2 text-sm text-red-400">Could not save: {save.error.message}</p>}
      </div>
      <div className="flex flex-wrap gap-5">
        {mappings.data?.map((m) => (
          <Column
            key={m.alias}
            mapping={m}
            bindings={bindings.data ?? []}
            update={(r) => update(m.alias, r)}
          />
        ))}
      </div>
    </div>
  );
}

function Column({
  mapping,
  bindings,
  update,
}: {
  mapping: Mapping;
  bindings: ModelBinding[];
  update: (r: MappingRoute[]) => void;
}) {
  const [choice, setChoice] = useState('');

  function drag(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const from = mapping.routes.findIndex((r) => r.bindingId === e.active.id),
      to = mapping.routes.findIndex((r) => r.bindingId === e.over!.id);
    update(arrayMove(mapping.routes, from, to));
  }
  function add() {
    const b = bindings.find((x) => x.id === choice);
    if (!b || mapping.routes.some((r) => r.bindingId === b.id)) return;
    update([
      ...mapping.routes,
      {
        routeId: 'new-' + b.id,
        bindingId: b.id,
        enabled: true,
        position: mapping.routes.length,
        presetDisplayName: b.presetDisplayName,
        presetUpstreamModelId: b.presetUpstreamModelId,
        providerConnectionName: b.connectionName ?? '',
        apiFormat: b.apiFormat,
      },
    ]);
    setChoice('');
  }

  return (
    <div className="flex min-w-[280px] flex-1 flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60 px-5 pt-[22px] pb-5">
      <div className="mb-[22px]">
        <h2 className="m-0 text-[19px] font-semibold tracking-tight text-zinc-100 capitalize">
          {mapping.alias}
        </h2>
        <span className="mt-1 block font-mono text-[11px] tracking-[0.08em] text-zinc-500 uppercase">
          Priority fallback chain
        </span>
      </div>

      <div className="relative flex-1">
        {/* rail */}
        <div
          className="absolute top-3 left-[11px] w-0.5 bg-gradient-to-b from-emerald-500 to-zinc-800"
          style={{ bottom: mapping.routes.length ? 44 : 12 }}
        />

        <DndContext collisionDetection={closestCenter} onDragEnd={drag}>
          <SortableContext
            items={mapping.routes.map((r) => r.bindingId)}
            strategy={verticalListSortingStrategy}
          >
            {mapping.routes.map((r, i) => (
              <SortableRoute
                key={r.bindingId}
                route={r}
                index={i}
                toggle={() =>
                  update(
                    mapping.routes.map((x) =>
                      x.bindingId === r.bindingId ? { ...x, enabled: !x.enabled } : x,
                    ),
                  )
                }
                remove={() => update(mapping.routes.filter((x) => x.bindingId !== r.bindingId))}
              />
            ))}
          </SortableContext>
        </DndContext>

        {/* add binding node */}
        <div className="relative flex gap-3.5">
          <div className="z-[1] flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-zinc-700 bg-zinc-900/60 text-zinc-600">
            <Plus size={12} />
          </div>
          <div className="flex flex-1 gap-2">
            <div className="relative flex-1">
              <select
                aria-label={`Add binding to ${mapping.alias}`}
                className="w-full appearance-none rounded-[10px] border border-dashed border-zinc-700 bg-zinc-900/40 py-2.5 pr-9 pl-3 text-[13.5px] text-zinc-500 outline-none focus:border-indigo-500"
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
              >
                <option value="">Add binding…</option>
                {bindings
                  .filter((b) => !mapping.routes.some((r) => r.bindingId === b.id))
                  .map((b) => (
                    <option value={b.id} key={b.id}>
                      {b.presetDisplayName} · {b.connectionName}
                    </option>
                  ))}
              </select>
              <ChevronDown
                size={15}
                className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-zinc-600"
              />
            </div>
            <button
              className="rounded-[10px] border border-zinc-700 bg-zinc-800/80 px-4 text-[13.5px] font-semibold text-zinc-400 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!choice}
              onClick={add}
            >
              Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SortableRoute({
  route,
  index,
  toggle,
  remove,
}: {
  route: MappingRoute;
  index: number;
  toggle: () => void;
  remove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: route.bindingId,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="relative mb-3.5 flex min-w-0 gap-3.5"
    >
      {/* node */}
      <div
        className={`relative z-[1] flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 font-mono text-[11px] font-bold ${
          route.enabled ? 'border-emerald-500 text-emerald-300' : 'border-zinc-600 text-zinc-500'
        } bg-zinc-900`}
      >
        {index + 1}
      </div>

      {/* card */}
      <div
        className={`min-w-0 flex-1 rounded-[10px] border border-zinc-800 bg-zinc-950 px-3.5 py-3 ${!route.enabled ? 'opacity-70' : ''}`}
      >
        <div className="flex items-start justify-between gap-2.5">
          <div className="flex min-w-0 gap-2">
            <button
              aria-label="Drag to reorder"
              className="mt-0.5 shrink-0 cursor-grab text-zinc-600 hover:text-zinc-400"
              {...attributes}
              {...listeners}
            >
              <GripVertical size={15} />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14.5px] font-semibold text-zinc-100">
                  {route.presetDisplayName}
                </span>
              </div>
              <div className="mt-0.5 truncate font-mono text-xs text-zinc-500">
                {route.providerConnectionName} · {route.presetUpstreamModelId} ·{' '}
                {route.apiFormat === 'anthropic_compatible' ? 'Anthropic' : 'OpenAI'}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2.5">
            <button
              aria-checked={route.enabled}
              aria-label={`${route.enabled ? 'Disable' : 'Enable'} ${route.presetDisplayName}`}
              className={`relative h-5 w-9 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${route.enabled ? 'bg-emerald-500/80' : 'bg-zinc-700'}`}
              onClick={toggle}
              role="switch"
              title={route.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
              type="button"
            >
              <span
                className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-zinc-100 shadow-sm transition-transform ${route.enabled ? 'translate-x-4' : 'translate-x-0'}`}
              />
            </button>
            <button
              aria-label={`Remove ${route.presetDisplayName} from this mapping`}
              className="flex text-zinc-600 hover:text-red-300"
              onClick={remove}
              title="Remove from mapping"
              type="button"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
