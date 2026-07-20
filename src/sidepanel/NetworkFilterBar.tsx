import { useEffect, useMemo, useRef, useState } from "react";
import type { CapturedRequest, GraphQLOperation } from "../shared/messages";
import {
  bucketOf,
  isFilterActive,
  originOf,
  STATUS_BUCKET_LABELS,
  STATUS_BUCKET_ORDER,
  statusBucketOf,
  TYPE_BUCKET_LABELS,
  TYPE_BUCKET_ORDER,
  type FilterState,
  type StatusBucket,
  type TypeBucket,
} from "./networkFilter";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const GQL_OP_TYPES: GraphQLOperation["operationType"][] = ["query", "mutation", "subscription"];
const SEARCH_DEBOUNCE_MS = 150;

interface NetworkFilterBarProps {
  requests: CapturedRequest[]; // full, unfiltered set — for facet counts
  visibleCount: number;
  totalCount: number;
  filters: FilterState;
  onFiltersChange: (next: FilterState) => void;
  search: string;
  onSearchChange: (next: string) => void;
  onClearAll: () => void;
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export default function NetworkFilterBar({
  requests,
  visibleCount,
  totalCount,
  filters,
  onFiltersChange,
  search,
  onSearchChange,
  onClearAll,
}: NetworkFilterBarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchInput, setSearchInput] = useState(search);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<number | null>(null);

  // Debounced propagation (~150ms) so typing stays responsive with hundreds
  // of requests re-filtering on every keystroke.
  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => onSearchChange(searchInput), SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  // Stay in sync when search is cleared externally (Clear all / empty state).
  useEffect(() => {
    setSearchInput(search);
  }, [search]);

  // Ctrl/Cmd+F scoped to this panel — the browser's own page-find is useless
  // inside a side panel, so repurpose the shortcut for this search box.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const counts = useMemo(() => {
    const byType = new Map<TypeBucket, number>();
    const byMethod = new Map<string, number>();
    const byStatus = new Map<StatusBucket, number>();
    const byOrigin = new Map<string, number>();
    let hasGraphQL = false;
    for (const r of requests) {
      const t = bucketOf(r);
      byType.set(t, (byType.get(t) ?? 0) + 1);
      if (t === "graphql") hasGraphQL = true;
      byMethod.set(r.method, (byMethod.get(r.method) ?? 0) + 1);
      const s = statusBucketOf(r.status);
      byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
      const o = originOf(r.url);
      byOrigin.set(o, (byOrigin.get(o) ?? 0) + 1);
    }
    return { byType, byMethod, byStatus, byOrigin, hasGraphQL };
  }, [requests]);

  // Zero-count chips are hidden to keep the bar short — unless already active.
  const typeChips = TYPE_BUCKET_ORDER.filter(
    (t) => (counts.byType.get(t) ?? 0) > 0 || filters.types.includes(t),
  );
  const methodChips = METHODS.filter(
    (m) => (counts.byMethod.get(m) ?? 0) > 0 || filters.methods.includes(m),
  );
  const statusChips = STATUS_BUCKET_ORDER.filter(
    (s) => (counts.byStatus.get(s) ?? 0) > 0 || filters.statuses.includes(s),
  );
  const origins = [...counts.byOrigin.keys()].sort();

  const setTypes = (types: TypeBucket[]) => onFiltersChange({ ...filters, types });
  const setMethods = (methods: string[]) => onFiltersChange({ ...filters, methods });
  const setStatuses = (statuses: StatusBucket[]) => onFiltersChange({ ...filters, statuses });
  const setGqlOpTypes = (gqlOpTypes: GraphQLOperation["operationType"][]) =>
    onFiltersChange({ ...filters, gqlOpTypes });
  const setOrigins = (origins: string[]) => onFiltersChange({ ...filters, origins });

  const searching = search.trim() !== "";
  const active = isFilterActive(filters) || searching;

  const chipClass = (on: boolean) =>
    `shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
      on ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
    }`;

  return (
    <div className="border-b border-gray-200 bg-white p-2">
      <div className="flex items-center gap-1">
        <input
          ref={searchInputRef}
          className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-xs"
          placeholder="Search requests… (URL, operation, query, variables — Ctrl/Cmd+F)"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        {searchInput && (
          <button
            className="shrink-0 rounded bg-gray-200 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300"
            title="Clear search"
            onClick={() => setSearchInput("")}
          >
            ×
          </button>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <button className={chipClass(filters.types.length === 0)} onClick={() => setTypes([])}>
          All
        </button>
        {typeChips.map((t) => (
          <button
            key={t}
            className={chipClass(filters.types.includes(t))}
            onClick={() => setTypes(toggle(filters.types, t))}
          >
            {TYPE_BUCKET_LABELS[t]} <span className="opacity-70">{counts.byType.get(t) ?? 0}</span>
          </button>
        ))}
        <button
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700"
          onClick={() => setMoreOpen((v) => !v)}
        >
          {moreOpen ? "Fewer filters ▾" : "More filters ▸"}
        </button>
      </div>

      {moreOpen && (
        <div className="mt-1.5 space-y-1.5 rounded border border-gray-200 bg-gray-50 p-1.5">
          {methodChips.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="w-14 shrink-0 text-[11px] text-gray-500">Method</span>
              {methodChips.map((m) => (
                <button
                  key={m}
                  className={chipClass(filters.methods.includes(m))}
                  onClick={() => setMethods(toggle(filters.methods, m))}
                >
                  {m} <span className="opacity-70">{counts.byMethod.get(m) ?? 0}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1">
            <span className="w-14 shrink-0 text-[11px] text-gray-500">Status</span>
            {statusChips.map((s) => (
              <button
                key={s}
                className={chipClass(filters.statuses.includes(s))}
                onClick={() => setStatuses(toggle(filters.statuses, s))}
              >
                {STATUS_BUCKET_LABELS[s]} <span className="opacity-70">{counts.byStatus.get(s) ?? 0}</span>
              </button>
            ))}
          </div>
          {counts.hasGraphQL && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="w-14 shrink-0 text-[11px] text-gray-500">GraphQL</span>
              {GQL_OP_TYPES.map((t) => (
                <button
                  key={t}
                  className={chipClass(filters.gqlOpTypes.includes(t))}
                  onClick={() => setGqlOpTypes(toggle(filters.gqlOpTypes, t))}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          {origins.length > 1 && (
            <div className="flex flex-wrap items-start gap-1">
              <span className="w-14 shrink-0 pt-0.5 text-[11px] text-gray-500">Origin</span>
              <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                {origins.map((o) => (
                  <button
                    key={o}
                    className={chipClass(filters.origins.includes(o))}
                    title={o}
                    onClick={() => setOrigins(toggle(filters.origins, o))}
                  >
                    {o.replace(/^https?:\/\//, "")}{" "}
                    <span className="opacity-70">{counts.byOrigin.get(o) ?? 0}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-1.5 flex items-center justify-between text-[11px] text-gray-500">
        <span>
          {searching
            ? `${visibleCount} result${visibleCount === 1 ? "" : "s"}`
            : `Showing ${visibleCount} of ${totalCount} requests`}
        </span>
        {active && (
          <button className="font-medium text-blue-700 hover:underline" onClick={onClearAll}>
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
